/** Fresh, disposable Axis end-to-end checks. Never targets the primary fixture.
 * All protocol mutations and telegram collection belong to newly seeded accounts
 * in a newly created fixture. Its lifecycle helper preserves data/logs afterward. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AxisClient } from '../src/main/protocol/axis-client';
import { fetchAsset } from '../src/main/assets';
import { loadAvatarCatalog, loadAvatarRwx, loadAvatarSequence } from '../src/renderer/engine/avatar-assets';
import { CONTACT_OPTIONS, type ClientCommand, type ClientEvent, type ConnectionOptions, type WorldObject } from '../src/shared/types';
import { LOCAL_TELEPORT_DENIED } from '../src/shared/navigation';
import { withIsolatedAxis } from './axis-isolated.mjs';

if (process.argv.slice(2).some(argument => argument !== '--restricted')) throw new Error('Only --restricted is supported by this isolated integration runner.');
const restrictMovement = process.argv.includes('--restricted');

type Of<K extends ClientEvent['type']> = Extract<ClientEvent, { type: K }>;
async function sourceFingerprint() {
  const files: Record<string, string> = {};
  const root = join(import.meta.dirname, '..');
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Source fingerprint does not follow symlinks.');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files[path.slice(root.length + 1)] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await visit(join(root, 'src')); await visit(join(root, 'scripts'));
  for (const name of ['package.json', 'package-lock.json']) files[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
  return files;
}
class Probe {
  events: ClientEvent[] = [];
  objects = new Map<number, WorldObject>();
  session = 0;
  world = '';
  client: AxisClient;
  constructor(worldPort: number) {
    this.client = new AxisClient(event => {
    this.events.push(event);
    if (event.type === 'login') this.session = event.session;
    if (event.type === 'world') this.world = event.settings.name;
    if (event.type === 'objects') {
      if (event.replace) this.objects.clear();
      for (const object of event.objects) this.objects.set(object.id, object);
    } else if (event.type === 'object-delete') this.objects.delete(event.id);
    else if (event.type === 'stream-unload' && event.session === this.session && event.world.trim().toLowerCase() === this.world.trim().toLowerCase()) for (const id of event.objectIds) this.objects.delete(id);
    }, { authorizeWorldConnection(target) {
      assert.deepEqual(target, { host: '127.0.0.1', port: worldPort, tls: false }, 'The isolated probe must never follow an unowned World destination');
    } });
  }
  command(command: ClientCommand) { return this.client.command(command); }
  latest<K extends ClientEvent['type']>(type: K): Of<K> {
    const event = [...this.events].reverse().find(event => event.type === type);
    assert(event, `Missing ${type} event`); return event as Of<K>;
  }
  async wait<K extends ClientEvent['type']>(type: K, predicate: (event: Of<K>) => boolean, from = 0): Promise<Of<K>> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const event = this.events.slice(from).find(event => event.type === type && predicate(event as Of<K>));
      if (event) return event as Of<K>;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${type}; recent event types: ${this.events.slice(-12).map(event => event.type).join(', ')}`);
  }
  mutation(requestId: string): Of<'object-result'> {
    const event = this.events.find(event => event.type === 'object-result' && event.requestId === requestId);
    assert(event, 'Command resolved without a correlated canonical result'); return event as Of<'object-result'>;
  }
  disconnect() { this.client.disconnect(); }
}

// Include preparation/startup in stability checks. Imports have already loaded:
// launch only from a frozen tree; these hashes are not a module attestation.
const sourceBefore = await sourceFingerprint();
await withIsolatedAxis(async fixture => {
  assert.equal(fixture.world, 'Haven');
  assert.equal(fixture.restrictMovement, restrictMovement, 'The requested fixture profile must be explicitly confirmed');
  assert(![16670, 17000, 17400].includes(fixture.ports.universe), 'Primary fixture ports are forbidden');
  const options = (index: number): ConnectionOptions => ({ host: '127.0.0.1', port: fixture.ports.universe, tls: false, world: fixture.world,
    username: fixture.accounts[index].username, password: fixture.accounts[index].password });
  const a = new Probe(fixture.ports.world), b = new Probe(fixture.ports.world), tourist = new Probe(fixture.ports.world), probes = [a, b, tourist];
  const started = Date.now(), checks: Array<{ name: string; elapsedMs: number }> = [];
  const expectedErrors = new Set<ClientEvent>();
  const initialObjects = new Map<number, WorldObject>();
  const temporary = new Map<number, WorldObject>();
  const cleanupFailures: number[] = [];
  let failure: unknown;
  async function check(name: string, action: () => Promise<void> | void) {
    await action(); checks.push({ name, elapsedMs: Date.now() - started }); console.log(`PASS ${name}`);
  }
  const sentPrefix = `Isolated-${randomUUID()}`;
  try {
    await check('Fresh citizen login, discovery, nonce entry and authored environment', async () => {
      await a.command({ type: 'connect', options: options(0) });
      assert.equal(a.latest('login').citizen, fixture.accounts[0].citizen);
      assert(a.latest('worlds').worlds.some(world => world.name === fixture.world));
      assert.equal(a.latest('status').phase, 'online');
      const world = a.latest('world').settings;
      assert.equal(world.objectPath, fixture.objectPath);
      assert.equal(world.fogEnabled, true); assert.equal(world.fogMin, 120); assert.equal(world.fogMax, 350);
      assert.equal(world.fogColor, '#c4d9e3'); assert.equal(world.skyColor, '#6ca4c7');
      assert.equal(world.terrainEnabled, true); assert.equal(world.terrainOffset, 0);
      assert.equal(world.canBuild, true); assert.equal(world.caretaker, true); assert.equal(world.canFly, true);
      assert.equal(world.canTeleport, true);
      assert.equal(world.allowFlying, !fixture.restrictMovement); assert.equal(world.allowTeleport, !fixture.restrictMovement);
      assert.equal(world.rawAttributes?.['74'], undefined); assert.equal(world.rawAttributes?.['153'], undefined);
      assert.equal(a.objects.size, 32, 'Only newly seeded original properties are expected');
      for (const [id, object] of a.objects) initialObjects.set(id, { ...object });
    });
    await check('Real terrain and model data arrive through the advertised object path', async () => {
      const terrain = await a.wait('terrain', event => event.tile.size > 0);
      assert(terrain.tile.heights.every(value => value === 0));
      const asset = await fetchAsset(new URL('models/sculpture.rwx', fixture.objectPath).href);
      assert.match(new TextDecoder().decode(asset.bytes), /ModelBegin[\s\S]+ModelEnd/);
    });
    await check('Real avatar catalog, rigid model and explicit SEQ asset load', async () => {
      const catalog = await loadAvatarCatalog(fixture.objectPath, fetchAsset);
      assert.equal(catalog.entries.length, 2);
      const avatar = catalog.entries.find(entry => entry.geometry && entry.explicit.length)!;
      assert(avatar?.geometry);
      const rig = await loadAvatarRwx(fixture.objectPath, avatar.geometry, fetchAsset);
      assert(rig.joints.size > 0);
      const sequence = await loadAvatarSequence(fixture.objectPath, avatar.explicit[0].sequence, fetchAsset);
      assert(sequence.durationMs > 0); assert(sequence.joints.length > 0);
    });
    await check('Second citizen sees real presence, chat and metre-scale movement', async () => {
      await b.command({ type: 'connect', options: options(1) });
      await b.wait('avatar', event => event.avatar.citizen === fixture.accounts[0].citizen);
      const from = b.events.length;
      await a.command({ type: 'chat', text: sentPrefix });
      await b.wait('chat', event => event.message.text === sentPrefix, from);
      await a.command({ type: 'move', position: { x: 3.25, y: 1.5, z: -21.75, yaw: Math.PI / 2 } });
      const moved = await b.wait('avatar', event => event.avatar.citizen === fixture.accounts[0].citizen && Math.abs(event.avatar.x - 3.25) < .02, from);
      assert(Math.abs(moved.avatar.z + 21.75) < .02);
    });
    await check('Scoped avatar selection and positive/neutral gestures reach the observer', async () => {
      const session = a.latest('login').session, citizen = fixture.accounts[0].citizen;
      let from = b.events.length;
      await a.command({ type: 'avatar-select', avatar: 1, world: fixture.world, session });
      await b.wait('avatar', event => event.avatar.citizen === citizen && event.avatar.type === 1 && event.avatar.gesture === 0, from);
      for (let repeat = 0; repeat < 2; repeat++) {
        from = b.events.length;
        await a.command({ type: 'gesture', gesture: 1, avatar: 1, world: fixture.world, session });
        await b.wait('avatar', event => event.avatar.citizen === citizen && event.avatar.gesture === 1, from);
        from = b.events.length;
        await a.command({ type: 'gesture', gesture: 0, avatar: 1, world: fixture.world, session });
        await b.wait('avatar', event => event.avatar.citizen === citizen && event.avatar.gesture === 0, from);
      }
      // This intentionally waits for each observation; it does not claim that an
      // immediate neutral/positive pair survives Axis update coalescing.
    });
    await check('Concurrent identical adds return distinct canonical objects to both clients', async () => {
      const candidate: WorldObject = { id: 0, owner: 999, model: 'column.rwx', description: `${sentPrefix} object`, action: 'create color blue', x: 8.23456, y: .125, z: -20.34567, yaw: .12345, pitch: .2, roll: .3 };
      const ids = [randomUUID(), randomUUID()], from = b.events.length;
      await Promise.all(ids.map(requestId => a.command({ type: 'object-add', requestId, object: candidate })));
      const objects = ids.map(id => a.mutation(id).object!);
      for (const object of objects) { assert(object?.id > 0); temporary.set(object.id, object); }
      assert.notEqual(objects[0].id, objects[1].id);
      for (const object of objects) {
        assert.equal(object.owner, fixture.accounts[0].citizen); assert.equal(object.x, 8.23); assert.equal(object.z, -20.35);
        await b.wait('objects', event => event.objects.some(value => value.id === object.id && value.description === candidate.description), from);
      }
    });
    await check('Cross-cell edits broadcast canonical state and reject stale renderer snapshots', async () => {
      const previous = [...temporary.values()][0], requestId = randomUUID(), from = a.events.length;
      const observed = b.objects.get(previous.id); assert(observed);
      await b.command({ type: 'object-change', requestId, previous: observed, object: { ...observed, x: -18.7777, z: 27.12345, description: `${sentPrefix} winner`, action: 'create color green' } });
      const changed = b.mutation(requestId).object!; assert(changed);
      temporary.set(changed.id, changed);
      assert.equal(changed.id, previous.id); assert.equal(changed.x, -18.78); assert.equal(changed.z, 27.12);
      assert.equal(changed.cellX, -2); assert.equal(changed.cellZ, 2);
      await a.wait('objects', event => event.objects.some(value => value.id === changed.id && value.description === changed.description), from);
      const errorsFrom = a.events.length;
      await assert.rejects(a.command({ type: 'object-change', requestId: randomUUID(), previous, object: { ...previous, x: 99 } }), /Object changed/);
      const staleErrors = a.events.slice(errorsFrom).filter(event => event.type === 'error' && /Object changed/.test(event.message));
      assert.equal(staleErrors.length, 1); staleErrors.forEach(event => expectedErrors.add(event));
      assert.equal(a.objects.get(changed.id)?.x, changed.x);
    });
    await check('Canonical deletes restore exactly the original 32 properties', async () => {
      for (const object of temporary.values()) {
        const requestId = randomUUID(), from = b.events.length;
        await a.command({ type: 'object-delete', requestId, object });
        assert.equal(a.mutation(requestId).id, object.id);
        await b.wait('object-delete', event => event.id === object.id, from);
      }
      temporary.clear(); assert.equal(a.objects.size, initialObjects.size); assert.equal(b.objects.size, initialObjects.size);
      for (const [id, object] of initialObjects) { assert.deepEqual(a.objects.get(id), object); assert.deepEqual(b.objects.get(id), object); }
    });
    await check('Distant travel unloads local property and terrain; revisits restore canonical snapshots', async () => {
      for (const coordinate of [4000, -4000]) {
        const from = a.events.length;
        await a.command({ type: 'move', position: { x: coordinate, y: 1.7, z: coordinate, yaw: 0 } });
        await a.command({ type: 'query', x: coordinate, z: coordinate });
        assert.equal(a.objects.size, 0, 'Old scene properties must not remain cached at a distant destination');
        await a.wait('stream-unload', event => event.reason === 'distance' && event.objectIds.length === initialObjects.size, from);
        await a.wait('stream-unload', event => event.terrainPages.some(page => page.pageX === 0 && page.pageZ === 0), from);
        assert(!a.events.slice(from).some(event => event.type === 'object-delete'), 'A cache unload must not masquerade as a server deletion');
        const errorsFrom = a.events.length;
        await assert.rejects(a.command({ type: 'object-delete', requestId: randomUUID(), object: [...initialObjects.values()][0] }), /no longer cached|changed/);
        const stale = a.events.slice(errorsFrom).filter(event => event.type === 'error' && /no longer cached|changed/.test(event.message));
        assert.equal(stale.length, 1); stale.forEach(event => expectedErrors.add(event));
        const returning = a.events.length;
        const entry = a.latest('world').settings.entry;
        await a.command({ type: 'move', position: entry });
        await a.command({ type: 'query', x: entry.x, z: entry.z });
        assert.equal(a.objects.size, initialObjects.size);
        for (const [id, object] of initialObjects) { assert.deepEqual(a.objects.get(id), object); assert.deepEqual(b.objects.get(id), object); }
        await a.wait('terrain', event => event.tile.pageX === 0 && event.tile.pageZ === 0, returning);
      }
    });
    await check('Contacts read real presence; telegrams require explicit collection', async () => {
      await a.command({ type: 'contact-change', citizen: 0, options: 0 }); await b.command({ type: 'contact-change', citizen: 0, options: 0 });
      await a.command({ type: 'contact-add', name: fixture.accounts[1].username });
      await b.command({ type: 'contact-add', name: fixture.accounts[0].username });
      assert.equal(a.latest('contacts').contacts.find(value => value.citizen === fixture.accounts[1].citizen)?.state, 'online');
      const from = b.events.length;
      await a.command({ type: 'telegram-send', to: fixture.accounts[1].username, text: `${sentPrefix} mail` });
      await b.wait('telegram-pending', event => event.pending, from);
      assert(!b.events.slice(from).some(event => event.type === 'telegram' && event.message.direction === 'incoming'));
      await b.command({ type: 'telegram-fetch' });
      const received = await b.wait('telegram', event => event.message.direction === 'incoming' && event.message.text === `${sentPrefix} mail`, from);
      assert.equal(received.message.from, fixture.accounts[0].username);
    });
    await check('Telegram privacy blocking is not falsely reported as delivery', async () => {
      await b.command({ type: 'contact-change', citizen: fixture.accounts[0].citizen, options: CONTACT_OPTIONS.telegramOff });
      const from = b.events.length;
      await a.command({ type: 'telegram-send', to: fixture.accounts[1].username, text: `${sentPrefix} blocked` });
      await b.command({ type: 'telegram-fetch' });
      assert(!b.events.slice(from).some(event => event.type === 'telegram' && event.message.direction === 'incoming'));
      assert.equal(a.latest('telegram').message.status, 'submitted');
      await b.command({ type: 'contact-change', citizen: fixture.accounts[0].citizen, options: 0 });
    });
    await check('Fresh reconnect preserves property and updates contact presence', async () => {
      const from = a.events.length; b.disconnect();
      await a.wait('contacts', event => event.contacts.some(value => value.citizen === fixture.accounts[1].citizen && value.state === 'offline'), from);
      await b.command({ type: 'connect', options: options(1) });
      assert.equal(b.latest('status').phase, 'online'); assert.equal(b.objects.size, 32);
      await a.wait('contacts', event => event.contacts.some(value => value.citizen === fixture.accounts[1].citizen && value.state === 'online'), from);
    });
    await check('Unknown-world lookup restores Universe-only state and permits a fresh entry', async () => {
      const from = a.events.length, observerFrom = b.events.length, session = a.latest('login').session;
      await assert.rejects(a.command({ type: 'enter', world: 'MissingIsolatedWorld' }), /Find world/);
      const lookupErrors = a.events.slice(from).filter(event => event.type === 'error' && /Find world/.test(event.message));
      assert.equal(lookupErrors.length, 1); lookupErrors.forEach(event => expectedErrors.add(event));
      assert.equal(a.latest('status').phase, 'connected'); assert.equal(a.objects.size, 0);
      assert.equal(a.latest('login').session, session);
      await b.wait('avatar-delete', event => event.session === session, observerFrom);
      const reentryFrom = b.events.length;
      await a.command({ type: 'enter', world: fixture.world });
      assert.equal(a.latest('status').phase, 'online'); assert.equal(a.objects.size, 32);
      assert.equal(a.latest('login').session, session);
      await b.wait('avatar', event => event.avatar.session === session, reentryFrom);
    });
    await check('Tourist entry and property query use the separate Universe', async () => {
      await tourist.command({ type: 'connect', options: { ...options(0), username: 'IsolatedVisitor', password: '', tourist: true, email: 'visitor@wayfarer.invalid' } });
      assert.equal(tourist.latest('login').citizen, 0); assert.equal(tourist.latest('status').phase, 'online'); assert.equal(tourist.objects.size, 32);
      assert.equal(tourist.latest('world').settings.canFly, !fixture.restrictMovement);
      assert.equal(tourist.latest('world').settings.canTeleport, !fixture.restrictMovement);
    });
    if (fixture.restrictMovement) await check('Restricted tourist entry uses origin and refuses same-world teleport without disconnecting', async () => {
      const landed = tourist.latest('teleport').position;
      assert.equal(landed.x, 0); assert.equal(landed.z, 0);
      const from = tourist.events.length;
      await assert.rejects(tourist.command({ type: 'enter', world: ' hAvEn ', position: { x: 25, y: 40, z: 25, yaw: 1 } }), error => error instanceof Error && error.message === LOCAL_TELEPORT_DENIED);
      const denied = tourist.events.slice(from).filter(event => event.type === 'error' && event.message === LOCAL_TELEPORT_DENIED);
      assert.equal(denied.length, 1); denied.forEach(event => expectedErrors.add(event));
      assert.equal(tourist.latest('status').phase, 'online'); assert.equal(tourist.objects.size, 32);
      assert(!tourist.events.slice(from).some(event => event.type === 'teleport'));
    });
    await check('Citizen exit removes the exact avatar session from the observer', async () => {
      const session = a.latest('login').session, from = b.events.length;
      await a.command({ type: 'disconnect' });
      await b.wait('avatar-delete', event => event.session === session, from);
    });
    const unexpected = probes.flatMap(probe => probe.events.filter(event => event.type === 'error' && !expectedErrors.has(event)));
    assert.deepEqual(unexpected, [], 'Unexpected protocol errors occurred');
  } catch (error) { failure = error; }
  finally {
    // These are exclusively owned disposable-world objects. Revalidate the last
    // canonical snapshot before any attempted cleanup; never remove an unknown ID.
    for (const [id, known] of temporary) {
      const current = b.objects.get(id);
      if (current && JSON.stringify(current) === JSON.stringify(known)) {
        try { await b.command({ type: 'object-delete', requestId: randomUUID(), object: current }); temporary.delete(id); }
        catch { cleanupFailures.push(id); }
      } else cleanupFailures.push(id);
    }
    probes.forEach(probe => probe.disconnect());
    const sourceAfter = await sourceFingerprint();
    const changedSourceFiles = [...new Set([...Object.keys(sourceBefore), ...Object.keys(sourceAfter)])].filter(path => sourceBefore[path] !== sourceAfter[path]);
    if (changedSourceFiles.length && !failure) failure = new Error('Client sources changed during the live run; rerun against a stable source tree.');
    await mkdir(join(fixture.directory, 'reports'), { recursive: true, mode: 0o700 });
    const result = { passed: !failure, timestamp: new Date().toISOString(), checks, elapsedMs: Date.now() - started,
      world: fixture.world, universePort: fixture.ports.universe, objectPath: fixture.objectPath,
      restrictMovement: fixture.restrictMovement,
      remainingTemporaryObjectIds: [...temporary.keys()], cleanupFailures,
      sourceFiles: sourceAfter, changedSourceFiles,
      ...(failure ? { failure: failure instanceof Error ? failure.message : 'Unknown integration failure' } : {}) };
    await writeFile(join(fixture.directory, 'reports', 'integration.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(`Isolated integration report: ${join(fixture.directory, 'reports', 'integration.json')}`);
  }
  if (failure) throw failure;
  console.log(`All ${checks.length} isolated live Axis checks passed in ${Date.now() - started}ms.`);
}, { restrictMovement });
