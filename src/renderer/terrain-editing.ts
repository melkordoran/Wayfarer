import { TERRAIN_EDIT_LIMITS, terrainCentimetres, type TerrainCellSample, type TerrainEditRow } from '../shared/terrain-edit';

export type TerrainOperation = 'raise' | 'lower' | 'flatten' | 'paint';
export interface TerrainChange { before: TerrainEditRow; after: TerrainEditRow }
const cloneRow = (row: TerrainEditRow): TerrainEditRow => ({ ...row, heights: [...row.heights], textures: [...row.textures] });
const cloneChange = (change: TerrainChange): TerrainChange => ({ before: cloneRow(change.before), after: cloneRow(change.after) });
export function sameTerrainRow(a: TerrainEditRow, b: TerrainEditRow): boolean {
  return a.cellX === b.cellX && a.cellZ === b.cellZ && a.heights.length === b.heights.length && a.textures.length === b.textures.length
    && a.heights.every((height, index) => height === b.heights[index]) && a.textures.every((texture, index) => texture === b.textures[index]);
}
/** Homogeneous destination textures match TerrainSet's one-texture-per-row contract. */
export function planTerrainEdit(samples: readonly TerrainCellSample[], operation: TerrainOperation, metres: number, texture: number): TerrainChange[] {
  if (!samples.length || samples.length > 64) throw new Error('Select between 1 and 64 loaded terrain cells.');
  if (!['raise', 'lower', 'flatten', 'paint'].includes(operation)) throw new Error('Choose a terrain operation.');
  if (operation !== 'paint') { terrainCentimetres(metres); if (operation !== 'flatten' && metres <= 0) throw new Error('The height step must be positive.'); }
  if (!Number.isInteger(texture) || texture < 0 || texture > 65535) throw new Error('Choose a valid terrain texture.');
  const sorted = [...samples].sort((a, b) => a.cellZ - b.cellZ || a.cellX - b.cellX), seen = new Set<string>(), rows: TerrainChange[] = [];
  for (const cell of sorted) {
    if (![cell.cellX, cell.cellZ].every(value => Number.isInteger(value) && Math.abs(value) <= TERRAIN_EDIT_LIMITS.maxCellCoordinate)) throw new Error('Terrain selection is outside the supported world coordinates.');
    if (cell.height === null || cell.texture === null) throw new Error('Wait for a complete loaded terrain page before editing.');
    terrainCentimetres(cell.height);
    if (!Number.isInteger(cell.texture) || cell.texture < 0 || cell.texture > 65535) throw new Error('Invalid loaded terrain texture.');
    const key = `${cell.cellX},${cell.cellZ}`;
    if (seen.has(key)) throw new Error('Terrain selection contains duplicate cells.');
    seen.add(key);
    const height = operation === 'paint' ? cell.height : operation === 'flatten' ? metres : Math.round((cell.height + (operation === 'raise' ? metres : -metres)) * 100) / 100;
    terrainCentimetres(height);
    const material = operation === 'paint' ? texture : cell.texture;
    if (height === cell.height && material === cell.texture) continue;
    let row = rows.at(-1);
    if (!row || row.after.cellZ !== cell.cellZ || row.after.cellX + row.after.heights.length !== cell.cellX || row.after.heights.length === 32 || row.after.textures[0] !== material) {
      const empty = { cellX: cell.cellX, cellZ: cell.cellZ, heights: [] as number[], textures: [] as number[] };
      row = { before: cloneRow(empty), after: cloneRow(empty) }; rows.push(row);
    }
    row.before.heights.push(cell.height); row.before.textures.push(cell.texture);
    row.after.heights.push(height); row.after.textures.push(material);
  }
  return rows;
}

