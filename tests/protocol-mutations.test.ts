import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxisClient } from '../src/main/protocol/axis-client';
import { AxisTransport } from '../src/main/protocol/transport';
import { blob, encode, i32, num, str, type Field, type Packet } from '../src/main/protocol/codec';
import { P, V } from '../src/main/protocol/constants';
import { assertCommand } from '../src/shared/validation';
import type { ClientEvent, WorldObject } from '../src/shared/types';

const sessions: AxisTransport[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); vi.restoreAllMocks(); });
const object: WorldObject = { id: 0, owner: 99, model: 'requested.rwx', description: 'duplicate', action: 'create color red', x: 1.23456, y: 2, z: -3, yaw: .12345, pitch: .2, roll: .3 };
type Request = { type: number; fields: Field[] };
function setup() {
  const events: ClientEvent[] = [], requests: Request[] = [];
  const client = new AxisClient(event => events.push(event));
  const transport = new AxisTransport(p => Reflect.get(client, 'worldPacket').call(client, p)); sessions.push(transport);
  Reflect.set(client, 'world', transport); Reflect.set(client, 'session', 41); Reflect.set(client, 'citizen', 2);
  vi.spyOn(transport, 'send').mockImplementation((type, fields = []) => { requests.push({ type, fields }); });
  const deliver = (...frames: Buffer[]) => Reflect.get(transport, 'receive').call(transport, Buffer.concat(frames));
  return { events, requests, client, transport, deliver };
}
const requestPacket = (request: Request): Packet => ({ ...request, version: 3, flags: 2 });
function ack(request: Request, id: number, reason = 0) {
  return encode(P.ObjectResult, [i32(V.ReasonCode, reason), i32(V.ObjectId, id), i32(V.ObjectCallbackReference, num(requestPacket(request), V.ObjectCallbackReference))]);
}
function canonical(request: Request, id: number, changes: Field[] = []) {
  return encode(P.ObjectAdd, [
    i32(V.ObjectId, id), i32(V.ObjectNumber, num(requestPacket(request), V.ObjectNumber)), i32(V.SessionId, 41),
    i32(V.CellX, -2), i32(V.CellZ, 3), i32(V.ObjectX, 876), i32(V.ObjectY, 200), i32(V.ObjectZ, 765),
    i32(V.ObjectOwner, 2), i32(V.ObjectYaw, 71), i32(V.ObjectTilt, 115), i32(V.ObjectRoll, 172),
    str(V.ObjectModel, 'canonical.rwx'), str(V.ObjectDescription, 'duplicate'), str(V.ObjectAction, 'create color blue'), blob(V.ObjectData, Buffer.from([1, 2])), ...changes,
  ]);
}

