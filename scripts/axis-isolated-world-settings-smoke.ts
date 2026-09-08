/** Fresh owned servers only; no endpoint/directory/account CLI parameters.
 * Writes each editor field, proves network observation AND fixture persistence,
 * then restores only the exact currently owned values. No retries on ambiguity. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AxisClient } from '../src/main/protocol/axis-client';
import { str } from '../src/main/protocol/codec';
import { P } from '../src/main/protocol/constants';
import type { AxisTransport } from '../src/main/protocol/transport';
import { WORLD_ATTRIBUTE } from '../src/main/protocol/world-settings';
import type { ClientCommand, ClientEvent, WorldSettings } from '../src/shared/types';
import { WORLD_SETTING_FIELDS, worldSettingChanges, worldSettingValuesEqual, type WorldSettingChange, type WorldSettingsSetCommand } from '../src/shared/world-settings-edit';
import { withIsolatedAxis } from './axis-isolated.mjs';
import { decodeWorldAttributeFile, persistedWorldSetting } from './axis-world-settings-audit';
if (process.argv.length !== 2) throw new Error('The isolated world-settings runner accepts no endpoint or directory arguments.');
const root = join(import.meta.dirname, '..'), pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fingerprint() {
  const result: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name); if (entry.isSymbolicLink()) throw new Error('Source fingerprint refuses symlinks.');
      if (entry.isDirectory()) await walk(path); else if (entry.isFile()) result[path.slice(root.length + 1)] = digest(await readFile(path));
    }
  }
  await walk(join(root, 'src')); await walk(join(root, 'scripts'));
  for (const name of ['package.json', 'package-lock.json']) result[name] = digest(await readFile(join(root, name)));
  return result;
}
class Probe {
  readonly events: ClientEvent[] = []; readonly client: AxisClient; session = 0; settings: WorldSettings | null = null;
  constructor(worldPort: number) {
    this.client = new AxisClient(event => {
      this.events.push(event); if (this.events.length > 10_000) throw new Error('World-settings probe event limit.');
      if (event.type === 'login') this.session = event.session; if (event.type === 'world') this.settings = event.settings;
    }, { authorizeWorldConnection: target => assert.deepEqual(target, { host: '127.0.0.1', port: worldPort, tls: false }) });
  }
  command(command: ClientCommand) { return this.client.command(command); }
  draft(changes: WorldSettingChange[]): WorldSettingsSetCommand {
    const settings = this.settings; assert(settings?.editContext);
    return { type: 'world-settings-set', requestId: randomUUID(), world: settings.name, session: this.session, ...settings.editContext, changes };
  }
  async waitFor(predicate: () => boolean, message: string) {
    const until = Date.now() + 15000; while (Date.now() < until) { if (predicate()) return; await pause(20); }
    throw new Error(`Timed out: ${message}`);
  }
  async observe(changes: WorldSettingChange[]) {
    await this.waitFor(() => changes.every(change => worldSettingValuesEqual(change.id, change.value, this.settings?.rawAttributes?.[change.id] ?? '')), 'observer attributes');
  }
}
const sourceBefore = await fingerprint();
await withIsolatedAxis(async fixture => {
  const started = Date.now(), probes = [new Probe(fixture.ports.world), new Probe(fixture.ports.world), new Probe(fixture.ports.world)];
  const [a, b, tourist] = probes, checks: { name: string; elapsedMs: number }[] = [], expectedErrors = new Set<ClientEvent>();
  const path = join(fixture.directory, 'world/data/180f65f02e704b699a42497815a2d8a0/attributes.dat');
  assert.equal(await realpath(path), path); const stat = await lstat(path); assert(stat.isFile() && stat.size < 1_000_000);
  const originalBytes = await readFile(path), originalFile = decodeWorldAttributeFile(originalBytes);
  await writeFile(join(fixture.directory, 'reports/original-world-attributes.dat'), originalBytes, { flag: 'wx', mode: 0o600 });
  const names = new Map(Object.entries(WORLD_ATTRIBUTE).map(([name, id]) => [id as number, name]));
  let originalRaw: Record<number, string> = {}, owned = new Map<number, string>(), uncertain = false, failure: unknown;
  const cleanupFailures: string[] = [];
  fixture.registerCleanup(() => { for (const probe of probes) probe.client.disconnect(); });
  const options = (index: number) => ({ ...fixture.connection, username: fixture.accounts[index].username, password: fixture.accounts[index].password });
  async function check(name: string, action: () => Promise<void>) { await action(); checks.push({ name, elapsedMs: Date.now() - started }); console.log(`PASS ${name}`); }
  async function rejected(probe: Probe, command: ClientCommand, pattern: RegExp) {
    const from = probe.events.length; await assert.rejects(probe.command(command), pattern);
    for (const event of probe.events.slice(from)) if (event.type === 'error' && pattern.test(event.message)) expectedErrors.add(event);
  }
  async function edit(probe: Probe, changes: WorldSettingChange[]) {
    const command = probe.draft(changes); uncertain = true; await probe.command(command);
    const result = probe.events.find(event => event.type === 'world-settings-result' && event.requestId === command.requestId);
    assert(result?.type === 'world-settings-result'); assert.equal(result.status, 'observed'); assert.equal(result.entryId, command.entryId);
    for (const change of changes) { assert(worldSettingValuesEqual(change.id, change.value, probe.settings!.rawAttributes![change.id])); owned.set(change.id, probe.settings!.rawAttributes![change.id]); }
    uncertain = false; await Promise.all([a.observe(changes), b.observe(changes), tourist.observe(changes)]);
  }
  try {
    await check('Two caretakers and a tourist receive separate entry scopes and authoritative rights', async () => {
      await a.command({ type: 'connect', options: options(0) }); await b.command({ type: 'connect', options: options(1) });
      await tourist.command({ type: 'connect', options: { ...fixture.connection, username: 'SettingsVisitor', password: '', tourist: true, email: 'visitor@wayfarer.invalid' } });
      assert.equal(a.settings?.caretaker, true); assert.equal(b.settings?.caretaker, true); assert.equal(tourist.settings?.caretaker, false);
      assert.equal(new Set(probes.map(probe => probe.settings?.editContext?.entryId)).size, 3); originalRaw = { ...a.settings!.rawAttributes! };
      for (const item of WORLD_SETTING_FIELDS) for (const id of item.ids) assert.equal(typeof originalRaw[id], 'string');
    });
    const titleField = WORLD_SETTING_FIELDS.find(item => item.key === 'title')!;
    await check('Single Boolean edits survive the legacy16-byte ambiguity using supported Axis v4 framing', async () => {
      const item = WORLD_SETTING_FIELDS.find(item => item.key === 'allowFlying')!;
      const transport = (a.client as unknown as { world: AxisTransport }).world;
      assert.equal(transport.version, 3, 'Build1682 must begin with the pinned legacy World profile');
      await edit(a, worldSettingChanges(item, 'N', a.settings!.rawAttributes!));
      assert.equal(transport.version, 4, 'A valid v4 mutation must upgrade observed Axis framing');
      await edit(a, worldSettingChanges(item, 'Y', a.settings!.rawAttributes!));
      assert.equal(a.settings?.allowFlying, true); assert.equal(tourist.settings?.allowFlying, true);
    });
    const stale = a.draft(worldSettingChanges(titleField, 'Stale writer must not win', originalRaw));
    await check('Every editor field traverses String packets and full observed broadcast to three clients', async () => {
      const changes = WORLD_SETTING_FIELDS.flatMap(item => {
        let value: string;
        if (item.kind === 'boolean') value = originalRaw[item.ids[0]] === 'Y' ? 'N' : 'Y';
        else if (item.kind === 'color') value = '#234567';
        else if (item.kind === 'integer') value = item.key === 'fogMin' ? '100' : item.key === 'fogMax' ? '900' : '123';
        else if (item.kind === 'float') value = '0.1';
        else if (item.kind === 'object-path') value = `${fixture.objectPath}settings-test/`;
        else if (item.kind === 'entry') value = '1N 2W 0.5a 90';
        else if (item.kind === 'asset') value = item.key.includes('Mask') ? 'mask.png' : 'original-test.rwx';
        else value = item.multiline ? 'Original settings QA\nUnicode: ☀' : 'Wayfarer settings QA';
        const result = worldSettingChanges(item, value, originalRaw); assert(result.length, `${item.key} must actually change`); return result;
      });
      assert.equal(changes.length, 70); await edit(a, changes);
      assert.equal(a.settings?.allowFlying, false); assert.equal(a.settings?.canFly, true);
      assert.equal(tourist.settings?.allowFlying, false); assert.equal(tourist.settings?.canFly, false);
    });
    await check('Independent binary disk audit verifies 70 typed values and preserves every unedited attribute', async () => {
      const disk = decodeWorldAttributeFile(await readFile(path)), changedNames = new Set<string>();
      for (const item of WORLD_SETTING_FIELDS) for (const id of item.ids) {
        const name = names.get(id)!; changedNames.add(name); const entry = disk.get(name); assert(entry, `Missing stored ${name}`);
        assert(worldSettingValuesEqual(id, persistedWorldSetting(entry, item.kind), owned.get(id)!), `Persistence mismatch for ${name}`);
      }
      assert.equal(disk.size, originalFile.size);
      for (const [name, entry] of originalFile) if (!changedNames.has(name)) assert.deepEqual(disk.get(name), entry, `Unedited ${name} changed`);
    });
    await check('Stale revision and exact baseline mismatches fail before dispatch without overwriting', async () => {
      const hash = digest(await readFile(path)); await rejected(a, stale, /changed|stale|revision|baseline/i);
      const mismatch = a.draft([{ id: WORLD_ATTRIBUTE.Title, before: 'not current', value: 'Must not write' }]);
      await rejected(a, mismatch, /changed|stale|revision|baseline/i); assert.equal(digest(await readFile(path)), hash);
    });
    await check('Tourist edits fail locally and the real server silently ignores unauthorized String writes', async () => {
      await rejected(tourist, tourist.draft([{ id: WORLD_ATTRIBUTE.Title, before: tourist.settings!.rawAttributes![WORLD_ATTRIBUTE.Title], value: 'Unauthorized title' }]), /caretaker|permission|allowed/i);
      const hash = digest(await readFile(path)), transport = (tourist.client as unknown as { world: AxisTransport }).world;
      transport.send(P.AttributeChange, [str(WORLD_ATTRIBUTE.Title, 'Unauthorized title')]);
      // Same connection receives a later property-query response, after the
      // fire-and-forget request has reached its serial server handler queue.
      const from = tourist.events.length; await tourist.command({ type: 'query', x: 0, z: 0 });
      await tourist.waitFor(() => tourist.events.slice(from).some(event => event.type === 'query-complete'), 'post-write tourist query barrier');
      assert.equal(digest(await readFile(path)), hash); assert.equal(a.settings!.title, 'Wayfarer settings QA');
    });
    await check('A second caretaker update invalidates the earlier authoring baseline', async () => {
      const old = a.draft(worldSettingChanges(titleField, 'Older draft', a.settings!.rawAttributes!));
      await edit(b, worldSettingChanges(titleField, 'Second caretaker', b.settings!.rawAttributes!));
      await rejected(a, { ...old, revision: a.settings!.editContext!.revision }, /changed|stale|revision|baseline/i);
    });
    await check('Same-world reentry creates a new epoch and refuses the old scoped command', async () => {
      const old = a.draft(worldSettingChanges(titleField, 'Old entry', a.settings!.rawAttributes!));
      await a.command({ type: 'enter', world: fixture.world }); assert.notEqual(a.settings!.editContext!.entryId, old.entryId);
      await rejected(a, { ...old, revision: a.settings!.editContext!.revision }, /entry|scope|stale|changed/i);
      await edit(a, worldSettingChanges(titleField, 'New entry verified', a.settings!.rawAttributes!));
    });
  } catch (cause) { failure = cause; }
  finally {
    try {
      if (uncertain) throw new Error('Uncertain write outcome; restoration deliberately skipped.');
      if (owned.size) {
        const changes: WorldSettingChange[] = [];
        for (const [id, value] of owned) {
          assert.equal(a.settings?.rawAttributes?.[id], value, 'Current author values no longer match this run; no restoration');
          assert.equal(b.settings?.rawAttributes?.[id], value, 'Observer values no longer match this run; no restoration');
          if (!worldSettingValuesEqual(id, value, originalRaw[id])) changes.push({ id, before: value, value: originalRaw[id] });
        }
        await edit(a, changes);
      }
      assert.deepEqual(await readFile(path), originalBytes, 'Restoration must be byte-identical to this fresh fixture, not just visually similar');
      checks.push({ name: 'Exact owned values restored; independent attributes.dat bytes match the fresh seed', elapsedMs: Date.now() - started });
    } catch (cause) { cleanupFailures.push(cause instanceof Error ? cause.message : 'Restoration audit failed'); }
    const unexpectedErrors = probes.flatMap(probe => probe.events.filter(event => event.type === 'error' && !expectedErrors.has(event))).map(event => event.type === 'error' ? event.message : '');
    for (const probe of probes) probe.client.disconnect();
    const sourceAfter = await fingerprint(), changedSourceFiles = [...new Set([...Object.keys(sourceBefore), ...Object.keys(sourceAfter)])].filter(path => sourceBefore[path] !== sourceAfter[path]);
    if (!failure && (cleanupFailures.length || unexpectedErrors.length || changedSourceFiles.length)) failure = new Error('World-settings checkpoint has cleanup, protocol, or source-stability failures.');
    const report = { passed: !failure, timestamp: new Date().toISOString(), directory: fixture.directory, checks, elapsedMs: Date.now() - started,
      originalAttributesSha256: digest(originalBytes), finalAttributesSha256: digest(await readFile(path)), cleanupFailures, unexpectedErrors, sourceFiles: sourceAfter, changedSourceFiles,
      note: 'Fixture disk read proves only this test run; the client reports observation, not durable or atomic acknowledgement.', ...(failure ? { failure: failure instanceof Error ? failure.message : 'Unknown failure' } : {}) };
    await writeFile(join(fixture.directory, 'reports/world-settings-integration.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`Private world-settings report: ${join(fixture.directory, 'reports/world-settings-integration.json')}`);
  }
  if (failure) throw failure; console.log(`All ${checks.length} world-settings checks passed; isolated attribute bytes restored.`);
});
