import { describe, expect, it, vi } from 'vitest';
import { TERRAIN_EDIT_LIMITS, type TerrainCellSample, type TerrainEditRow } from '../src/shared/terrain-edit';
import { planTerrainEdit, sameTerrainRow, splitTerrainChange, TerrainHistory, type TerrainChange } from '../src/renderer/terrain-editing';

const sample = (cellX: number, cellZ = 0, height = 0, texture = 0): TerrainCellSample => ({ cellX, cellZ, height, texture });
const row = (cellX: number, heights: number[], textures = heights.map(() => 0), cellZ = 0): TerrainEditRow => ({ cellX, cellZ, heights, textures });
const change = (cellX = 0, before = 0, after = 1): TerrainChange => ({ before: row(cellX, [before]), after: row(cellX, [after]) });
function store(textures = [0, 1, 2, 3]) {
  const cells = new Map(textures.map((texture, x) => [`${x},0`, { height: 0, texture }]));
  const read = (value: TerrainEditRow) => ({ ...value, heights: value.heights.map((_, i) => cells.get(`${value.cellX + i},${value.cellZ}`)!.height), textures: value.heights.map((_, i) => cells.get(`${value.cellX + i},${value.cellZ}`)!.texture) });
  const apply = vi.fn(async (value: TerrainChange) => {
    if (!sameTerrainRow(read(value.before), value.before)) throw new Error('Canonical baseline conflict');
    value.after.heights.forEach((height, i) => cells.set(`${value.after.cellX + i},${value.after.cellZ}`, { height, texture: value.after.textures[i] }));
    return read(value.after);
  });
  const selection = () => textures.map((_, x) => { const current = cells.get(`${x},0`)!; return sample(x, 0, current.height, current.texture); });
  return { cells, read, apply, selection, textures: () => textures.map((_, x) => cells.get(`${x},0`)!.texture) };
}
const failAt = (apply: (change: TerrainChange) => Promise<TerrainEditRow>, index: number) => {
  let calls = 0;
  return async (change: TerrainChange) => { if (calls++ === index) throw new Error('Injected row rejection'); return apply(change); };
};

describe('bounded terrain operation planning', () => {
  it('sorts cells, preserves originals, and groups at 32-cell boundaries', () => {
    const samples = Array.from({ length: 64 }, (_, i) => sample(63 - i));
    const snapshot = structuredClone(samples), changes = planTerrainEdit(samples, 'raise', 0.1, 0);
    expect(changes.map(value => [value.after.cellX, value.after.heights.length])).toEqual([[0, 32], [32, 32]]);
    expect(changes.every(value => value.after.heights.every(height => height === 0.1))).toBe(true); expect(samples).toEqual(snapshot);
  });
  it('keeps gaps and Z rows separate and splits preserved textures for height edits', () => {
    const changes = planTerrainEdit([sample(3), sample(1, 0, 0, 1), sample(0), sample(0, 1)], 'lower', 0.25, 8);
    expect(changes.map(value => [value.after.cellX, value.after.cellZ, value.after.textures[0]])).toEqual([[0, 0, 0], [1, 0, 1], [3, 0, 0], [0, 1, 0]]);
    expect(changes.every(value => value.after.heights[0] === -0.25)).toBe(true);
  });
  it('paints without changing height and flattens without changing texture', () => {
    const cells = [sample(0, 0, 0.1, 1), sample(1, 0, -1.2, 2)];
    expect(planTerrainEdit(cells, 'paint', NaN, 129)[0]).toEqual({ before: row(0, [0.1, -1.2], [1, 2]), after: row(0, [0.1, -1.2], [129, 129]) });
    const flat = planTerrainEdit(cells, 'flatten', -0.5, 0);
    expect(flat.map(value => value.after.heights[0])).toEqual([-0.5, -0.5]); expect(flat.map(value => value.after.textures[0])).toEqual([1, 2]);
    expect(planTerrainEdit([sample(0, 0, 0.2)], 'raise', 0.1, 0)[0].after.heights).toEqual([0.3]);
  });
  it('omits unchanged cells without bridging an unedited gap', () => {
    expect(planTerrainEdit([sample(0)], 'paint', 0, 0)).toEqual([]);
    expect(planTerrainEdit([sample(0, 0, 1), sample(1), sample(2, 0, 1)], 'flatten', 0, 0).map(value => value.after.cellX)).toEqual([0, 2]);
  });
  it.each([[], [sample(0), sample(0)], [{ ...sample(0), height: null }], [{ ...sample(0), texture: null }], [sample(0.5)], [sample(0, 0, 0.001)], [sample(0, 0, 0, 65536)]].map(samples => ({ samples })))('rejects malformed, unknown or repeated cells %#', ({ samples }) => expect(() => planTerrainEdit(samples, 'raise', 1, 0)).toThrow());
  it.each([0, -1, 0.001, NaN, Infinity])('rejects invalid raise/lower step %s', metres => expect(() => planTerrainEdit([sample(0)], 'raise', metres, 0)).toThrow());
  it('rejects total cell overflow and height overflow before returning a plan', () => {
    expect(() => planTerrainEdit(Array.from({ length: 65 }, (_, i) => sample(i)), 'paint', 0, 1)).toThrow();
    expect(() => planTerrainEdit([sample(0, 0, 21474836.47)], 'raise', 0.01, 0)).toThrow();
  });
  it.each([TERRAIN_EDIT_LIMITS.maxCellCoordinate + 1, -TERRAIN_EDIT_LIMITS.maxCellCoordinate - 1, Number.MAX_SAFE_INTEGER])('rejects out-of-range cell %s before even a preceding valid cell is planned', coordinate => {
    expect(() => planTerrainEdit([sample(0), sample(coordinate)], 'raise', 1, 0)).toThrow();
    expect(() => planTerrainEdit([sample(0), sample(0, coordinate)], 'raise', 1, 0)).toThrow();
  });
  it('splits inverse paint into exact original texture runs', () => {
    const value = { before: row(0, [1, 2, 3, 4], [0, 1, 1, 2]), after: row(0, [1, 2, 3, 4], [5, 5, 5, 5]) };
    expect(splitTerrainChange(value, true)).toEqual([
      { before: row(0, [1], [5]), after: row(0, [1], [0]) },
      { before: row(1, [2, 3], [5, 5]), after: row(1, [2, 3], [1, 1]) },
      { before: row(3, [4], [5]), after: row(3, [4], [2]) },
    ]);
  });
});

