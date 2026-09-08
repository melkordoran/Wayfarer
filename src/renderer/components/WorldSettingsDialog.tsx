import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Save, Settings2 } from 'lucide-react';
import type { WorldSettings } from '../../shared/types';
import {
  WORLD_SETTING_FIELDS, validateWorldSettingsChanges, worldSettingChanges, worldSettingDraftValue,
  type WorldSettingChange, type WorldSettingField, type WorldSettingsResult, type WorldSettingsSetCommand,
} from '../../shared/world-settings-edit';
import { Modal } from './Modal';
import { displayObjectPath } from './WorldDetailsDialog';
import './world-settings.css';

type Raw = Readonly<Record<number, string>>;
type Edit = { value: string; baseline: Raw };
export type WorldSettingsCloseGuard = (proceed: () => void) => void;
const groups = [...new Set(WORLD_SETTING_FIELDS.map(field => field.group))];
const rawMap = (raw: Raw) => new Map(Object.entries(raw).map(([id, value]) => [Number(id), value]));
const baselineFor = (field: WorldSettingField, raw: Raw): Raw => Object.fromEntries(field.ids.filter(id => Object.hasOwn(raw, id)).map(id => [id, raw[id]]));
const sameBaseline = (field: WorldSettingField, before: Raw, current: Raw) => field.ids.every(id => (before[id] ?? null) === (current[id] ?? null));

