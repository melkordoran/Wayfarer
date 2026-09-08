import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Eye, Layers, LocateFixed, Paintbrush, Redo2, Undo2, X } from 'lucide-react';
import { TERRAIN_EDIT_LIMITS, type TerrainCellSample, type TerrainEditRow, type TerrainRegion } from '../../shared/terrain-edit';
import { planTerrainEdit, sameTerrainRow, TerrainHistory, type TerrainChange, type TerrainOperation } from '../terrain-editing';
import './terrain-editor.css';

export function TerrainEditor({ open, scope, anchor, revision, previewVisible, canEdit, disabledReason, studio, offset, history, sample, onAnchor, onRegion, onPreview, onCancelPreview, onApply, onBusy, onDirty, onKeys, onHere, onClose }: {
  open: boolean; scope: string; anchor: { cellX: number; cellZ: number } | null; revision: number; previewVisible: boolean;
  canEdit: boolean; disabledReason: string; studio: boolean; offset: number; history: TerrainHistory;
  sample: (region: TerrainRegion) => TerrainCellSample[];
  onAnchor: (anchor: { cellX: number; cellZ: number }) => void;
  onRegion: (region: TerrainRegion | null) => void;
  onPreview: (rows: TerrainEditRow[]) => boolean; onCancelPreview: () => void;
  onApply: (change: TerrainChange, scope: string) => Promise<TerrainEditRow>;
  onBusy: (busy: boolean) => void; onDirty: (dirty: boolean) => void;
  onKeys: (handler: (event: KeyboardEvent) => boolean) => void;
  onHere: () => void; onClose: () => void;
}) {
  const [size, setSize] = useState(1), [operation, setOperation] = useState<TerrainOperation>('raise');
  const [coordinateText, setCoordinateText] = useState({ x: anchor ? String(anchor.cellX) : '', z: anchor ? String(anchor.cellZ) : '' });
  useEffect(() => setCoordinateText({ x: anchor ? String(anchor.cellX) : '', z: anchor ? String(anchor.cellZ) : '' }), [anchor]);
  const [amount, setAmount] = useState('0.5'), [texture, setTexture] = useState('0'), [rotation, setRotation] = useState(0), [hole, setHole] = useState(false);
  const [draft, setDraft] = useState<{ scope: string; label: string; changes: TerrainChange[] } | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failed, setFailed] = useState(false), [, redraw] = useState(0);
  const current = useRef({ scope, canEdit, onApply, onBusy, onCancelPreview }); current.current = { scope, canEdit, onApply, onBusy, onCancelPreview };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; current.current.onCancelPreview(); }; }, []);
  const region = useMemo<TerrainRegion | null>(() => anchor ? { ...anchor, width: size, depth: size } : null, [anchor, size]);
  const samples = useMemo(() => region ? sample(region) : [], [region, revision, sample, scope]);
  const coordinatesValid = [coordinateText.x, coordinateText.z].every(value => /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Math.abs(Number(value)) <= TERRAIN_EDIT_LIMITS.maxCellCoordinate);
  const loaded = coordinatesValid && !!region && samples.length === size * size && samples.every(cell => cell.height !== null && cell.texture !== null);
  const conflict = !!draft && (draft.scope !== scope || draft.changes.some(change => {
    const cells = sample({ cellX: change.before.cellX, cellZ: change.before.cellZ, width: change.before.heights.length, depth: 1 });
    return cells.length !== change.before.heights.length || cells.some(cell => cell.height === null || cell.texture === null)
      || !sameTerrainRow(change.before, { cellX: change.before.cellX, cellZ: change.before.cellZ, heights: cells.map(cell => cell.height!), textures: cells.map(cell => cell.texture!) });
  }));
  useEffect(() => { if (open) onRegion(region); else onRegion(null); }, [open, region, onRegion]);
  useEffect(() => { onDirty(!!draft); return () => onDirty(false); }, [draft, onDirty]);
  useEffect(() => { if (conflict || !canEdit || !open) onCancelPreview(); }, [conflict, canEdit, open, onCancelPreview]);
  useEffect(() => {
    if (!draft && !busy) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [draft, busy]);
  function discard() { if (busy) return; onCancelPreview(); setDraft(null); setMessage('Preview discarded. No additional terrain was changed.'); setFailed(false); }
  function coordinate(axis: 'x' | 'z', value: string) {
    if (busy || draft) return;
    const next = { ...coordinateText, [axis]: value }; setCoordinateText(next);
    if ([next.x, next.z].every(text => /^[+-]?\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Math.abs(Number(text)) <= TERRAIN_EDIT_LIMITS.maxCellCoordinate)) onAnchor({ cellX: Number(next.x), cellZ: Number(next.z) });
  }
  function preview() {
    if (!canEdit || !loaded || busy || draft) return;
    try {
      if (operation !== 'paint' && amount.trim() === '') throw new Error('Enter a height in metres.');
      if (operation === 'paint' && !hole && (texture.trim() === '' || !Number.isInteger(Number(texture)) || Number(texture) < 0 || Number(texture) > 63)) throw new Error('Texture number must be an integer from 0 to 63.');
      const material = operation !== 'paint' ? 0 : hole ? 254 : Number(texture) + rotation * 64;
      if (operation === 'paint' && !hole && material === 254) throw new Error('Texture 62 at 270° is reserved for terrain holes. Choose another rotation or explicitly select Make a terrain hole.');
      const changes = planTerrainEdit(samples, operation, Number(amount), material);
      if (!changes.length) { setMessage('The selected terrain already has those values.'); setFailed(false); return; }
      if (!onPreview(changes.map(change => change.after))) throw new Error('Terrain changed or is not fully loaded. Select it again before previewing.');
      setDraft({ scope, label: `${operation[0].toUpperCase()}${operation.slice(1)} terrain`, changes }); setMessage('Local preview only. Apply to save; Discard leaves terrain unchanged.'); setFailed(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The preview could not be created.'); setFailed(true); }
  }
  async function run(direction: 'edit' | 'undo' | 'redo') {
    if (busy || history.busy || !canEdit || (direction === 'edit' ? !draft || conflict || !previewVisible : !!draft)) return;
    const capturedScope = scope, captured = draft;
    onCancelPreview(); setBusy(true); onBusy(true); setFailed(false); setMessage('Waiting for canonical terrain…');
    try {
      const result = await history.run(captured?.label ?? '', captured?.changes ?? [], async change => {
        if (current.current.scope !== capturedScope || !current.current.canEdit) throw new Error('The terrain edit belongs to an earlier world entry or its permission changed.');
        return current.current.onApply(change, capturedScope);
      }, direction);
      if (!mounted.current) return;
      if (result.superseded || capturedScope !== current.current.scope) { setMessage('The world entry changed. No remaining terrain rows were sent.'); setFailed(true); return; }
      redraw(value => value + 1);
      if (result.error) { setMessage(`${result.completed} of ${result.total} cells verified. ${result.error}${result.completed ? ' Discard the remaining preview to undo the verified portion.' : ''}`); setFailed(true); }
      else { setDraft(null); setMessage(result.total ? `${result.completed} ${result.completed === 1 ? 'cell' : 'cells'} ${studio ? 'saved locally' : 'verified from the server'}.` : 'Nothing to undo or redo.'); }
    } catch (error) { if (mounted.current) { setMessage(error instanceof Error ? error.message : 'Terrain edit failed.'); setFailed(true); } }
    finally { if (mounted.current) setBusy(false); current.current.onBusy(false); }
  }
  const keys = useRef<(event: KeyboardEvent) => boolean>(() => false);
  keys.current = event => {
    if (!open || event.altKey) return false;
    if (event.key === 'Escape' && draft && !busy) { event.preventDefault(); discard(); return true; }
    if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); void run(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo'); return true; }
    return false;
  };
  useEffect(() => { onKeys(event => keys.current(event)); return () => onKeys(() => false); }, [onKeys]);
  if (!open) return null;
  const heights = samples.flatMap(cell => cell.height === null ? [] : [cell.height]);
  const locked = busy || !!draft;
  return <aside className="inspector terrain-editor" aria-label="Terrain editor">
    <div className="panel-heading"><span><Layers size={16} />Terrain editor</span><button className="icon-button" aria-label="Close terrain editor" onClick={onClose} disabled={busy}><X size={16} /></button></div>
    <div className="terrain-editor-body">
      <p className="terrain-intro">Shape the ground beneath your world. Click terrain to select a cell, then preview your changes.</p>
      {!canEdit && <p className="edit-conflict" role="status">{disabledReason}</p>}
      <div className="terrain-selection-heading"><strong>Selection</strong><button className="subtle-button" onClick={onHere} disabled={locked}><LocateFixed size={14} />At my feet</button></div>
      <div className="terrain-fields"><label>Cell X · west<input aria-label="Terrain cell X" inputMode="numeric" value={coordinateText.x} disabled={locked} onChange={event => coordinate('x', event.target.value)} /></label><label>Cell Z · north<input aria-label="Terrain cell Z" inputMode="numeric" value={coordinateText.z} disabled={locked} onChange={event => coordinate('z', event.target.value)} /></label></div>
      <label className="terrain-field">Selection size<select aria-label="Terrain selection size" value={size} disabled={locked} onChange={event => setSize(Number(event.target.value))}>{[1, 2, 4, 8].map(value => <option value={value} key={value}>{value} × {value} cells · {value * 10} × {value * 10} m</option>)}</select></label>
      <div className="terrain-readout" role="status">{!anchor ? 'Select terrain in the world.' : !coordinatesValid ? 'Enter whole cell coordinates within the world bounds.' : !loaded ? 'Waiting for complete terrain data here.' : <><strong>{size * size} {size === 1 ? 'cell' : 'cells'} selected</strong><span>Raw height {Math.min(...heights).toFixed(2)}{Math.min(...heights) !== Math.max(...heights) ? ` to ${Math.max(...heights).toFixed(2)}` : ''} m</span><span>World elevation includes {offset.toFixed(2)} m offset.</span></>}</div>
      <div className="terrain-operations" role="group" aria-label="Terrain operation">{([['raise', ArrowUp, 'Raise'], ['lower', ArrowDown, 'Lower'], ['flatten', Layers, 'Set height'], ['paint', Paintbrush, 'Texture']] as const).map(([value, Icon, label]) => <button key={value} aria-pressed={operation === value} disabled={locked} onClick={() => setOperation(value)}><Icon size={15} />{label}</button>)}</div>
      {operation !== 'paint' ? <label className="terrain-field">{operation === 'flatten' ? 'Raw height · metres' : 'Height step · metres'}<input aria-label={operation === 'flatten' ? 'Terrain target height' : 'Terrain height step'} type="number" step="0.01" value={amount} disabled={locked} onChange={event => setAmount(event.target.value)} /></label> : <><div className="terrain-fields"><label>Texture · 0–63<input aria-label="Terrain texture number" type="number" min="0" max="63" step="1" value={texture} disabled={locked || hole} onChange={event => setTexture(event.target.value)} /></label><label>Rotation<select aria-label="Terrain texture rotation" value={rotation} disabled={locked || hole} onChange={event => setRotation(Number(event.target.value))}>{[0, 1, 2, 3].map(value => <option key={value} value={value}>{value * 90}°</option>)}</select></label></div><label className="terrain-hole"><input type="checkbox" checked={hole} disabled={locked} onChange={event => setHole(event.target.checked)} />Make a terrain hole</label><p className="terrain-help">{studio ? 'Original studio colors: 0 Grass · 1 Sand · 2 Stone · 3 Soil. Other indices use a plain fallback; no images are downloaded.' : 'Uses the world’s terrain0–terrain63 textures. Missing textures keep a visible fallback; texture names are not a server directory listing.'}</p></>}
      {draft && conflict && <p className="edit-conflict" role="alert">{draft.scope !== scope ? 'This preview belongs to an earlier world entry. Its values remain below, but it cannot be applied here.' : 'Terrain changed or unloaded after this preview. Discard it, then preview current terrain before applying.'}</p>}
      {draft && !previewVisible && !conflict && !busy && <div className="edit-conflict" role="status">The preview is not currently visible. Restore it before applying.<button className="secondary-button full-width" disabled={!canEdit} onClick={() => { if (draft.scope === scope && !conflict && onPreview(draft.changes.map(change => change.after))) { setMessage('Local preview restored. Apply to save or Discard to cancel.'); setFailed(false); } }}>Restore preview</button></div>}
      <div className="terrain-actions">{draft ? <><button className="secondary-button" disabled={busy} onClick={discard}>Discard preview</button><button className="primary-button" disabled={busy || !canEdit || conflict || !previewVisible} onClick={() => void run('edit')}><Check size={15} />{busy ? 'Applying…' : 'Apply terrain'}</button></> : <button className="primary-button full-width" disabled={!canEdit || !loaded || busy} onClick={preview}><Eye size={15} />Preview terrain</button>}</div>
      {message && <p className={failed ? 'edit-conflict' : 'terrain-help'} role={failed ? 'alert' : 'status'}>{message}</p>}
      <div className="terrain-history"><button className="secondary-button" aria-label="Undo terrain" disabled={!canEdit || busy || !!draft || !history.undoLabel} onClick={() => void run('undo')}><Undo2 size={14} />Undo</button><button className="secondary-button" aria-label="Redo terrain" disabled={!canEdit || busy || !!draft || !history.redoLabel} onClick={() => void run('redo')}><Redo2 size={14} />Redo</button></div>
      {draft && <details className="terrain-draft"><summary>Copyable preview values</summary><textarea aria-label="Terrain preview values" readOnly value={JSON.stringify(draft.changes.map(change => change.after), null, 2)} /></details>}
      <p className="terrain-help">{studio ? 'Edits save in this local studio project. Terrain extends 640 m from the origin on each axis.' : 'Rows are verified individually. Other builders can change terrain concurrently; a patch is not an atomic server transaction.'} Undo is scoped to this world entry and retains up to 32 edits.</p>
    </div>
  </aside>;
}