describe('server-authoritative correlated property mutations', () => {
  it.each(['ack-first', 'broadcast-first'])('correlates %s coalesced packets and emits canonical data before command resolves', async order => {
    const { client, requests, events, deliver } = setup();
    const pending = client.command({ type: 'object-add', requestId: 'history-1', object });
    const request = requests[0], frames = [ack(request, 123), canonical(request, 123)];
    deliver(...(order === 'ack-first' ? frames : frames.reverse())); await pending;
    const result = events.find((event): event is Extract<ClientEvent, { type: 'object-result' }> => event.type === 'object-result');
    expect(result).toMatchObject({ requestId: 'history-1', operation: 'add', id: 123, object: { id: 123, owner: 2, model: 'canonical.rwx', action: 'create color blue', x: -11.24, z: 37.65, data: 'AQI=', cellX: -2, cellZ: 3 } });
    expect(result!.object!.yaw).toBeCloseTo(71 * Math.PI / 1800);
    expect(result!.object!.owner).not.toBe(object.owner);
  });
  it('does not confuse simultaneous geometrically identical adds or unrelated broadcasts', async () => {
    const { client, requests, events, deliver } = setup();
    const first = client.command({ type: 'object-add', requestId: 'first', object });
    const second = client.command({ type: 'object-add', requestId: 'second', object });
    expect(num(requestPacket(requests[0]), V.ObjectNumber)).not.toBe(num(requestPacket(requests[1]), V.ObjectNumber));
    const unrelated = { type: P.ObjectAdd, fields: [i32(V.ObjectNumber, 0)] };
    deliver(canonical(unrelated, 999), ack(requests[1], 102), canonical(requests[1], 102), ack(requests[0], 101), canonical(requests[0], 101));
    await Promise.all([first, second]);
    expect(events.filter(e => e.type === 'object-result').map(e => [e.requestId, e.id]).sort()).toEqual([['first', 101], ['second', 102]]);
  });
  it('returns canonical changed objects and accepted delete identities', async () => {
    const { client, requests, events, deliver } = setup();
    const existing = { ...object, id: 7 };
    Reflect.get(client, 'objects').set(7, { object: existing, number: 543, sequence: 0 });
    const change = client.command({ type: 'object-change', requestId: 'change', object: existing, previous: existing });
    expect(num(requestPacket(requests[0]), V.ObjectOldNumber)).toBe(543);
    expect(num(requestPacket(requests[0]), V.ObjectOldX)).toBe(0);
    expect(num(requestPacket(requests[0]), V.ObjectOldZ)).toBe(-1);
    deliver(ack(requests[0], 7), canonical(requests[0], 7)); await change;
    const deletion = client.command({ type: 'object-delete', requestId: 'delete', object: Reflect.get(client, 'objects').get(7).object });
    deliver(ack(requests[1], 7)); await deletion;
    expect(events.filter(e => e.type === 'object-result').map(e => [e.operation, e.id, !!e.object])).toEqual([['change', 7, true], ['delete', 7, false]]);
  });
  it('preserves ACK-only compatibility for callers without requestId', async () => {
    const { client, requests, events, deliver, transport } = setup();
    const pending = client.command({ type: 'object-add', object }); deliver(ack(requests[0], 1)); await pending;
    expect(events.some(e => e.type === 'object-result')).toBe(false);
    expect(Reflect.get(transport, 'waiters').size).toBe(0);
  });
  it('rejects stale renderer snapshots before writing and sends cached prior identity for fresh changes', async () => {
    const { client, requests } = setup();
    const previous = { ...object, id: 7 };
    Reflect.get(client, 'objects').set(7, { object: { ...previous, owner: 4 }, number: 543, sequence: 0 });
    await expect(client.command({ type: 'object-change', object: previous, previous, requestId: 'stale' })).rejects.toThrow('Object changed');
    expect(requests).toHaveLength(0);
    await expect(client.command({ type: 'object-change', object: { ...previous, id: 8 }, previous: { ...previous, id: 8 } })).rejects.toThrow('no longer cached');
    expect(requests).toHaveLength(0);
  });
  it('cleans unused broadcast waiters immediately when an ACK rejects the edit', async () => {
    const { client, requests, events, deliver, transport } = setup();
    const pending = client.command({ type: 'object-add', requestId: 'rejected', object });
    deliver(ack(requests[0], 0, 310)); await expect(pending).rejects.toThrow('No build rights');
    expect(events.some(e => e.type === 'object-result')).toBe(false);
    expect(Reflect.get(transport, 'waiters').size).toBe(0);
  });
  it('rejects an acknowledged ID that disagrees with the correlated broadcast', async () => {
    const { client, requests, events, deliver } = setup();
    const pending = client.command({ type: 'object-add', requestId: 'bad-id', object });
    deliver(ack(requests[0], 1), canonical(requests[0], 2)); await expect(pending).rejects.toThrow('acknowledged ID');
    expect(events.some(e => e.type === 'object-result')).toBe(false);
  });
  it('requires the originating session, and cancels pending mutations on disconnect', async () => {
    const { client, requests, events, deliver } = setup();
    const pending = client.command({ type: 'object-add', requestId: 'disconnect', object });
    // No correct canonical broadcast will follow this successful ACK.
    deliver(ack(requests[0], 1)); client.disconnect(); await expect(pending).rejects.toThrow('Disconnected');
    expect(events.some(e => e.type === 'object-result')).toBe(false);
  });
  it('does not emit a late successful result into a different or disconnected world', async () => {
    const { client, requests, events, deliver } = setup();
    const pending = client.command({ type: 'object-add', requestId: 'old-world', object });
    deliver(ack(requests[0], 1), canonical(requests[0], 1)); client.disconnect();
    await expect(pending).rejects.toThrow('World changed');
    expect(events.some(e => e.type === 'object-result')).toBe(false);
  });
  it('supports explicitly cancelled transport waiters without leaving handlers behind', async () => {
    const { transport } = setup(), controller = new AbortController();
    const pending = transport.waitFor(() => true, 15000, controller.signal); controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(Reflect.get(transport, 'waiters').size).toBe(0);
    await expect(transport.waitFor(() => true, 15000, controller.signal)).rejects.toThrow('cancelled');
  });
  it.each(['', ' ', 'x'.repeat(129), 'bad\0id', 12])('validates request IDs at the renderer boundary', requestId => {
    expect(() => assertCommand({ type: 'object-add', object, requestId })).toThrow('request ID');
  });
});
