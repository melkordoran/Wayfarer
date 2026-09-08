import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { devNull } from 'node:os';
import type { TerrainTile } from '../src/shared/types';
import { exactOwnedTerrainRestore, sameTestTerrainRow, terrainRowFromTiles, testTerrainPage, testTerrainDatabaseAuditCommand, validateTestTerrainDatabase } from '../scripts/axis-isolated-terrain-helpers';

const tile = (pageX = 0, pageZ = 0): TerrainTile => ({ pageX, pageZ, nodeX: 0, nodeZ: 0, size: 128, heights: [0], textures: [0] });
const row = { cellX: 0, cellZ: 0, heights: [1, -2, 0.03], textures: [65, 65, 65] };
const page = { pageX: 0, pageZ: 0, sequence: 128, heightBytes: 65536, textureBytes: 32768, zeroHeights: 1, zeroTextures: 1, instance: 0 };

describe('independent isolated terrain integration oracle', () => {
  it.each([[-193, -2], [-192, -1], [-65, -1], [-64, 0], [63, 0], [64, 1], [191, 1], [192, 2]])('maps global cell %i to centered page %i', (cell, expected) => expect(testTerrainPage(cell)).toBe(expected));
  it('does not fabricate zero terrain for an unreceived page', () => expect(terrainRowFromTiles([tile()], 63, 0, 3)).toBeNull());
  it('reads positive and negative X boundaries plus an independent Z boundary', () => {
    expect(terrainRowFromTiles([tile(-1), tile()], -65, 0, 3)).toEqual({ cellX: -65, cellZ: 0, heights: [0, 0, 0], textures: [0, 0, 0] });
    expect(terrainRowFromTiles([tile(0, 1), { ...tile(1, 1), heights: [2.34], textures: [129] }], 63, 64, 3)).toEqual({ cellX: 63, cellZ: 64, heights: [0, 2.34, 2.34], textures: [0, 129, 129] });
  });
  it('samples detailed nodes in Z-major row order independently of texture packing', () => {
    const detailed: TerrainTile = { ...tile(), nodeX: 64, nodeZ: 64, size: 8, heights: Array.from({ length: 64 }, (_, i) => i / 100), textures: [193] };
    expect(terrainRowFromTiles([detailed], 2, 3, 3)).toEqual({ cellX: 2, cellZ: 3, heights: [0.26, 0.27, 0.28], textures: [193, 193, 193] });
  });
  it('rejects overlapping or malformed snapshots, non-centimetre heights and invalid textures', () => {
    for (const tiles of [[tile(), tile()], [{ ...tile(), heights: [0.001] }], [{ ...tile(), textures: [65536] }], [{ ...tile(), size: 127 }]]) expect(() => terrainRowFromTiles(tiles, 0, 0, 1)).toThrow();
  });
  it.each([0, 33, 1.5, NaN])('rejects unsupported row count %s', count => expect(() => terrainRowFromTiles([tile()], 0, 0, count)).toThrow());
  it('restores only a matching owned canonical result and copies the original arrays', () => {
    const original = { ...row, heights: [0, 0, 0], textures: [0, 0, 0] }, restore = exactOwnedTerrainRestore(row, row, original)!;
    expect(restore).toEqual(original); restore.heights[0] = 9; expect(original.heights[0]).toBe(0);
    expect(exactOwnedTerrainRestore(null, row, original)).toBeNull();
    expect(exactOwnedTerrainRestore({ ...row, heights: [9, -2, 0.03] }, row, original)).toBeNull();
    expect(exactOwnedTerrainRestore(row, row, { ...original, cellZ: 1 })).toBeNull();
    expect(sameTestTerrainRow({ ...row, textures: [65, 0, 65] }, row)).toBe(false);
  });
  it('validates independent DB summaries without interpreting advanced sequences as failed restoration', () => {
    expect(validateTestTerrainDatabase([page, { ...page, pageX: 1, sequence: 3 }])).toHaveLength(2);
    for (const value of [[], [page, page], [{ ...page, heightBytes: 4 }], [{ ...page, instance: 1 }], [{ ...page, zeroHeights: 2 }], [{ ...page, pageX: 99 }]]) expect(() => validateTestTerrainDatabase(value)).toThrow();
  });
});

describe('disposable terrain database query safeguards', () => {
  const runtime = resolve(import.meta.dirname, '../.runtime');
  const fresh = () => {
    const directory = mkdtempSync(join(runtime, 'axis-isolated-'));
    const parent = join(directory, 'world/data/180f65f02e704b699a42497815a2d8a0');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    return { directory, parent, path: join(parent, 'terrain.dat') };
  };
  // All tiny test fixtures remain retained. These tests never start Axis.
  it('reads a fresh WAL-mode database while SQL writes remain disabled', () => {
    const { directory, path } = fresh();
    execFileSync('sqlite3', ['-init', devNull, path, 'PRAGMA journal_mode=WAL; CREATE TABLE terrain_page(instance_id,page_x,page_z,sequence_id,heights,textures); INSERT INTO terrain_page VALUES(0,0,0,128,zeroblob(65536),zeroblob(32768));']);
    const command = testTerrainDatabaseAuditCommand(directory);
    expect(command.args).not.toContain('-readonly');
    expect(command.args).toContain('PRAGMA query_only=ON;');
    const execute = (args: string[]) => execFileSync('sqlite3', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(validateTestTerrainDatabase(JSON.parse(execute(command.args)))).toEqual([page]);
    const writeArgs = [...command.args]; writeArgs[writeArgs.length - 1] = 'UPDATE terrain_page SET sequence_id=999;';
    expect(() => execute(writeArgs)).toThrow(/readonly database/);
    expect(validateTestTerrainDatabase(JSON.parse(execute(command.args)))).toEqual([page]);
  });
  it.each(['-wal', '-shm', '-journal', ''])('rejects a linked database or sidecar %s before invoking SQLite', suffix => {
    const { directory, parent, path } = fresh();
    const target = join(parent, 'unrelated-file'); writeFileSync(target, 'retained', { mode: 0o600, flag: 'wx' });
    if (suffix) writeFileSync(path, 'test', { mode: 0o600, flag: 'wx' });
    symlinkSync(target, path + suffix);
    expect(() => testTerrainDatabaseAuditCommand(directory)).toThrow(/linked/);
  });
  it('rejects a linked parent and primary/broad directory before opening anything', () => {
    const directory = mkdtempSync(join(runtime, 'axis-isolated-')), other = fresh();
    symlinkSync(join(other.directory, 'world'), join(directory, 'world'));
    expect(() => testTerrainDatabaseAuditCommand(directory)).toThrow(/linked/);
    for (const path of [runtime, join(runtime, 'axis'), resolve(runtime, '..')]) expect(() => testTerrainDatabaseAuditCommand(path)).toThrow();
  });
});
