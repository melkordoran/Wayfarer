import { describe, expect, it } from 'vitest';
import type { TerrainTile, WorldObject } from '../src/shared/types';
import { applyStudioTerrainRows, materializeStudioTerrain, STUDIO_TERRAIN_HEIGHT, validateStudioTerrain } from '../src/renderer/studio-terrain';
import { decodeStudioProject, encodeStudioProject, loadStudioProject, makeStudioProject, saveStudioProject, STORAGE_KEY, type StudioStorage } from '../src/renderer/studio-project';

function patch(nodeX = 64, nodeZ = 64): TerrainTile {
  return { pageX: 0, pageZ: 0, nodeX, nodeZ, size: 8, heights: Array(64).fill(STUDIO_TERRAIN_HEIGHT), textures: Array(64).fill(0) };
}
const worldObject: WorldObject = { id: 1, owner: 1, model: 'wayfarer:cube', description: 'Original', action: '', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
const position = { x: 0, y: 0, z: -22, yaw: 0 }, timestamp = '2026-09-07T08:00:00.000Z';
function project(terrain?: TerrainTile[]) {
  const result = makeStudioProject('Terrain test', [worldObject], position, timestamp, terrain);
  if (!result.ok) throw new Error(result.error.message); return result.value;
}
function storage(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[STORAGE_KEY, initial]]);
  const api: StudioStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
  return { data, api };
}
function assertCompleteNonoverlap(tiles: readonly TerrainTile[]) {
  const cells = new Set<string>(); let count = 0;
  for (const tile of tiles) {
    expect([tile.pageX, tile.pageZ]).toEqual([0, 0]);
    for (let z = tile.nodeZ; z < tile.nodeZ + tile.size; z++) for (let x = tile.nodeX; x < tile.nodeX + tile.size; x++) {
      const key = `${x},${z}`; if (cells.has(key)) throw new Error('Overlapping materialized terrain at ' + key); cells.add(key); count++;
    }
  }
  expect(count).toBe(16_384); expect(cells.size).toBe(16_384); expect(cells.has('0,0') && cells.has('127,127')).toBe(true);
}

