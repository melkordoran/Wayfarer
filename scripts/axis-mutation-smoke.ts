/** Fixture-local authoritative history contract check. Temporary objects are restored. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AxisClient } from '../src/main/protocol/axis-client';
import type { ClientEvent, WorldObject } from '../src/shared/types';

const events: ClientEvent[] = [], client = new AxisClient(event => events.push(event));
const temporary = new Map<number, WorldObject>();
const started = Date.now(); let checks = 0;
function result(requestId: string) {
  const result = events.find((event): event is Extract<ClientEvent, { type: 'object-result' }> => event.type === 'object-result' && event.requestId === requestId);
  assert(result, 'The result must be emitted before command resolves'); return result;
}
try {
  await client.command({ type: 'connect', options: { host: '127.0.0.1', port: 16670, tls: false, username: 'Explorer', password: 'WayfarerLocal42!', world: 'Haven' } });
  const original: WorldObject = { id: 0, owner: 999, model: 'column.rwx', description: `Original mutation smoke ${randomUUID()}`, action: 'create color blue', x: 8.23456, y: .125, z: -20.34567, yaw: .12345, pitch: .2, roll: .3 };
  const requests = [randomUUID(), randomUUID()];
  await Promise.all(requests.map(requestId => client.command({ type: 'object-add', requestId, object: original })));
  const added = requests.map(id => result(id).object!);
  for (const object of added) { assert(object?.id); temporary.set(object.id, object); }
  assert.notEqual(added[0].id, added[1].id); assert(added.every(o => o.owner === 3 && o.x === 8.23 && o.z === -20.35 && o.action === 'create color blue'));
  console.log('PASS concurrent identical adds return distinct IDs and canonical server owner/transforms'); checks++;

  const changeId = randomUUID(), previous = added[0];
  await client.command({ type: 'object-change', requestId: changeId, previous, object: { ...previous, x: -18.7777, z: 27.12345, description: 'Canonical changed object', action: 'create color green' } });
  const changed = result(changeId).object!; temporary.set(changed.id, changed);
  assert.equal(changed.id, previous.id); assert.equal(changed.x, -18.78); assert.equal(changed.z, 27.12); assert.equal(changed.action, 'create color green');
  assert.equal(changed.cellX, -2); assert.equal(changed.cellZ, 2);
  console.log('PASS correlated change returns persistent ID and canonical cross-cell data'); checks++;

  for (const object of temporary.values()) {
    const requestId = randomUUID(); await client.command({ type: 'object-delete', requestId, object });
    assert.equal(result(requestId).id, object.id); assert.equal(result(requestId).operation, 'delete');
  }
  temporary.clear(); console.log('PASS correlated deletion ACKs; temporary fixture objects removed'); checks++;
  assert.deepEqual(events.filter(e => e.type === 'error'), []);
  console.log(`All ${checks} mutation checks passed in ${Date.now() - started}ms.`);
} finally {
  for (const object of temporary.values()) await client.command({ type: 'object-delete', object }).catch(() => {});
  client.disconnect();
}
