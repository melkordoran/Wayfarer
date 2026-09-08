/** Disposable terrain writes only: never accepts a caller-supplied host, account,
 * data directory or PID. All restoration is guarded by the exact owned result. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AxisClient } from '../src/main/protocol/axis-client';
import { blob, field, i32, num } from '../src/main/protocol/codec';
import { P, V } from '../src/main/protocol/constants';
import type { AxisTransport } from '../src/main/protocol/transport';
import type { ClientCommand, ClientEvent, TerrainTile } from '../src/shared/types';
import type { TerrainSetCommand } from '../src/shared/terrain-edit';
import { withIsolatedAxis } from './axis-isolated.mjs';
import { exactOwnedTerrainRestore, sameTestTerrainRow, terrainRowFromTiles, testTerrainPage, testTerrainDatabaseAuditCommand, validateTestTerrainDatabase, type TestTerrainRow } from './axis-isolated-terrain-helpers';

if (process.argv.length !== 2) throw new Error('The isolated terrain runner accepts no external endpoint or data-directory arguments.');
type Event<K extends ClientEvent['type']> = Extract<ClientEvent, { type: K }>;
const root = join(import.meta.dirname, '..'), pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function sourceFingerprint() {
  const files: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Source fingerprints refuse symlinks.');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files[path.slice(root.length + 1)] = digest(await readFile(path));
    }
  }
  await walk(join(root, 'src')); await walk(join(root, 'scripts'));
  for (const name of ['package.json', 'package-lock.json']) files[name] = digest(await readFile(join(root, name)));
  return files;
}
function databaseSnapshot(directory: string) {
  const { args } = testTerrainDatabaseAuditCommand(directory);
  return validateTestTerrainDatabase(JSON.parse(execFileSync('sqlite3', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 })));
}

class TerrainProbe {
  readonly events: ClientEvent[] = [];
  readonly pages = new Map<string, { complete: boolean; sequence: number; tiles: Map<string, TerrainTile> }>();
  readonly client: AxisClient;
  session = 0;
  world = '';
  constructor(worldPort: number) {
    this.client = new AxisClient(event => {
      this.events.push(event);
      if (this.events.length > 10_000) throw new Error('Isolated terrain event budget exceeded');
      if (event.type === 'login') this.session = event.session;
      if (event.type === 'world') this.world = event.settings.name;
      if (event.type === 'stream-unload' && event.session === this.session && event.world === this.world)
        for (const page of event.terrainPages) this.pages.delete(`${page.pageX},${page.pageZ}`);
      if (event.type === 'terrain') {
        const tile = event.tile, key = `${tile.pageX},${tile.pageZ}`;
        const page = this.pages.get(key) ?? { complete: false, sequence: 0, tiles: new Map<string, TerrainTile>() };
        page.complete = false; page.tiles.set(`${tile.nodeX},${tile.nodeZ},${tile.size}`, tile); this.pages.set(key, page);
      }
      if (event.type === 'terrain-page' && event.world === this.world && event.session === this.session) {
        const key = `${event.pageX},${event.pageZ}`, page = this.pages.get(key) ?? { complete: false, sequence: 0, tiles: new Map<string, TerrainTile>() };
        page.complete = event.complete; page.sequence = event.sequence; this.pages.set(key, page);
      }
    }, { authorizeWorldConnection: target => assert.deepEqual(target, { host: '127.0.0.1', port: worldPort, tls: false }, 'Unowned World target refused') });
  }
  command(command: ClientCommand) { return this.client.command(command); }
  latest<K extends ClientEvent['type']>(type: K): Event<K> {
    const event = [...this.events].reverse().find(event => event.type === type);
    assert(event, `Missing ${type} event`); return event as Event<K>;
  }
  row(cellX: number, cellZ: number, count: number): TestTerrainRow | null {
    for (let x = cellX; x < cellX + count; x++) if (!this.pages.get(`${testTerrainPage(x)},${testTerrainPage(cellZ)}`)?.complete) return null;
    return terrainRowFromTiles([...this.pages.values()].filter(page => page.complete).flatMap(page => [...page.tiles.values()]), cellX, cellZ, count);
  }
  async waitFor(predicate: () => boolean, description: string) {
    const until = Date.now() + 15_000;
    while (Date.now() < until) { if (predicate()) return; await pause(20); }
    throw new Error(`Timed out: ${description}; recent events ${this.events.slice(-12).map(event => event.type).join(', ')}`);
  }
  async waitRow(row: TestTerrainRow) {
    await this.waitFor(() => sameTestTerrainRow(this.row(row.cellX, row.cellZ, row.heights.length), row), `canonical terrain row ${row.cellX},${row.cellZ}`);
  }
  rawWorld(): AxisTransport {
    // Test-only access to the transport already authenticated to this fixture.
    // Used solely to prove that the SERVER also rejects the tourist write.
    const transport = (this.client as unknown as { world?: AxisTransport }).world;
    assert(transport, 'The isolated tourist World transport is not entered'); return transport;
  }
}
interface OwnedRow { original: TestTerrainRow; owned: TestTerrainRow; uncertain: boolean }
function mutation(probe: TerrainProbe, before: TestTerrainRow, heights: number[], texture: number): TerrainSetCommand {
  return { type: 'terrain-set', requestId: randomUUID(), world: probe.world, session: probe.session, cellX: before.cellX, cellZ: before.cellZ,
    previousHeights: [...before.heights], previousTextures: [...before.textures], heights: [...heights], texture };
}
// Frozen-tree audit includes preparation/startup, but static imports precede it.
const sourceBefore = await sourceFingerprint();
await withIsolatedAxis(async fixture => {
  const started = Date.now(), a = new TerrainProbe(fixture.ports.world), b = new TerrainProbe(fixture.ports.world), tourist = new TerrainProbe(fixture.ports.world);
  const probes = [a, b, tourist], expectedErrors = new Set<ClientEvent>();
  const checks: Array<{ name: string; elapsedMs: number }> = [], owned: OwnedRow[] = [], cleanupFailures: string[] = [];
  const databaseBefore = databaseSnapshot(fixture.directory);
  let databaseAfter: ReturnType<typeof databaseSnapshot> | undefined, failure: unknown;
  fixture.registerCleanup(() => { for (const probe of probes) probe.client.disconnect(); });
  const options = (index: number) => ({ ...fixture.connection, username: fixture.accounts[index].username, password: fixture.accounts[index].password });
  async function check(name: string, action: () => Promise<void>) { await action(); checks.push({ name, elapsedMs: Date.now() - started }); console.log(`PASS ${name}`); }
  async function rejected(probe: TerrainProbe, command: ClientCommand, pattern: RegExp) {
    const from = probe.events.length;
    await assert.rejects(probe.command(command), pattern);
    for (const event of probe.events.slice(from)) if (event.type === 'error' && pattern.test(event.message)) expectedErrors.add(event);
  }
  async function edit(probe: TerrainProbe, before: TestTerrainRow, heights: number[], texture: number, entry: OwnedRow) {
    const command = mutation(probe, before, heights, texture), expected = { ...before, heights: [...heights], textures: heights.map(() => texture) };
    entry.uncertain = true;
    await probe.command(command);
    const event = probe.events.find(event => event.type === 'terrain-result' && event.requestId === command.requestId) as Event<'terrain-result'> | undefined;
    assert(event, 'A resolved terrain edit must have a correlated result');
    assert.deepEqual({ world: event.world, session: event.session, cellX: event.cellX, cellZ: event.cellZ }, { world: probe.world, session: probe.session, cellX: before.cellX, cellZ: before.cellZ });
    assert.equal(event.status, 'verified', 'Unexpected terrain readback conflict; do not infer write ownership');
    assert.deepEqual(event.heights, expected.heights); assert.deepEqual(event.textures, expected.textures);
    assert(sameTestTerrainRow(probe.row(before.cellX, before.cellZ, heights.length), expected), 'ACK alone must not complete an edit before page readback');
    entry.owned = expected; entry.uncertain = false;
    return expected;
  }
  try {
    assert.equal(databaseBefore.length, 1); assert.deepEqual([databaseBefore[0].pageX, databaseBefore[0].pageZ], [0, 0]);
    assert(databaseBefore.every(page => page.zeroHeights === 1 && page.zeroTextures === 1), 'The fresh seed must contain original zero terrain only');
    await check('Two fresh caretakers receive complete canonical default and stored terrain pages', async () => {
      await a.command({ type: 'connect', options: options(0) }); await b.command({ type: 'connect', options: options(1) });
      for (const probe of [a, b]) {
        assert.equal(probe.latest('world').settings.canEditTerrain, true);
        await probe.waitFor(() => probe.pages.size === 9 && [...probe.pages.values()].every(page => page.complete && page.tiles.size === 16), 'nine authoritative flat terrain pages');
        assert.equal(probe.pages.get('1,1')?.sequence, 0, 'A nonexistent page must be explicitly queried, not fabricated');
      }
    });
    await check('An unchanged sequence-zero query preserves the authoritative default-page baseline', async () => {
      const from = a.events.length;
      await a.command({ type: 'query', x: 0, z: 0 });
      await a.waitFor(() => a.events.slice(from).some(event => event.type === 'terrain-page' && event.pageX === 1 && event.pageZ === 1 && event.complete), 'unchanged default-page query completion');
      assert.equal(a.pages.get('1,1')?.sequence, 0); assert.equal(a.pages.get('1,1')?.tiles.size, 16);
      assert.deepEqual(a.row(64, 64, 3), { cellX: 64, cellZ: 64, heights: [0, 0, 0], textures: [0, 0, 0] });
    });
    for (const spec of [
      { x: 0, z: 0, heights: [1.23, -0.5, 2.34], texture: 65, label: 'Real row edit verifies centimetres, rotated texture and observer refresh' },
      { x: -65, z: 0, heights: [0.11, 0.22, 0.33], texture: 129, label: 'Negative X boundary row commits both centered pages' },
      { x: 63, z: 63, heights: [0.4, 0.5, 0.6], texture: 193, label: 'Positive X boundary row preserves neighboring height cells' },
      { x: 63, z: 64, heights: [-0.4, -0.5, -0.6], texture: 1, label: 'Z boundary selects the next page without changing the adjacent row' },
    ]) await check(spec.label, async () => {
      const original = a.row(spec.x, spec.z, spec.heights.length); assert(original); assert(original.heights.every(height => height === 0) && original.textures.every(texture => texture === 0));
      const entry: OwnedRow = { original, owned: original, uncertain: false }; owned.push(entry);
      const expected = await edit(a, original, spec.heights, spec.texture, entry); await b.waitRow(expected);
      const neighbor = a.row(spec.x, spec.z - 1, spec.heights.length); assert(neighbor);
      if (spec.z !== 64) assert(neighbor.heights.every(height => height === 0), 'A row write must not alter its northern neighbor');
      else assert.deepEqual(neighbor.heights, owned[2].owned.heights, 'The preceding Z page row must retain its earlier verified values');
    });
    await check('A second-citizen revision makes the older baseline fail locally without overwriting it', async () => {
      const entry = owned[0], stale = { ...entry.owned, heights: [...entry.owned.heights], textures: [...entry.owned.textures] };
      const winner = await edit(b, entry.owned, [3.21, 4.32, 5.43], 1, entry); await a.waitRow(winner);
      await rejected(a, mutation(a, stale, [9, 9, 9], 0), /changed|stale|baseline/i);
      assert(sameTestTerrainRow(a.row(0, 0, 3), winner)); assert(sameTestTerrainRow(b.row(0, 0, 3), winner));
    });
    await check('A distant cache eviction rejects unloaded edits and permits an authoritative revisit', async () => {
      const entry = owned[0];
      await a.command({ type: 'move', position: { x: 4000, y: 1.7, z: 4000, yaw: 0 } }); await a.command({ type: 'query', x: 4000, z: 4000 });
      assert.equal(a.row(0, 0, 3), null);
      await rejected(a, mutation(a, entry.owned, [8, 8, 8], 0), /loaded|cached|complete|outside|range/i);
      await a.command({ type: 'move', position: { x: 0, y: 1.7, z: 0, yaw: 0 } }); await a.command({ type: 'query', x: 0, z: 0 });
      for (const row of owned) await a.waitRow(row.owned);
    });
    await check('Tourist local permission denial and real server Unauthorized32 preserve terrain', async () => {
      await tourist.command({ type: 'connect', options: { ...options(0), username: 'TerrainVisitor', password: '', tourist: true, email: 'visitor@wayfarer.invalid' } });
      assert.equal(tourist.latest('world').settings.canEditTerrain, false);
      await tourist.waitRow(owned[0].owned);
      await rejected(tourist, mutation(tourist, owned[0].owned, [7, 7, 7], 0), /right|permission|terrain|allowed/i);
      const heights = Buffer.alloc(12); for (let i = 0; i < 3; i++) heights.writeInt32LE(700, i * 4);
      const from = tourist.events.length;
      const ack = await tourist.rawWorld().request(P.TerrainSet, [i32(V.TerrainX, 0), i32(V.TerrainZ, 0), i32(V.TerrainCount, 3), blob(V.TerrainNodeHeights, heights), i32(V.TerrainNodeTextures, 0)]);
      assert.equal(num(ack, V.ReasonCode), 32); assert.equal(field(ack, V.TerrainNodeX), undefined); assert.equal(field(ack, V.TerrainNodeZ), undefined);
      for (const event of tourist.events.slice(from)) if (event.type === 'error' && /32|authoriz|terrain/i.test(event.message)) expectedErrors.add(event);
      assert(sameTestTerrainRow(b.row(0, 0, 3), owned[0].owned));
    });
  } catch (cause) { failure = cause; }
  finally {
    // No retries after uncertainty. Do not overwrite an unexpected canonical
    // revision merely to make a clean report; retain the fixture for inspection.
    for (const entry of [...owned].reverse()) {
      if (entry.uncertain) { cleanupFailures.push(`Unknown mutation outcome at ${entry.original.cellX},${entry.original.cellZ}; restoration skipped`); continue; }
      const current = b.row(entry.original.cellX, entry.original.cellZ, entry.original.heights.length);
      const original = exactOwnedTerrainRestore(current, entry.owned, entry.original);
      if (!original) { cleanupFailures.push(`Canonical ownership unavailable at ${entry.original.cellX},${entry.original.cellZ}; restoration skipped`); continue; }
      try {
        assert(original.textures.every(texture => texture === original.textures[0]), 'Fixture original row must have one texture');
        await edit(b, current!, original.heights, original.textures[0], entry);
        await a.waitRow(original); await b.waitRow(original);
      } catch (cause) { cleanupFailures.push(`Restoration failed at ${original.cellX},${original.cellZ}: ${cause instanceof Error ? cause.message : 'unknown failure'}`); }
    }
    try {
      databaseAfter = databaseSnapshot(fixture.directory);
      assert(databaseAfter.every(page => page.zeroHeights === 1 && page.zeroTextures === 1), 'Original terrain values were not fully restored');
      if (!cleanupFailures.length && !failure) checks.push({ name: 'Exact owned rows restored; independent SQLite read proves every original terrain value', elapsedMs: Date.now() - started });
    } catch (cause) { cleanupFailures.push(cause instanceof Error ? cause.message : 'Independent terrain restoration check failed'); }
    const unexpectedErrors = probes.flatMap(probe => probe.events.filter(event => event.type === 'error' && !expectedErrors.has(event))).map(event => (event as Event<'error'>).message);
    for (const probe of probes) probe.client.disconnect();
    const sourceAfter = await sourceFingerprint(), changedSourceFiles = [...new Set([...Object.keys(sourceBefore), ...Object.keys(sourceAfter)])].filter(path => sourceBefore[path] !== sourceAfter[path]);
    if (!failure && (cleanupFailures.length || unexpectedErrors.length || changedSourceFiles.length)) failure = new Error('Terrain checkpoint has cleanup, protocol, or source-stability failures; inspect retained report');
    const report = { passed: !failure, timestamp: new Date().toISOString(), elapsedMs: Date.now() - started, checks, directory: fixture.directory,
      restoration: { valuesRestored: !!databaseAfter?.every(page => page.zeroHeights === 1 && page.zeroTextures === 1), databaseBefore, databaseAfter, cleanupFailures,
        note: 'Original values are restored, not database bytes: newly allocated zero pages and advancing sequences are retained.' },
      unexpectedErrors, sourceFiles: sourceAfter, changedSourceFiles, ...(failure ? { failure: failure instanceof Error ? failure.message : String(failure) } : {}) };
    await writeFile(join(fixture.directory, 'reports/terrain-integration.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(`Private terrain report: ${join(fixture.directory, 'reports/terrain-integration.json')}`);
  }
  if (failure) throw failure;
  console.log(`All ${checks.length} isolated terrain checks passed; original terrain values restored.`);
});