describe('sparse original-studio terrain patches', () => {
  it('materializes the unedited 128-square page as 16 nonoverlapping flat nodes', () => {
    const tiles = materializeStudioTerrain(); expect(tiles).toHaveLength(16);
    expect(tiles.every(tile => tile.size === 32 && tile.heights.length === 1 && tile.heights[0] === STUDIO_TERRAIN_HEIGHT && tile.textures[0] === 0)).toBe(true);
    assertCompleteNonoverlap(tiles);
  });
  it('subdivides only touched 32-cell regions and preserves all 16384 cells exactly once', () => {
    const input = patch(); input.heights[0] = 1.23;
    const tiles = materializeStudioTerrain([input]); expect(tiles).toHaveLength(31); assertCompleteNonoverlap(tiles);
    expect(tiles.find(tile => tile.nodeX === 64 && tile.nodeZ === 64)?.heights).toEqual(input.heights);
    input.heights[0] = 99; expect(tiles.find(tile => tile.nodeX === 64 && tile.nodeZ === 64)?.heights[0]).toBe(1.23);
  });
  it('accepts the maximum 256 aligned patches and does not overlap materialization', () => {
    const patches: TerrainTile[] = [];
    for (let z = 0; z < 128; z += 8) for (let x = 0; x < 128; x += 8) patches.push(patch(x, z));
    expect(validateStudioTerrain(patches)).toHaveLength(256); expect(materializeStudioTerrain(patches)).toHaveLength(256); assertCompleteNonoverlap(materializeStudioTerrain(patches));
    expect(() => validateStudioTerrain([...patches, patch()])).toThrow();
  });
  it('writes Z-major cells across adjacent 8-cell patches without mutating caller arrays', () => {
    const original = patch(), snapshot = structuredClone(original);
    const result = applyStudioTerrainRows([original], [{ cellX: 7, cellZ: 1, heights: [0.25, -0.12], textures: [65, 129] }]);
    expect(original).toEqual(snapshot); expect(result).toHaveLength(2);
    expect(result.find(tile => tile.nodeX === 64)!.heights[15]).toBe(0.25);
    expect(result.find(tile => tile.nodeX === 72)!.heights[8]).toBe(-0.12);
    expect(result.find(tile => tile.nodeX === 72)!.textures[8]).toBe(129);
    expect(result.find(tile => tile.nodeX === 72)!.heights[9]).toBe(STUDIO_TERRAIN_HEIGHT);
  });
  it('accepts 64-cell edits but rejects larger edits and cross-page rows atomically', () => {
    const rows = [0, 1].map(cellZ => ({ cellX: 0, cellZ, heights: Array(32).fill(0.5), textures: Array(32).fill(1) }));
    const result = applyStudioTerrainRows([], rows); expect(result.reduce((sum, tile) => sum + tile.heights.filter(height => height === 0.5).length, 0)).toBe(64);
    const snapshot = structuredClone(result);
    for (const invalid of [
      [...rows, { cellX: 0, cellZ: 2, heights: [1], textures: [0] }],
      [{ cellX: 63, cellZ: 0, heights: [1, 2], textures: [0, 0] }],
      [{ cellX: -65, cellZ: 0, heights: [1], textures: [0] }],
      [{ cellX: 0, cellZ: 64, heights: [1], textures: [0] }],
    ]) expect(() => applyStudioTerrainRows(result, invalid)).toThrow();
    expect(result).toEqual(snapshot);
  });
  it('retains texture-only changes and removes patches only after all original values are restored', () => {
    const painted = applyStudioTerrainRows([], [{ cellX: 0, cellZ: 0, heights: [STUDIO_TERRAIN_HEIGHT], textures: [1] }]);
    expect(painted).toHaveLength(1);
    const restored = applyStudioTerrainRows(painted, [{ cellX: 0, cellZ: 0, heights: [STUDIO_TERRAIN_HEIGHT], textures: [0] }]); expect(restored).toEqual([]);
  });
  it('rejects duplicate cells and invalid heights/textures after preserving original patches', () => {
    const original = patch(); original.heights[5] = 2; const snapshot = structuredClone(original);
    for (const rows of [
      [{ cellX: 0, cellZ: 0, heights: [1], textures: [0] }, { cellX: 0, cellZ: 0, heights: [2], textures: [0] }],
      [{ cellX: 0, cellZ: 0, heights: [NaN], textures: [0] }],
      [{ cellX: 0, cellZ: 0, heights: [0.001], textures: [0] }],
      [{ cellX: 0, cellZ: 0, heights: [1], textures: [65536] }],
      [{ cellX: 0, cellZ: 0, heights: [1, 2], textures: [0] }],
    ]) expect(() => applyStudioTerrainRows([original], rows)).toThrow();
    expect(original).toEqual(snapshot);
  });
  it.each([
    { ...patch(), pageX: 1 }, { ...patch(), nodeZ: 1 }, { ...patch(), nodeX: 128 }, { ...patch(), size: 16 },
    { ...patch(), heights: [0] }, { ...patch(), textures: Array(64).fill(1.5) }, { ...patch(), heights: Array(64).fill(Infinity) },
    { ...patch(), heights: Array(64) }, { ...patch(), textures: Array(64) }, { ...patch(), sequence: 1 }, { ...patch(), objectPath: 'https://outside.invalid/' },
  ])('rejects unsafe or malformed serialized patch %#', invalid => expect(() => validateStudioTerrain([invalid])).toThrow());
  it('rejects overlapping patches, nonplain values and unsupported fields', () => {
    expect(() => validateStudioTerrain([patch(), patch()])).toThrow(); expect(() => validateStudioTerrain([new Date()])).toThrow();
    expect(() => validateStudioTerrain([Object.assign(Object.create({ inherited: true }), patch())])).toThrow();
    expect(() => validateStudioTerrain([{ ...patch(), password: 'must-not-persist' }])).toThrow();
  });
});

