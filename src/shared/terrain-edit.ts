import type { TerrainTile } from './types';

/** Global 10-metre cells; raw terrain heights exclude WorldSettings.terrainOffset. */
export interface TerrainRegion { cellX: number; cellZ: number; width: number; depth: number }
export interface TerrainCellSample { cellX: number; cellZ: number; height: number | null; texture: number | null }
export interface TerrainEditRow { cellX: number; cellZ: number; heights: number[]; textures: number[] }
export interface TerrainSetCommand {
  type: 'terrain-set'; requestId: string; world: string; session: number;
  cellX: number; cellZ: number; heights: number[]; texture: number;
  previousHeights: number[]; previousTextures: number[];
}
export const TERRAIN_EDIT_LIMITS = Object.freeze({ maxRowCells: 32, maxRegionCells: 64, maxCellCoordinate: 2_147_483 });
/** Reject sub-centimetre input rather than silently rounding authored changes. */
export function terrainCentimetres(height: number): number {
  const centimetres = Math.round(height * 100);
  if (!Number.isFinite(height) || centimetres < -2147483648 || centimetres > 2147483647 || centimetres / 100 !== height)
    throw new Error('Terrain heights must be exact int32 centimetres, expressed in metres.');
  return centimetres;
}
export function terrainCellPage(cellX: number, cellZ: number): { pageX: number; pageZ: number; nodeX: number; nodeZ: number } {
  const pageX = Math.floor((cellX + 64) / 128), pageZ = Math.floor((cellZ + 64) / 128);
  return { pageX, pageZ, nodeX: cellX - pageX * 128 + 64, nodeZ: cellZ - pageZ * 128 + 64 };
}
export function terrainRowPages(cellX: number, cellZ: number, count: number): Array<{ pageX: number; pageZ: number }> {
  const pages = new Map<string, { pageX: number; pageZ: number }>();
  for (let i = 0; i < count; i++) { const { pageX, pageZ } = terrainCellPage(cellX + i, cellZ); pages.set(`${pageX},${pageZ}`, { pageX, pageZ }); }
  return [...pages.values()];
}
/** Fixed 112 KiB/page, separate from scene resources and property accounting. */
export class TerrainPageSamples {
  private heights = new Int32Array(128 * 128);
  private textures = new Uint16Array(128 * 128);
  private known = new Uint8Array(128 * 128);
  write(tile: TerrainTile): void {
    // Caller verifies complete singleton/full-grid arrays and node/page bounds.
    if (!tile.textures.every(texture => Number.isInteger(texture) && texture >= 0 && texture <= 65535)) throw new Error('Invalid uint16 terrain texture');
    for (let z = 0; z < tile.size; z++) for (let x = 0; x < tile.size; x++) {
      const source = z * tile.size + x, target = (tile.nodeZ + z) * 128 + tile.nodeX + x;
      this.heights[target] = terrainCentimetres(tile.heights[tile.heights.length === 1 ? 0 : source]);
      this.textures[target] = tile.textures[tile.textures.length === 1 ? 0 : source]; this.known[target] = 1;
    }
  }
  sample(nodeX: number, nodeZ: number): { height: number; texture: number } | null {
    if (!Number.isInteger(nodeX) || !Number.isInteger(nodeZ) || nodeX < 0 || nodeZ < 0 || nodeX >= 128 || nodeZ >= 128) return null;
    const index = nodeZ * 128 + nodeX;
    return this.known[index] ? { height: this.heights[index] / 100, texture: this.textures[index] } : null;
  }
}
