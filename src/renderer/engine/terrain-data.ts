import type { TerrainTile } from '../../shared/types';
import { TERRAIN_EDIT_LIMITS, TerrainPageSamples, terrainCellPage, terrainCentimetres, type TerrainCellSample, type TerrainEditRow, type TerrainRegion } from '../../shared/terrain-edit';

export const terrainKey = (tile: Pick<TerrainTile, 'pageX' | 'pageZ' | 'nodeX' | 'nodeZ'>) => `${tile.pageX},${tile.pageZ},${tile.nodeX},${tile.nodeZ}`;
export const terrainPageKey = (pageX: number, pageZ: number) => `${pageX},${pageZ}`;
export function validTerrainRegion(region: TerrainRegion): boolean {
  return !!region && Number.isInteger(region.width) && Number.isInteger(region.depth) && region.width >= 1 && region.depth >= 1 && region.width <= 8 && region.depth <= 8
    && [region.cellX, region.cellZ, region.cellX + region.width - 1, region.cellZ + region.depth - 1].every(value => Number.isInteger(value) && Math.abs(value) <= TERRAIN_EDIT_LIMITS.maxCellCoordinate);
}
export function terrainBounds(tile: TerrainTile) {
  const cellX = tile.pageX * 128 + tile.nodeX - 64, cellZ = tile.pageZ * 128 + tile.nodeZ - 64;
  return { cellX, cellZ, right: cellX + tile.size, top: cellZ + tile.size };
}
/** Canonical received samples, distinct from page-completion and preview state. */
export class TerrainData {
  readonly tiles = new Map<string, TerrainTile>();
  private pages = new Map<string, TerrainPageSamples>();
  private complete = new Set<string>();
  put(tile: TerrainTile): boolean {
    if (![tile.pageX, tile.pageZ, tile.nodeX, tile.nodeZ, tile.size].every(Number.isInteger) || tile.size < 1 || tile.size > 128
      || tile.nodeX < 0 || tile.nodeZ < 0 || tile.nodeX + tile.size > 128 || tile.nodeZ + tile.size > 128
      || ![tile.heights.length, tile.textures.length].every(length => length === 1 || length === tile.size * tile.size)
      || !tile.heights.every(Number.isFinite) || !tile.textures.every(value => Number.isInteger(value) && value >= 0 && value <= 65535)) return false;
    try { tile.heights.forEach(terrainCentimetres); } catch { return false; }
    const key = terrainKey(tile), bounds = terrainBounds(tile);
    // The protocol replaces whole pages before repartitioning. Reject accidental
    // overlapping local layers instead of rendering two competing surfaces.
    for (const [otherKey, other] of this.tiles) if (otherKey !== key && other.pageX === tile.pageX && other.pageZ === tile.pageZ) {
      const b = terrainBounds(other);
      if (bounds.cellX < b.right && bounds.right > b.cellX && bounds.cellZ < b.top && bounds.top > b.cellZ) return false;
    }
    this.tiles.set(key, { ...tile, heights: [...tile.heights], textures: [...tile.textures] });
    this.rebuildPage(tile.pageX, tile.pageZ); this.setComplete(tile.pageX, tile.pageZ, false); return true;
  }
  private rebuildPage(pageX: number, pageZ: number) {
    const page = new TerrainPageSamples();
    for (const tile of this.tiles.values()) if (tile.pageX === pageX && tile.pageZ === pageZ) page.write(tile);
    this.pages.set(terrainPageKey(pageX, pageZ), page);
  }
  setComplete(pageX: number, pageZ: number, value: boolean) {
    const key = terrainPageKey(pageX, pageZ);
    if (value && this.pages.has(key)) this.complete.add(key); else this.complete.delete(key);
  }
  deletePages(pages: readonly { pageX: number; pageZ: number }[]) {
    const keys = new Set(pages.map(page => terrainPageKey(page.pageX, page.pageZ)));
    for (const [key, tile] of this.tiles) if (keys.has(terrainPageKey(tile.pageX, tile.pageZ))) this.tiles.delete(key);
    for (const key of keys) { this.pages.delete(key); this.complete.delete(key); }
  }
  clear() { this.tiles.clear(); this.pages.clear(); this.complete.clear(); }
  read(cellX: number, cellZ: number, requireComplete = false): { height: number; texture: number } | null {
    if (!Number.isInteger(cellX) || !Number.isInteger(cellZ)) return null;
    const page = terrainCellPage(cellX, cellZ), key = terrainPageKey(page.pageX, page.pageZ);
    if (requireComplete && !this.complete.has(key)) return null;
    return this.pages.get(key)?.sample(page.nodeX, page.nodeZ) ?? null;
  }
  readonly heightAt = (cellX: number, cellZ: number) => this.read(cellX, cellZ)?.height ?? null;
  sample(region: TerrainRegion): TerrainCellSample[] {
    if (!validTerrainRegion(region)) return [];
    const values: TerrainCellSample[] = [];
    for (let z = 0; z < region.depth; z++) for (let x = 0; x < region.width; x++) {
      const cellX = region.cellX + x, cellZ = region.cellZ + z, sample = this.read(cellX, cellZ, true);
      values.push({ cellX, cellZ, height: sample?.height ?? null, texture: sample?.texture ?? null });
    }
    return values;
  }
  patchedTiles(rows: readonly TerrainEditRow[], region: TerrainRegion): TerrainTile[] | null {
    if (!validTerrainRegion(region) || !rows.length || rows.length > 64) return null;
    const changed = new Map<string, TerrainTile>(), visited = new Set<string>();
    for (const row of rows) {
      if (!Number.isInteger(row.cellX) || !Number.isInteger(row.cellZ) || !row.heights.length || row.heights.length !== row.textures.length || row.heights.length > 8) return null;
      for (let i = 0; i < row.heights.length; i++) {
        const cellX = row.cellX + i, cellZ = row.cellZ, sampleKey = `${cellX},${cellZ}`;
        if (cellX < region.cellX || cellX >= region.cellX + region.width || cellZ < region.cellZ || cellZ >= region.cellZ + region.depth || visited.has(sampleKey) || visited.size >= 64 || !this.read(cellX, cellZ, true)) return null;
        try { terrainCentimetres(row.heights[i]); } catch { return null; }
        const texture = row.textures[i]; if (!Number.isInteger(texture) || texture < 0 || texture > 65535) return null;
        visited.add(sampleKey);
        const owner = [...this.tiles.values()].find(tile => { const b = terrainBounds(tile); return cellX >= b.cellX && cellX < b.right && cellZ >= b.cellZ && cellZ < b.top; });
        if (!owner) return null;
        const key = terrainKey(owner); let clone = changed.get(key);
        if (!clone) {
          clone = { ...owner, heights: Array.from({ length: owner.size * owner.size }, (_, j) => owner.heights[owner.heights.length === 1 ? 0 : j]), textures: Array.from({ length: owner.size * owner.size }, (_, j) => owner.textures[owner.textures.length === 1 ? 0 : j]) };
          changed.set(key, clone);
        }
        const b = terrainBounds(owner), index = (cellZ - b.cellZ) * owner.size + cellX - b.cellX;
        clone.heights[index] = row.heights[i]; clone.textures[index] = texture;
      }
    }
    return [...changed.values()];
  }
}
