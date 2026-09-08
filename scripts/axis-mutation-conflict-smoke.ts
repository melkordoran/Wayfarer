/** Fixture-local optimistic version checks. Uses Explorer and SocialTester only.
 * The last check deliberately simulates delayed client cache delivery; it proves
 * stale-number lookup rejection, NOT atomic database compare-and-swap semantics.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AxisClient } from '../src/main/protocol/axis-client';
import type { ClientEvent, WorldObject } from '../src/shared/types';

const aEvents: ClientEvent[] = [], bEvents: ClientEvent[] = [];
const a = new AxisClient(event => aEvents.push(event)), b = new AxisClient(event => bEvents.push(event));
const base = { host: '127.0.0.1', port: 16670, tls: false, world: 'Haven' };
let current: WorldObject | undefined; const started = Date.now();
const result = (events: ClientEvent[], requestId: string) => {
  const event = events.find((e): e is Extract<ClientEvent, { type: 'object-result' }> => e.type === 'object-result' && e.requestId === requestId);
  assert(event?.object); return event.object;
};
async function waitObject(events: ClientEvent[], description: string): Promise<WorldObject> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const object = events.flatMap(event => event.type === 'objects' ? event.objects : []).find(object => object.description === description);
    if (object) return object;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for actual remote object broadcast');
}
try {
  await a.command({ type: 'connect', options: { ...base, username: 'Explorer', password: 'WayfarerLocal42!' } });
  await b.command({ type: 'connect', options: { ...base, username: 'SocialTester', password: 'SocialTesterLocal42!' } });
  const addId = randomUUID(), original: WorldObject = { id: 0, owner: 4, model: 'column.rwx', description: `Conflict smoke ${randomUUID()}`, action: '', x: 9, y: 0, z: -19, yaw: 0, pitch: 0, roll: 0 };
  await b.command({ type: 'object-add', requestId: addId, object: original }); current = result(bEvents, addId);
  const initial = current, aInitial = await waitObject(aEvents, initial.description);
  // Snapshot of the genuine server-issued prior number for a controlled stale-cache check.
  const oldRecord = { ...Reflect.get(b, 'objects').get(initial.id), object: { ...initial } };
  const changeId = randomUUID();
  await a.command({ type: 'object-change', requestId: changeId, object: { ...aInitial, description: `${initial.description} remote winner`, x: 10.25 }, previous: aInitial });
  current = result(aEvents, changeId); await waitObject(bEvents, current.description);
  await assert.rejects(b.command({ type: 'object-change', requestId: randomUUID(), object: { ...initial, x: 99 }, previous: initial }), /Object changed/);
  console.log('PASS real remote mutation makes stale renderer snapshot fail locally');

  Reflect.get(b, 'objects').set(initial.id, oldRecord); // Emulate an in-flight, not-yet-applied broadcast.
  await assert.rejects(b.command({ type: 'object-change', requestId: randomUUID(), object: { ...initial, x: 99 }, previous: initial }), /Axis 204/);
  console.log('PASS genuine prior ObjectOldNumber/CellX/Z rejected by server after version changed');
  await a.command({ type: 'query', x: current.x, z: current.z });
  const authoritative = Reflect.get(a, 'objects').get(current.id)?.object as WorldObject | undefined;
  assert.equal(authoritative?.x, 10.25); assert.equal(authoritative?.description, current.description);
  console.log('PASS remote winner preserved; neither stale attempt overwrites it');
  console.log(`All 3 conflict checks passed in ${Date.now() - started}ms.`);
} finally {
  if (current) await a.command({ type: 'object-delete', object: current }).catch(() => {});
  a.disconnect(); b.disconnect();
}