export function WorldSettingsDialog({ settings, online, studio, session, invalidationEpoch = 0, onApply, onClose, onGuardChange, onDirtyChange }: {
  settings: WorldSettings | null; online: boolean; studio: boolean; session: number; invalidationEpoch?: number;
  onApply: (command: WorldSettingsSetCommand) => Promise<WorldSettingsResult>;
  onClose: () => void; onGuardChange?: (guard: WorldSettingsCloseGuard | null) => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const origin = useRef({ world: settings?.name ?? '', session, entryId: settings?.editContext?.entryId, epoch: invalidationEpoch });
  const latest = useRef({ settings, online, studio, session, invalidationEpoch });
  latest.current = { settings, online, studio, session, invalidationEpoch };
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [group, setGroup] = useState(groups[0]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [observed, setObserved] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false), alive = useRef(true);
  const [invalidated, setInvalidated] = useState('');
  const invalidatedRef = useRef('');
  const [closeConfirmation, setCloseConfirmation] = useState<{ proceed: () => void } | null>(null);
  const [clearPath, setClearPath] = useState(false);
  const [focusField, setFocusField] = useState<string | null>(null);
  const inputRefs = useRef(new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>());
  const raw = settings?.rawAttributes ?? {};
  const dirty = Object.keys(edits).length > 0;
  const conflicts = useMemo(() => WORLD_SETTING_FIELDS.filter(field => edits[field.key] && !sameBaseline(field, edits[field.key].baseline, raw)), [edits, raw]);
  function unavailable(): string {
    const current = latest.current;
    if (current.studio || !current.online) return 'The world connection changed. Your draft is preserved, but cannot be applied. Re-enter the world and open a new editor.';
    if (current.settings?.caretaker !== true) return 'Caretaker permission is no longer available. Your draft is preserved, but cannot be applied.';
    if (!origin.current.entryId || origin.current.entryId !== current.settings?.editContext?.entryId || origin.current.session !== current.session || origin.current.world !== current.settings?.name || origin.current.epoch !== current.invalidationEpoch)
      return 'This draft belongs to an earlier world entry. Close it and open a new editor for the current world.';
    if (current.settings.editContext.blocked) return 'A previous update has an uncertain or conflicting outcome. Re-enter the world before editing again.';
    return '';
  }
  const disabledReason = invalidated || unavailable();
  useEffect(() => {
    const reason = unavailable();
    if (reason) { invalidatedRef.current ||= reason; setInvalidated(invalidatedRef.current); }
  }, [online, studio, session, settings?.name, settings?.caretaker, settings?.editContext?.entryId, settings?.editContext?.blocked, invalidationEpoch]);
  useEffect(() => { if (focusField) { inputRefs.current.get(focusField)?.focus(); setFocusField(null); } }, [group, focusField]);
  const guardRef = useRef<WorldSettingsCloseGuard>(() => {});
  guardRef.current = proceed => {
    if (busyRef.current) { setMessage('Wait for the current update to finish. Its outcome has not been confirmed yet.'); return; }
    if (dirty) setCloseConfirmation({ proceed });
    else proceed();
  };
  useEffect(() => {
    onGuardChange?.(proceed => guardRef.current(proceed));
    return () => onGuardChange?.(null);
  }, [onGuardChange]);
  useEffect(() => { onDirtyChange?.(dirty || busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (busyRef.current || Object.keys(editRef.current).length) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { alive.current = false; window.removeEventListener('beforeunload', beforeUnload); onDirtyChange?.(false); };
  }, [onDirtyChange]);
  const editRef = useRef(edits); editRef.current = edits;

  function update(field: WorldSettingField, value: string, forceClear = false) {
    if (busyRef.current || disabledReason) return;
    setEdits(previous => {
      const next = { ...previous }, baseline = previous[field.key]?.baseline ?? baselineFor(field, raw);
      if (!forceClear && value === worldSettingDraftValue(field, baseline)) delete next[field.key];
      else next[field.key] = { value, baseline };
      return next;
    });
    setErrors(previous => { const next = { ...previous }; delete next[field.key]; return next; });
    setMessage(''); setObserved(false);
  }
  function review(field: WorldSettingField, keepDraft: boolean) {
    setEdits(previous => {
      const next = { ...previous };
      if (keepDraft) next[field.key] = { ...next[field.key], baseline: baselineFor(field, raw) };
      else delete next[field.key];
      return next;
    });
    setMessage(''); setObserved(false);
  }
  function discard() { if (busyRef.current) return; setEdits({}); setErrors({}); setMessage('Draft discarded. No additional changes were sent.'); setObserved(false); setClearPath(false); }
  async function apply() {
    if (busyRef.current || invalidatedRef.current || unavailable() || conflicts.length || !dirty) return;
    const nextErrors: Record<string, string> = {}, changes: WorldSettingChange[] = [];
    for (const field of WORLD_SETTING_FIELDS) {
      const edit = edits[field.key]; if (!edit) continue;
      try { changes.push(...worldSettingChanges(field, edit.value, edit.baseline)); }
      catch (error) { nextErrors[field.key] = error instanceof Error ? error.message : `Check ${field.label}.`; }
    }
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors); const first = WORLD_SETTING_FIELDS.find(field => nextErrors[field.key])!;
      setGroup(first.group); setFocusField(first.key); setMessage('Check the highlighted fields before applying.'); return;
    }
    try { validateWorldSettingsChanges(changes, rawMap(raw)); }
    catch (error) {
      const issue = error instanceof Error ? error.message : 'The edited settings are not valid together.';
      setMessage(issue);
      if (changes.some(change => change.id === 0x34 || change.id === 0x35)) { setErrors({ fogMax: issue }); setGroup('Fog'); setFocusField('fogMax'); }
      return;
    }
    if (!changes.length) { setEdits({}); setMessage('No server attributes would change.'); return; }
    const current = latest.current.settings!;
    const command: WorldSettingsSetCommand = { type: 'world-settings-set', requestId: crypto.randomUUID(), world: origin.current.world, session: origin.current.session, entryId: origin.current.entryId!, revision: current.editContext!.revision, changes };
    busyRef.current = true; setBusy(true); setErrors({}); setObserved(false); setMessage('Sending changes and waiting for a world-attribute broadcast…');
    try {
      const result = await onApply(command);
      if (!alive.current) return;
      if (result.status === 'observed' && !invalidatedRef.current && !unavailable()) {
        setEdits({}); setObserved(true); setMessage('Updated values were observed in a world broadcast. Axis does not provide a durable-save acknowledgement.');
      } else {
        const reason = unavailable() || (result.status === 'conflict' ? 'The server broadcast conflicts with this update. Inspect the current world and re-enter before editing again; your draft is preserved.' : 'The update outcome is uncertain. It may have reached the server. Re-enter the world before editing again; no automatic retry was sent.');
        invalidatedRef.current ||= reason; setInvalidated(invalidatedRef.current); setMessage('');
      }
    } catch {
      if (!alive.current) return;
      const reason = 'The update could not be confirmed. Your draft is preserved. Inspect the world and re-enter before editing again; no automatic retry was sent.';
      invalidatedRef.current ||= reason; setInvalidated(invalidatedRef.current); setMessage('');
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  function close() {
    if (closeConfirmation) { setCloseConfirmation(null); return; }
    // Standalone dialogs still receive the same protection without an App guard.
    if (onGuardChange) onClose(); else guardRef.current(onClose);
  }
  const currentValue = (field: WorldSettingField) => field.kind === 'object-path' ? displayObjectPath(raw[field.ids[0]] ?? '') : worldSettingDraftValue(field, raw) || 'Not provided or unsupported';
  return <Modal title="World settings" subtitle={`${origin.current.world} · caretaker editor · changes affect everyone in this world`} onClose={close} wide>
    <div className="world-settings-intro"><Settings2 size={19} /><span>Draft changes stay here until you apply them. There is no local preview and no automatic retry.</span></div>
    {disabledReason && <p className="world-settings-alert" role="alert"><AlertTriangle size={17} />{disabledReason}</p>}
    <div className="world-settings-tabs" role="tablist" aria-label="World settings sections">
      {groups.map((name, index) => <button key={name} type="button" role="tab" id={`world-settings-tab-${index}`} tabIndex={group === name ? 0 : -1} aria-selected={group === name} aria-controls={`world-settings-panel-${index}`} onClick={() => setGroup(name)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % groups.length : event.key === 'ArrowLeft' ? (index + groups.length - 1) % groups.length : event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : null;
        if (next === null) return; event.preventDefault(); setGroup(groups[next]); document.getElementById(`world-settings-tab-${next}`)?.focus();
      }}>{name}{WORLD_SETTING_FIELDS.some(field => field.group === name && edits[field.key]) && <span aria-label="Unsaved changes"> •</span>}</button>)}
    </div>
    <form onSubmit={event => { event.preventDefault(); void apply(); }} noValidate>
      <div className="world-settings-panel" role="tabpanel" id={`world-settings-panel-${groups.indexOf(group)}`} aria-labelledby={`world-settings-tab-${groups.indexOf(group)}`}>
        {group === 'Movement rules' && <p className="world-settings-help">These are world rules. Effective citizen capabilities and caretaker privileges are not edited here.</p>}
        {group === 'Lighting & sky' && <p className="world-settings-help">Your local lighting override, if enabled, remains separate. Light direction components are authored values, not automatically normalized.</p>}
        {group === 'Water' && <p className="world-settings-help">Legacy water attributes do not reproduce advanced shader water. Opacity uses the server’s exact 0–255 scale.</p>}
        {group === 'Physics' && <p className="world-settings-help">These are server-authored settings. Renderer support is not a promise of historical physics parity.</p>}
        <div className="world-settings-fields">{WORLD_SETTING_FIELDS.filter(field => field.group === group).map(field => {
          const edit = edits[field.key], value = edit?.value ?? worldSettingDraftValue(field, raw);
          const conflict = !!edit && !sameBaseline(field, edit.baseline, raw), authored = field.ids.some(id => Object.hasOwn(raw, id));
          const unsupported = field.kind !== 'object-path' && !worldSettingDraftValue(field, raw) && field.ids.some(id => (raw[id] ?? '') !== '');
          const id = `world-setting-${field.key}`, help = `${id}-help`;
          const common = { id, name: field.key, value, disabled: busy || (field.kind === 'boolean' && !!disabledReason), 'aria-invalid': !!errors[field.key], 'aria-describedby': help, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => update(field, event.target.value), ref: (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null) => { if (element) inputRefs.current.set(field.key, element); else inputRefs.current.delete(field.key); } };
          return <div key={field.key} className={`world-setting-field ${field.multiline || field.kind === 'object-path' ? 'world-setting-wide' : ''} ${conflict ? 'has-conflict' : ''}`}>
            <label htmlFor={id}>{field.label}{edit && <span className="world-setting-dirty" aria-hidden="true">Edited</span>}</label>
            {field.kind === 'object-path' && <div className="world-setting-current-path"><strong>Current path</strong><span>{displayObjectPath(raw[field.ids[0]] ?? '')}</span></div>}
            {field.multiline ? <textarea {...common} readOnly={!!disabledReason} rows={4} /> : field.kind === 'boolean' ? <select {...common}><option value="" disabled>Not provided or unsupported</option><option value="Y">Yes</option><option value="N">No</option></select> : <div className="world-setting-input">{field.kind === 'color' && /^#[\da-f]{6}$/i.test(value) && <i aria-hidden="true" style={{ backgroundColor: value }} />}<input {...common} readOnly={!!disabledReason} type="text" inputMode={field.kind === 'integer' || field.kind === 'float' ? 'decimal' : undefined} autoComplete="off" spellCheck={field.kind === 'text'} placeholder={field.kind === 'object-path' ? edit?.value === '' ? 'Empty path staged for removal' : 'Leave blank to keep the existing path' : field.kind === 'color' ? '#rrggbb' : undefined} /></div>}
            {field.kind === 'object-path' && edit?.value === '' && <p className="world-settings-field-error" role="status">Object path will be cleared when you apply.</p>}
            <p id={help} className={errors[field.key] ? 'world-settings-field-error' : 'world-settings-help'}>{errors[field.key] || (field.kind === 'object-path' ? 'Replacement only: HTTP(S), without credentials, query parameters, or fragments. Existing private parts are never copied into this input.' : unsupported ? 'The existing value is unsupported by this editor. It remains unchanged unless you explicitly replace or clear it.' : !authored ? 'No authored value was received. Leave untouched to preserve the server’s existing behavior.' : field.min !== undefined ? `${field.min} to ${field.max}${field.unit ? ` · ${field.unit}` : ''}` : field.unit || (field.kind === 'asset' ? 'Object-path filename only, not a URL or directory.' : field.maxBytes ? `Maximum ${field.maxBytes.toLocaleString()} UTF-8 bytes.` : ''))}</p>
            {field.kind === 'object-path' && (raw[field.ids[0]] ?? '') !== '' && <button type="button" className="subtle-button" disabled={busy || !!disabledReason} onClick={() => setClearPath(true)}>Clear object path…</button>}
            {unsupported && (field.kind === 'asset' || field.kind === 'text') && <button type="button" className="subtle-button" disabled={busy || !!disabledReason} onClick={() => update(field, '', true)}>Clear stored {field.label.toLowerCase()}</button>}
            {conflict && !busy && <div className="world-setting-conflict" role="alert"><strong>This field changed on the server.</strong><span>Current: {currentValue(field)}</span><div><button type="button" className="secondary-button" disabled={!!disabledReason} onClick={() => review(field, false)}>Use current value</button><button type="button" className="secondary-button" disabled={!!disabledReason} onClick={() => review(field, true)}>Keep my draft</button></div><small>Keeping your draft accepts this new baseline; it does not send an update.</small></div>}
          </div>;
        })}</div>
      </div>
      {!!conflicts.length && !busy && !disabledReason && <p className="world-settings-alert" role="alert">{conflicts.length} edited {conflicts.length === 1 ? 'field changed' : 'fields changed'} on the server. Review each highlighted field before applying.</p>}
      {message && <p className={`world-settings-message ${observed ? 'is-observed' : ''}`} role="status">{observed && <Check size={17} />}{message}</p>}
      <div className="world-settings-footer"><span aria-live="polite">{dirty ? `${Object.keys(edits).length} unsaved ${Object.keys(edits).length === 1 ? 'field' : 'fields'}` : 'No unsaved changes'}</span><button type="button" className="secondary-button" disabled={busy} onClick={dirty ? discard : close}>{dirty ? 'Discard changes' : 'Close'}</button><button className="primary-button" disabled={busy || !dirty || !!disabledReason || !!conflicts.length}><Save size={15} />{busy ? 'Awaiting broadcast…' : 'Apply changes'}</button></div>
    </form>
    {closeConfirmation && <Modal title="Discard unsaved world settings?" onClose={() => setCloseConfirmation(null)}><div className="world-settings-confirm"><p>Nothing else will be sent to the world. Your draft will be lost.</p><div><button className="secondary-button" onClick={() => setCloseConfirmation(null)}>Keep editing</button><button className="danger-button" onClick={() => { const proceed = closeConfirmation.proceed; setEdits({}); setCloseConfirmation(null); proceed(); }}>Discard and close</button></div></div></Modal>}
    {clearPath && <Modal title="Clear object path?" onClose={() => setClearPath(false)}><div className="world-settings-confirm"><p>Models, textures and avatars may stop loading. This only stages the change; Apply changes sends it.</p><div><button className="secondary-button" onClick={() => setClearPath(false)}>Keep object path</button><button className="danger-button" onClick={() => { const field = WORLD_SETTING_FIELDS.find(field => field.kind === 'object-path')!; update(field, '', true); setClearPath(false); }}>Stage empty object path</button></div></div></Modal>}
  </Modal>;
}
