import type { TerrainTile } from '../src/shared/types';
import { validStreamTerrain } from '../src/shared/streaming';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { devNull } from 'node:os';
import { assertIsolatedDirectory } from './axis-isolated.mjs';

/** SQL is read-only, not the SQLite filesystem connection: opening a WAL database
 * may create/checkpoint WAL/SHM housekeeping. Never use immutable on a live DB. */
export function testTerrainDatabaseAuditCommand(directory: string) {
  assertIsolatedDirectory(directory);
  let parent = directory;
  for (const name of ['world', 'data', '180f65f02e704b699a42497815a2d8a0']) {
    parent = join(parent, name);
    if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) throw new Error('Terrain audit refuses linked or invalid database parents.');
  }
  const path = join(parent, 'terrain.dat');
  const checkFile = (candidate: string, optional: boolean) => {
    let stat;
    try { stat = lstatSync(candidate); }
    catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || realpathSync(candidate) !== candidate) throw new Error('Terrain audit refuses linked or invalid database files and sidecars.');
  };
  checkFile(path, false);
  for (const suffix of ['-wal', '-shm', '-journal']) checkFile(path + suffix, true);
  const query = 'SELECT instance_id AS instance,page_x AS pageX,page_z AS pageZ,sequence_id AS sequence,length(heights) AS heightBytes,length(textures) AS textureBytes,heights=zeroblob(65536) AS zeroHeights,textures=zeroblob(32768) AS zeroTextures FROM terrain_page ORDER BY page_z,page_x;';
  // -init prevents a personal .sqliterc from changing connection behavior.
  return { path, args: ['-init', devNull, '-bail', '-cmd', 'PRAGMA query_only=ON;', '-json', path, query] };
}

/** Test-side canonical samples. No page may be presumed to exist from a missing
 * node: callers provide only fully received page snapshots. */
export interface TestTerrainRow { cellX: number; cellZ: number; heights: number[]; textures: number[] }
export function testTerrainPage(cell: number): number {
  if (!Number.isSafeInteger(cell) || Math.abs(cell) > 2_000_000) throw new Error('Invalid isolated terrain cell.');
  return Math.floor((cell + 64) / 128);
}
export function terrainRowFromTiles(tiles: readonly TerrainTile[], cellX: number, cellZ: number, count: number): TestTerrainRow | null {
  testTerrainPage(cellX); testTerrainPage(cellZ);
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('Isolated terrain rows contain 1–32 cells.');
  testTerrainPage(cellX + count - 1);
  if (tiles.length > 9 * 256 || tiles.some(tile => !validStreamTerrain(tile))) throw new Error('Invalid isolated terrain snapshot.');
  const heights: number[] = [], textures: number[] = [];
  for (let x = cellX; x < cellX + count; x++) {
    const pageX = testTerrainPage(x), pageZ = testTerrainPage(cellZ);
    const localX = x - (pageX * 128 - 64), localZ = cellZ - (pageZ * 128 - 64);
    const matches = tiles.filter(tile => tile.pageX === pageX && tile.pageZ === pageZ && localX >= tile.nodeX && localZ >= tile.nodeZ && localX < tile.nodeX + tile.size && localZ < tile.nodeZ + tile.size);
    if (!matches.length) return null;
    if (matches.length !== 1) throw new Error('Overlapping terrain nodes cannot establish a baseline.');
    const tile = matches[0], index = (localZ - tile.nodeZ) * tile.size + localX - tile.nodeX;
    const height = tile.heights[tile.heights.length === 1 ? 0 : index], texture = tile.textures[tile.textures.length === 1 ? 0 : index];
    if (!Number.isFinite(height) || Math.abs(height * 100 - Math.round(height * 100)) > 1e-7 || !Number.isInteger(texture) || texture < 0 || texture > 65535)
      throw new Error('Terrain baseline contains invalid centimetres or texture values.');
    heights.push(height); textures.push(texture);
  }
  return { cellX, cellZ, heights, textures };
}
export function sameTestTerrainRow(a: TestTerrainRow | null, b: TestTerrainRow): boolean {
  return !!a && a.cellX === b.cellX && a.cellZ === b.cellZ && a.heights.length === b.heights.length && a.textures.length === b.textures.length
    && a.heights.every((value, index) => value === b.heights[index]) && a.textures.every((value, index) => value === b.textures[index]);
}
/** Refuse a rollback if the canonical row is missing or no longer our own last
 * verified result. Restoration does not authorize overwriting a third revision. */
export function exactOwnedTerrainRestore(current: TestTerrainRow | null, owned: TestTerrainRow, original: TestTerrainRow): TestTerrainRow | null {
  if (!sameTestTerrainRow(current, owned) || original.cellX !== owned.cellX || original.cellZ !== owned.cellZ || original.heights.length !== owned.heights.length || original.textures.length !== owned.textures.length) return null;
  return { ...original, heights: [...original.heights], textures: [...original.textures] };
}

export interface TestTerrainDatabasePage { pageX: number; pageZ: number; sequence: number; heightBytes: number; textureBytes: number; zeroHeights: number; zeroTextures: number; instance: number }
export function validateTestTerrainDatabase(value: unknown): TestTerrainDatabasePage[] {
  if (!Array.isArray(value) || !value.length || value.length > 16) throw new Error('Unexpected isolated terrain page count.');
  const pages: TestTerrainDatabasePage[] = [], keys = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Invalid isolated terrain database page.');
    const page = candidate as TestTerrainDatabasePage, key = `${page.pageX},${page.pageZ}`;
    if (!Number.isSafeInteger(page.pageX) || !Number.isSafeInteger(page.pageZ) || Math.abs(page.pageX) > 1 || Math.abs(page.pageZ) > 1 || keys.has(key)
      || !Number.isSafeInteger(page.sequence) || page.sequence < 1 || page.heightBytes !== 65536 || page.textureBytes !== 32768 || page.instance !== 0
      || ![0, 1].includes(page.zeroHeights) || ![0, 1].includes(page.zeroTextures)) throw new Error('Invalid isolated terrain database page.');
    keys.add(key); pages.push({ ...page });
  }
  return pages;
}
