import type { TerrainTile, WorldObject } from './types';

/** Client support limits, not AW visibility or server-size rules. Text bytes are
 * a deterministic UTF-16 accounting estimate, not exact JavaScript heap usage. */
export const STREAMING_LIMITS = Object.freeze({
  sectorRadius: 2, terrainPageRadius: 1, maxObjects: 12_000,
  maxObjectBytes: 256 * 1024, maxRetainedObjectBytes: 32 * 1024 * 1024,
  maxPendingMutations: 64, maxTerrainNodesPerPage: 256, maxTerrainCellsPerPage: 128 * 128,
});
export const streamKey = (x: number, z: number): string => `${x},${z}`;
export const sectorFromCell = (value: number): number => Math.floor((value + 4) / 8);
export const streamSector = (metres: number): number => sectorFromCell(Math.floor(metres / 10));
export const streamPage = (metres: number): number => Math.floor((metres + 640) / 1280);
export function objectSector(object: WorldObject): { x: number; z: number } {
  return { x: sectorFromCell(object.cellX ?? Math.floor(object.x / 10)), z: sectorFromCell(object.cellZ ?? Math.floor(object.z / 10)) };
}
export function objectStorageBytes(object: WorldObject): number {
  return 256 + 2 * (object.model.length + object.description.length + object.action.length + (object.data?.length ?? 0));
}
export function validStreamTerrain(tile: TerrainTile): boolean {
  const { nodeX, nodeZ, size } = tile;
  return Number.isInteger(nodeX) && Number.isInteger(nodeZ) && Number.isInteger(size)
    && size >= 2 && size <= 128 && (size & (size - 1)) === 0
    && nodeX >= 0 && nodeZ >= 0 && nodeX + size <= 128 && nodeZ + size <= 128
    && [tile.pageX, tile.pageZ].every(Number.isSafeInteger)
    && (tile.heights.length === 1 || tile.heights.length === size * size)
    && (tile.textures.length === 1 || tile.textures.length === size * size);
}
export class StreamingWindow {
  position = { x: 0, z: 0 };
  sector = { x: 0, z: 0 };
  page = { x: 0, z: 0 };
  set(x: number, z: number): void {
    this.position = { x, z };
    this.sector = { x: streamSector(x), z: streamSector(z) };
    this.page = { x: streamPage(x), z: streamPage(z) };
  }
  hasSector(x: number, z: number): boolean {
    return Math.abs(x - this.sector.x) <= STREAMING_LIMITS.sectorRadius && Math.abs(z - this.sector.z) <= STREAMING_LIMITS.sectorRadius;
  }
  hasPage(x: number, z: number): boolean {
    return Math.abs(x - this.page.x) <= STREAMING_LIMITS.terrainPageRadius && Math.abs(z - this.page.z) <= STREAMING_LIMITS.terrainPageRadius;
  }
  objectDistance(object: WorldObject): number {
    const sector = objectSector(object);
    return Math.max(Math.abs(sector.x - this.sector.x), Math.abs(sector.z - this.sector.z));
  }
  pages(): Array<{ pageX: number; pageZ: number }> {
    const pages = [];
    for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) pages.push({ pageX: this.page.x + x, pageZ: this.page.z + z });
    return pages;
  }
}