describe('studio terrain project v2 compatibility and storage preservation', () => {
  it('keeps version1 exports byte-schema-compatible when terrain is omitted', () => {
    const original = project(), encoded = encodeStudioProject(original); expect(original.version).toBe(1); expect(Object.hasOwn(original, 'terrain')).toBe(false);
    if (!encoded.ok) throw new Error(encoded.error.message);
    const decoded = decodeStudioProject(encoded.value); expect(decoded).toEqual({ ok: true, value: original }); expect(encoded.value).not.toContain('"terrain"');
  });
  it('round-trips version2 sparse patches exactly with original object/position data', () => {
    const terrain = applyStudioTerrainRows([], [{ cellX: -1, cellZ: 3, heights: [1.23, -2.34], textures: [65, 129] }]), value = project(terrain);
    expect(value.version).toBe(2); expect(value.terrain).toEqual(terrain);
    const encoded = encodeStudioProject(value); if (!encoded.ok) throw new Error(encoded.error.message);
    expect(decodeStudioProject(encoded.value)).toEqual({ ok: true, value });
    terrain[0].heights[0] = 99; expect(value.terrain).not.toEqual(terrain);
  });
  it('retains an explicit empty v2 terrain list without inventing patches', () => {
    const value = project([]), result = decodeStudioProject(JSON.stringify(value)); expect(result).toEqual({ ok: true, value }); expect(value.version).toBe(2); expect(value.terrain).toEqual([]);
  });
  it('rejects terrain on version1 and missing, malformed or remote pages on version2', () => {
    for (const invalid of [{ ...project(), terrain: [] }, { ...project(), version: 2 }, { ...project([]), terrain: [{ ...patch(), pageZ: 1 }] }, { ...project([]), terrain: 'not-an-array' }, { ...project([]), version: 3 }]) expect(decodeStudioProject(JSON.stringify(invalid)).ok).toBe(false);
  });
  it('loads existing v1 data without rewriting or upgrading storage', () => {
    const bytes = JSON.stringify(project()), target = storage(bytes), loaded = loadStudioProject(project([]), target.api);
    expect(loaded).toEqual({ ok: true, value: { project: project(), source: 'saved' } }); expect(target.data.get(STORAGE_KEY)).toBe(bytes);
  });
  it('preserves corrupt terrain storage instead of replacing it with fallback or autosave', () => {
    const bytes = JSON.stringify({ ...project([]), terrain: [{ ...patch(), heights: [99] }] }), target = storage(bytes);
    expect(loadStudioProject(project(), target.api)).toMatchObject({ ok: false, error: { code: 'corrupt-storage' } });
    expect(saveStudioProject(project([]), target.api)).toMatchObject({ ok: false, error: { code: 'corrupt-storage' } }); expect(target.data.get(STORAGE_KEY)).toBe(bytes);
  });
  it('does not touch saved data when importing an invalid v2 project', () => {
    const bytes = JSON.stringify(project()), target = storage(bytes);
    expect(saveStudioProject({ ...project([]), terrain: [{ ...patch(), sequence: 9 }] }, target.api).ok).toBe(false); expect(target.data.get(STORAGE_KEY)).toBe(bytes);
  });
  it('reports quota failure without silently losing the prior valid terrain project', () => {
    const old = project([patch()]), bytes = JSON.stringify(old), target = storage(bytes);
    target.api.setItem = () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); };
    expect(saveStudioProject(project([]), target.api)).toMatchObject({ ok: false, error: { code: 'quota-exceeded' } }); expect(target.data.get(STORAGE_KEY)).toBe(bytes);
  });
  it('requires explicit corrupt replacement and validates the replacement before writing', () => {
    const target = storage('{broken');
    expect(saveStudioProject(project([]), target.api, { replaceCorrupt: true })).toMatchObject({ ok: true, value: { version: 2, terrain: [] } });
    const saved = target.data.get(STORAGE_KEY); expect(saved).not.toBe('{broken'); expect(decodeStudioProject(saved!).ok).toBe(true);
  });
});