describe('terrain history preserves exact accepted partial work', () => {
  it('supports complete edit/undo/redo without losing original mixed textures', async () => {
    const state = store(), history = new TerrainHistory();
    expect(await history.run('Paint', planTerrainEdit(state.selection(), 'paint', 0, 9), state.apply)).toEqual({ completed: 4, total: 4 });
    expect(state.textures()).toEqual([9, 9, 9, 9]); expect(history.undoLabel).toBe('Paint');
    expect(await history.run('', [], state.apply, 'undo')).toEqual({ completed: 4, total: 4 }); expect(state.textures()).toEqual([0, 1, 2, 3]);
    expect(await history.run('', [], state.apply, 'redo')).toEqual({ completed: 4, total: 4 }); expect(state.textures()).toEqual([9, 9, 9, 9]);
  });
  it('retains only accepted edit cells as undoable after a later row fails', async () => {
    const state = store(), history = new TerrainHistory();
    expect(await history.run('Paint', planTerrainEdit(state.selection(), 'paint', 0, 9), failAt(state.apply, 2))).toMatchObject({ completed: 2, total: 4, error: 'Injected row rejection' });
    expect(state.textures()).toEqual([9, 9, 2, 3]);
    await history.run('', [], state.apply, 'undo'); expect(state.textures()).toEqual([0, 1, 2, 3]);
    await history.run('', [], state.apply, 'redo'); expect(state.textures()).toEqual([9, 9, 2, 3]);
  });
  it('keeps remaining and accepted partial-undo slices independently replayable', async () => {
    const state = store(), history = new TerrainHistory();
    await history.run('Paint', planTerrainEdit(state.selection(), 'paint', 0, 9), state.apply);
    expect(await history.run('', [], failAt(state.apply, 1), 'undo')).toMatchObject({ completed: 1, total: 4, error: 'Injected row rejection' });
    expect(state.textures()).toEqual([9, 9, 9, 3]); expect(history.undoLabel).toBe('Paint'); expect(history.redoLabel).toBe('Paint');
    expect(await history.run('', [], state.apply, 'undo')).toEqual({ completed: 3, total: 3 }); expect(state.textures()).toEqual([0, 1, 2, 3]);
    await history.run('', [], state.apply, 'redo'); expect(state.textures()).toEqual([9, 9, 9, 3]);
    await history.run('', [], state.apply, 'redo'); expect(state.textures()).toEqual([9, 9, 9, 9]);
  });
  it('keeps partial redo work undoable while retaining its unaccepted suffix', async () => {
    const state = store(), history = new TerrainHistory();
    await history.run('Paint', planTerrainEdit(state.selection(), 'paint', 0, 9), state.apply); await history.run('', [], state.apply, 'undo');
    expect(await history.run('', [], failAt(state.apply, 2), 'redo')).toMatchObject({ completed: 2, total: 4, error: 'Injected row rejection' });
    expect(state.textures()).toEqual([9, 9, 2, 3]);
    await history.run('', [], state.apply, 'redo'); expect(state.textures()).toEqual([9, 9, 9, 9]);
    await history.run('', [], state.apply, 'undo'); await history.run('', [], state.apply, 'undo'); expect(state.textures()).toEqual([0, 1, 2, 3]);
  });
  it('does not treat a conflicting readback as verified or automatically undo it', async () => {
    const history = new TerrainHistory(), apply = vi.fn(async (value: TerrainChange) => ({ ...value.after, heights: [99] }));
    const result = await history.run('Raise', [change()], apply);
    expect(result.completed).toBe(0); expect(result.error).toMatch(/readback differs/); expect(history.undoLabel).toBe(''); expect(history.busy).toBe(false); expect(apply).toHaveBeenCalledOnce();
  });
  it('preserves a changed canonical cell when the adapter reports a stale baseline', async () => {
    const state = store(), history = new TerrainHistory(), changes = planTerrainEdit(state.selection(), 'paint', 0, 9);
    state.cells.set('1,0', { height: 7, texture: 6 });
    expect(await history.run('Paint', changes, state.apply)).toMatchObject({ completed: 1, total: 4, error: 'Canonical baseline conflict' });
    await history.run('', [], state.apply, 'undo'); expect(state.cells.get('1,0')).toEqual({ height: 7, texture: 6 }); expect(state.cells.get('0,0')).toEqual({ height: 0, texture: 0 });
  });
  it('refuses concurrent work and does not let an older completion clear a newer generation', async () => {
    const history = new TerrainHistory(); let finishOld!: (row: TerrainEditRow) => void, finishNew!: (row: TerrainEditRow) => void;
    const old = history.run('Old world', [change()], () => new Promise(resolve => { finishOld = resolve; }));
    await expect(history.run('Duplicate', [change()], async value => value.after)).rejects.toThrow(/current terrain edit/);
    history.reset();
    const current = history.run('New world', [change(1)], () => new Promise(resolve => { finishNew = resolve; }));
    finishOld(row(0, [1])); expect(await old).toMatchObject({ superseded: true }); expect(history.busy).toBe(true);
    finishNew(row(1, [1])); expect(await current).toEqual({ completed: 1, total: 1 }); expect(history.busy).toBe(false); expect(history.undoLabel).toBe('New world');
  });
  it('copies caller rows and does not let post-submit mutation rewrite history', async () => {
    const history = new TerrainHistory(), original = change(); let finish!: (row: TerrainEditRow) => void;
    const apply = vi.fn((_value: TerrainChange) => new Promise<TerrainEditRow>(resolve => { finish = resolve; }));
    const pending = history.run('Raise', [original], apply); original.before.heights[0] = 77; original.after.heights[0] = 88;
    const sent = apply.mock.calls[0][0]; expect(sent.before.heights).toEqual([0]); expect(sent.after.heights).toEqual([1]);
    finish(row(0, [1])); await pending;
    const undo = vi.fn(async (value: TerrainChange) => value.after); await history.run('', [], undo, 'undo'); expect(undo.mock.calls[0][0].after.heights).toEqual([0]);
  });
  it.each([
    { ...change(2), after: row(2, [NaN]) },
    { ...change(2), after: row(2, [0.001]) },
    { ...change(2), after: row(2, [1], [65536]) },
    { ...change(2), after: row(2, [1], []) },
    { ...change(2), before: row(3, [0]) },
    change(TERRAIN_EDIT_LIMITS.maxCellCoordinate + 1),
    { before: row(2, []), after: row(2, []) },
  ])('preflights every malformed change before a preceding valid row can be applied %#', async invalid => {
    const history = new TerrainHistory(), apply = vi.fn(async (value: TerrainChange) => value.after);
    await expect(history.run('Invalid batch', [change(), invalid], apply)).rejects.toThrow(); expect(apply).not.toHaveBeenCalled(); expect(history.busy).toBe(false);
  });
  it('rejects overlapping cells and oversized histories before applying anything', async () => {
    const apply = vi.fn(async (value: TerrainChange) => value.after), history = new TerrainHistory();
    await expect(history.run('Overlap', [change(), change()], apply)).rejects.toThrow();
    await expect(history.run('Too large', Array.from({ length: 65 }, (_, x) => change(x)), apply)).rejects.toThrow(); expect(apply).not.toHaveBeenCalled();
  });
  it('bounds retained history to the newest 32 edits', async () => {
    const history = new TerrainHistory(), apply = async (value: TerrainChange) => value.after;
    for (let i = 0; i < 40; i++) await history.run('Raise ' + i, [change(0, i, i + 1)], apply);
    let undos = 0; while (history.undoLabel) { await history.run('', [], apply, 'undo'); undos++; }
    expect(undos).toBe(32);
  });
});
