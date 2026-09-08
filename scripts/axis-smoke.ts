import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AxisClient } from '../src/main/protocol/axis-client';
import type { ClientEvent, WorldObject } from '../src/shared/types';

const events: ClientEvent[] = [], observerEvents: ClientEvent[] = [];
const client = new AxisClient(event => events.push(event));
const observer = new AxisClient(event => observerEvents.push(event));
const touristEvents: ClientEvent[] = [];
const tourist = new AxisClient(event => touristEvents.push(event));
const checks: { name: string; elapsedMs: number }[] = [];
const started = Date.now();
let temporary: WorldObject | undefined;
const options = { host: '127.0.0.1', port: 16670, tls: false, username: 'Wayfarer', password: 'WayfarerLocal42!', world: 'Haven' };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T extends ClientEvent>(source: ClientEvent[], predicate: (event: ClientEvent) => event is T, from = 0): Promise<T> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const event = source.slice(from).find(predicate);
    if (event) return event;
    await pause(50);
  }
  throw new Error(`Timed out waiting for protocol event. Recent events: ${JSON.stringify(source.slice(-8))}`);
}
function passed(name: string) { checks.push({ name, elapsedMs: Date.now() - started }); console.log(`PASS ${name}`); }

try {
  await client.command({ type: 'connect', options });
  assert(events.some(e => e.type === 'login' && e.citizen === 2));
  assert(events.some(e => e.type === 'worlds' && e.worlds.some(w => w.name.toLowerCase() === 'haven')));
  const world = events.find(e => e.type === 'world');
  assert(world?.type === 'world' && world.settings.objectPath === 'http://127.0.0.1:17400/');
  passed('Universe login, world listing, nonce-authorized Haven entry and attributes');

  const queried = events.flatMap(e => e.type === 'objects' ? e.objects : []);
  assert(queried.some(object => object.model === 'sculpture.rwx'));
  assert(queried.length >= 32, `Expected 32 fixture objects; received ${queried.length}`);
  passed(`Live property query (${queried.length} objects)`);

  const terrain = await waitFor(events, (e): e is Extract<ClientEvent, { type: 'terrain' }> => e.type === 'terrain');
  assert(terrain.tile.heights.every(height => height === 0));
  assert(terrain.tile.size > 0);
  passed('Live terrain query and height decoding');

  const asset = await fetch('http://127.0.0.1:17400/models/sculpture.rwx');
  assert(asset.ok); assert((await asset.text()).includes('ModelBegin'));
  passed('Original RWX model download from world object path');

  const reentryStart = events.length;
  const destination = { x: 5, y: 1.5, z: -20, yaw: Math.PI / 2 };
  await client.command({ type: 'enter', world: 'Haven', position: destination });
  const teleports = events.slice(reentryStart).filter((e): e is Extract<ClientEvent, { type: 'teleport' }> => e.type === 'teleport');
  assert(teleports.length > 0);
  assert.deepEqual(teleports.at(-1)!.position, destination);
  passed('Custom world-entry destination survives final teleport and property query');

  await observer.command({ type: 'connect', options: { ...options, username: 'Explorer' } });
  await waitFor(observerEvents, (e): e is Extract<ClientEvent, { type: 'avatar' }> => e.type === 'avatar' && e.avatar.citizen === 2);
  passed('Second citizen sees first avatar');

  const message = `Wayfarer integration ${Date.now()}`;
  const chatStart = observerEvents.length;
  await client.command({ type: 'chat', text: message });
  await waitFor(observerEvents, (e): e is Extract<ClientEvent, { type: 'chat' }> => e.type === 'chat' && e.message.text === message, chatStart);
  passed('Chat delivered between real clients');

  const movementStart = observerEvents.length;
  await client.command({ type: 'move', position: { x: 3.25, y: 1.5, z: -21.75, yaw: Math.PI / 2 } });
  const movement = await waitFor(observerEvents, (e): e is Extract<ClientEvent, { type: 'avatar' }> => e.type === 'avatar' && e.avatar.citizen === 2 && Math.abs(e.avatar.x - 3.25) < .02, movementStart);
  assert(Math.abs(movement.avatar.z + 21.75) < .02);
  passed('Avatar position broadcast and centimetre/metre conversion');

  const description = `Temporary smoke object ${Date.now()}`;
  const candidate: WorldObject = { id: 0, owner: 2, model: 'column.rwx', description, action: '', x: 5, y: 0, z: -18, yaw: 0, pitch: 0, roll: 0 };
  const addStart = events.length;
  await client.command({ type: 'object-add', object: candidate });
  const addition = await waitFor(events, (e): e is Extract<ClientEvent, { type: 'objects' }> => e.type === 'objects' && e.objects.some(o => o.description === description), addStart);
  temporary = addition.objects.find(object => object.description === description)!;
  assert(temporary.id > 0);
  passed('Object add acknowledged with persistent server ID');

  const previous = temporary;
  const changed = { ...previous, x: 6.5, description: description + ' edited' };
  const changeStart = observerEvents.length;
  await client.command({ type: 'object-change', object: changed, previous });
  const update = await waitFor(observerEvents, (e): e is Extract<ClientEvent, { type: 'objects' }> => e.type === 'objects' && e.objects.some(o => o.description === changed.description && Math.abs(o.x - 6.5) < .02), changeStart);
  temporary = update.objects.find(object => object.description === changed.description)!;
  await pause(75); // Axis sends Add(new-number) before Delete(old-number) during edits.
  assert(!observerEvents.slice(changeStart).some(e => e.type === 'object-delete' && e.id === temporary!.id), 'Stale old-number deletion must not hide the edited object');
  passed('Object edit persisted and broadcast to observer');

  const deleteStart = observerEvents.length, deletedId = temporary.id;
  await client.command({ type: 'object-delete', object: temporary });
  await waitFor(observerEvents, (e): e is Extract<ClientEvent, { type: 'object-delete' }> => e.type === 'object-delete' && e.id === deletedId, deleteStart);
  temporary = undefined;
  passed('Object delete acknowledged and broadcast; fixture restored');

  const avatarStart = observerEvents.length;
  await client.command({ type: 'disconnect' });
  await waitFor(observerEvents, (e): e is Extract<ClientEvent, { type: 'avatar-delete' }> => e.type === 'avatar-delete', avatarStart);
  passed('Disconnect removes avatar from observer');

  await tourist.command({ type: 'connect', options: { ...options, username: 'Visitor', password: '', tourist: true, email: 'visitor@wayfarer.invalid' } });
  assert(touristEvents.some(e => e.type === 'login' && e.citizen === 0));
  assert(touristEvents.some(e => e.type === 'status' && e.phase === 'online'));
  assert(touristEvents.some(e => e.type === 'objects' && e.objects.length > 0));
  passed('Tourist email login, Haven entry and property query');

  assert.deepEqual([...events, ...observerEvents, ...touristEvents].filter(e => e.type === 'error'), [], 'No unexpected client protocol errors');

  const result = { passed: true, timestamp: new Date().toISOString(), checks, elapsedMs: Date.now() - started };
  await writeFile(join(import.meta.dirname, '..', '.runtime', 'axis', 'smoke-latest.json'), JSON.stringify(result, null, 2));
  console.log(`All ${checks.length} live Axis checks passed in ${result.elapsedMs}ms.`);
} finally {
  if (temporary) await client.command({ type: 'object-delete', object: temporary }).catch(() => {});
  await client.command({ type: 'disconnect' });
  await observer.command({ type: 'disconnect' });
  await tourist.command({ type: 'disconnect' });
}
