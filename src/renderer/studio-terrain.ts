import type { TerrainTile } from '../shared/types';
import { terrainCentimetres, terrainCellPage, type TerrainCellSample, type TerrainEditRow, type TerrainRegion } from '../shared/terrain-edit';

export const STUDIO_TERRAIN_HEIGHT = -0.07;
export function sampleStudioTerrain(patches: readonly TerrainTile[], region: TerrainRegion): TerrainCellSample[] {
  if (![region.cellX, region.cellZ, region.width, region.depth].every(Number.isSafeInteger) || region.width < 1 || region.depth < 1 || region.width > 8 || region.depth > 8) return [];
  const result: TerrainCellSample[] = [];
  for (let z = 0; z < region.depth; z++) for (let x = 0; x < region.width; x++) {
    const cellX = region.cellX + x, cellZ = region.cellZ + z, location = terrainCellPage(cellX, cellZ);
    if (location.pageX !== 0 || location.pageZ !== 0) { result.push({ cellX, cellZ, height: null, texture: null }); continue; }
    const nodeX = Math.floor(location.nodeX / 8) * 8, nodeZ = Math.floor(location.nodeZ / 8) * 8;
    const tile = patches.find(value => value.nodeX === nodeX && value.nodeZ === nodeZ);
    const index = (location.nodeZ - nodeZ) * 8 + location.nodeX - nodeX;
    result.push({ cellX, cellZ, height: tile?.heights[index] ?? STUDIO_TERRAIN_HEIGHT, texture: tile?.textures[index] ?? 0 });
  }
  return result;
}
/** Sparse, nonoverlapping 8x8 patches in the original centered studio page. */
export function validateStudioTerrain(input: unknown): TerrainTile[] {
  if (!Array.isArray(input) || input.length > 256) throw new Error('Studio terrain must contain at most 256 patches.');
  const keys = new Set<string>();
  return Array.from(input, value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Terrain patches must contain plain data.');
    const allowed = ['pageX', 'pageZ', 'nodeX', 'nodeZ', 'size', 'heights', 'textures'];
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Terrain patches contain unsupported fields.');
    const p = value as TerrainTile;
    if (p.pageX !== 0 || p.pageZ !== 0 || p.size !== 8 || ![p.nodeX, p.nodeZ].every(n => Number.isInteger(n) && n >= 0 && n <= 120 && n % 8 === 0)) throw new Error('Studio terrain patches must be aligned 8-cell squares within page zero.');
    const key = `${p.nodeX},${p.nodeZ}`;
    if (keys.has(key)) throw new Error('Studio terrain patches must not overlap.');
    keys.add(key);
    if (!Array.isArray(p.heights) || !Array.isArray(p.textures) || p.heights.length !== 64 || p.textures.length !== 64) throw new Error('Terrain patches need exactly 64 heights and textures.');
    const heights = Array.from(p.heights, height => { if (typeof height !== 'number') throw new Error('Invalid terrain height.'); terrainCentimetres(height); return height; });
    const textures = Array.from(p.textures, texture => { if (!Number.isInteger(texture) || texture < 0 || texture > 65535) throw new Error('Invalid terrain texture.'); return texture; });
    return { pageX: 0, pageZ: 0, nodeX: p.nodeX, nodeZ: p.nodeZ, size: 8, heights, textures };
  }).sort((a, b) => a.nodeZ - b.nodeZ || a.nodeX - b.nodeX);
}

export function materializeStudioTerrain(patches: readonly TerrainTile[] = []): TerrainTile[] {
  const checked = validateStudioTerrain(patches), result: TerrainTile[] = [];
  const byKey = new Map(checked.map(tile => [`${tile.nodeX},${tile.nodeZ}`, tile]));
  const flat = (nodeX: number, nodeZ: number, size: number): TerrainTile => ({ pageX: 0, pageZ: 0, nodeX, nodeZ, size, heights: [STUDIO_TERRAIN_HEIGHT], textures: [0] });
  for (let z = 0; z < 128; z += 32) for (let x = 0; x < 128; x += 32) {
    if (!checked.some(tile => tile.nodeX >= x && tile.nodeX < x + 32 && tile.nodeZ >= z && tile.nodeZ < z + 32)) result.push(flat(x, z, 32));
    else for (let dz = 0; dz < 32; dz += 8) for (let dx = 0; dx < 32; dx += 8) result.push(byKey.get(`${x + dx},${z + dz}`) ?? flat(x + dx, z + dz, 8));
  }
  return result;
}

export function applyStudioTerrainRows(patches: readonly TerrainTile[], rows: readonly TerrainEditRow[]): TerrainTile[] {
  const next = new Map(validateStudioTerrain(patches).map(tile => [`${tile.nodeX},${tile.nodeZ}`, tile]));
  if (!rows.length || rows.length > 64) throw new Error('Choose a bounded terrain patch.');
  let cells = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    if (!Number.isInteger(row.cellX) || !Number.isInteger(row.cellZ) || !row.heights.length || row.heights.length > 32 || row.heights.length !== row.textures.length) throw new Error('Invalid terrain row.');
    for (let i = 0; i < row.heights.length; i++) {
      if (++cells > 64) throw new Error('Edit at most 64 terrain cells at a time.');
      const { pageX, pageZ, nodeX, nodeZ } = terrainCellPage(row.cellX + i, row.cellZ);
      if (pageX !== 0 || pageZ !== 0) throw new Error('The studio terrain extends from -640 to 640 metres on each axis.');
      const cellKey = `${nodeX},${nodeZ}`;
      if (seen.has(cellKey)) throw new Error('Terrain edits must not overlap.');
      seen.add(cellKey);
      const x = Math.floor(nodeX / 8) * 8, z = Math.floor(nodeZ / 8) * 8, key = `${x},${z}`;
      let tile = next.get(key);
      if (!tile) { tile = { pageX: 0, pageZ: 0, nodeX: x, nodeZ: z, size: 8, heights: Array(64).fill(STUDIO_TERRAIN_HEIGHT), textures: Array(64).fill(0) }; next.set(key, tile); }
      const index = (nodeZ - z) * 8 + nodeX - x;
      tile.heights[index] = row.heights[i]; tile.textures[index] = row.textures[i];
    }
  }
  // Validate before returning; invalid input never mutates the caller's patches.
  return validateStudioTerrain([...next.values()]).filter(tile => !tile.heights.every(height => height === STUDIO_TERRAIN_HEIGHT) || !tile.textures.every(texture => texture === 0));
}