/** Undo may need finer rows than paint: the original texture can vary per cell. */
export function splitTerrainChange(change: TerrainChange, reverse = false): TerrainChange[] {
  const before = reverse ? change.after : change.before, after = reverse ? change.before : change.after;
  const result: TerrainChange[] = [];
  for (let start = 0; start < after.heights.length;) {
    let end = start + 1;
    while (end < after.heights.length && end - start < 32 && after.textures[end] === after.textures[start]) end++;
    const part = (row: TerrainEditRow) => ({ cellX: row.cellX + start, cellZ: row.cellZ, heights: row.heights.slice(start, end), textures: row.textures.slice(start, end) });
    result.push({ before: part(before), after: part(after) }); start = end;
  }
  return result;
}
export interface TerrainBatchResult { completed: number; total: number; error?: string; superseded?: boolean }
type Entry = { label: string; changes: TerrainChange[] };
export class TerrainHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private generation = 0;
  busy = false;
  get undoLabel() { return this.past.at(-1)?.label ?? ''; }
  get redoLabel() { return this.future.at(-1)?.label ?? ''; }
  reset() { this.generation++; this.past = []; this.future = []; this.busy = false; }
  async run(label: string, changes: readonly TerrainChange[], apply: (change: TerrainChange) => Promise<TerrainEditRow>, direction: 'edit' | 'undo' | 'redo' = 'edit'): Promise<TerrainBatchResult> {
    if (this.busy) throw new Error('Wait for the current terrain edit.');
    const stack = direction === 'undo' ? this.past : this.future;
    const entry = direction === 'edit' ? { label, changes: changes.map(cloneChange) } : stack.at(-1);
    if (!entry) return { completed: 0, total: 0 };
    const identities = new Set<string>();
    if (entry.changes.length > 64) throw new Error('Terrain history is limited to 64 cells per edit.');
    for (const change of entry.changes) {
      const a = change.before, b = change.after;
      if (a.cellX !== b.cellX || a.cellZ !== b.cellZ || !a.heights.length || a.heights.length > 32 || a.heights.length !== b.heights.length || a.textures.length !== a.heights.length || b.textures.length !== a.heights.length) throw new Error('Terrain history contains inconsistent rows.');
      for (let index = 0; index < a.heights.length; index++) {
        if (![a.cellX + index, a.cellZ].every(value => Number.isInteger(value) && Math.abs(value) <= TERRAIN_EDIT_LIMITS.maxCellCoordinate)) throw new Error('Terrain history is outside the supported world coordinates.');
        const key = `${a.cellX + index},${a.cellZ}`;
        if (identities.has(key) || identities.size >= 64) throw new Error('Terrain history cells must be unique and limited to 64.');
        identities.add(key);
        terrainCentimetres(a.heights[index]); terrainCentimetres(b.heights[index]);
        if (![a.textures[index], b.textures[index]].every(value => Number.isInteger(value) && value >= 0 && value <= 65535)) throw new Error('Invalid terrain history texture.');
      }
    }
    // Store cell-level steps so partially completed undo/redo retains exact work.
    const cells = entry.changes.flatMap(change => change.after.heights.map((_, index) => {
      const part = (row: TerrainEditRow): TerrainEditRow => ({ cellX: row.cellX + index, cellZ: row.cellZ, heights: [row.heights[index]], textures: [row.textures[index]] });
      return { before: part(change.before), after: part(change.after) };
    }));
    if (cells.length > 64) throw new Error('Terrain history is limited to 64 cells per edit.');
    const generation = this.generation, completed: TerrainChange[] = [];
    this.busy = true;
    let error: string | undefined;
    // Combine neighboring cells only when both textures match, keeping reverse
    // operations representable without losing partial-success boundaries.
    const ordered = direction === 'undo' ? [...cells].reverse().map(change => ({ before: change.after, after: change.before })) : cells;
    const work: TerrainChange[] = [];
    for (const change of ordered) {
      const last = work.at(-1);
      if (direction !== 'undo' && last && last.after.cellZ === change.after.cellZ && last.after.cellX + last.after.heights.length === change.after.cellX && last.after.heights.length < 32 && last.before.textures[0] === change.before.textures[0] && last.after.textures[0] === change.after.textures[0]) {
        last.before.heights.push(...change.before.heights); last.before.textures.push(...change.before.textures);
        last.after.heights.push(...change.after.heights); last.after.textures.push(...change.after.textures);
      } else work.push(cloneChange(change));
    }
    try {
      for (const change of work) {
        if (generation !== this.generation) return { completed: 0, total: cells.length, superseded: true };
        const canonical = await apply(cloneChange(change));
        if (generation !== this.generation) return { completed: 0, total: cells.length, superseded: true };
        if (!sameTerrainRow(canonical, change.after)) throw new Error('Terrain readback differs from the edit. Inspect the canonical terrain before continuing.');
        for (let i = 0; i < canonical.heights.length; i++) {
          const part = (row: TerrainEditRow) => ({ cellX: row.cellX + i, cellZ: row.cellZ, heights: [row.heights[i]], textures: [row.textures[i]] });
          const accepted = { before: part(change.before), after: part(canonical) };
          completed.push(direction === 'undo' ? { before: accepted.after, after: accepted.before } : accepted);
        }
      }
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Terrain edit failed.'; }
    finally { if (generation === this.generation) this.busy = false; }
    if (generation !== this.generation) return { completed: 0, total: cells.length, superseded: true };
    if (completed.length) {
      if (direction === 'edit') { this.future = []; this.past.push({ label: entry.label, changes: completed }); }
      else {
        stack.pop();
        const remaining = direction === 'undo' ? cells.slice(0, cells.length - completed.length) : cells.slice(completed.length);
        if (remaining.length) stack.push({ label: entry.label, changes: remaining });
        (direction === 'undo' ? this.future : this.past).push({ label: entry.label, changes: direction === 'undo' ? completed.reverse() : completed });
      }
      this.past = this.past.slice(-32); this.future = this.future.slice(-32);
    }
    return { completed: completed.length, total: cells.length, ...(error ? { error } : {}) };
  }
}
