import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxisClient } from '../src/main/protocol/axis-client';
import { AxisTransport } from '../src/main/protocol/transport';
import { blob, encode, i32, num, str, type Field, type Packet } from '../src/main/protocol/codec';
import { P, V } from '../src/main/protocol/constants';
import { defaultWorldSettings } from '../src/main/protocol/world-settings';
import { STREAMING_LIMITS, StreamingWindow, objectStorageBytes, validStreamTerrain } from '../src/shared/streaming';
import type { ClientEvent, WorldObject } from '../src/shared/types';

const clients: AxisClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.disconnect()); vi.restoreAllMocks(); vi.useRealTimers(); });
const object: WorldObject = { id: 1, owner: 3, model: 'bench.rwx', description: '', action: '', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const overrides = (base: Field[], fields: Field[]) => [...new Map([...base, ...fields].map(field => [field.id, field])).values()];
function setup(terrain = false) {
  const events: ClientEvent[] = [], packets: Packet[] = [], client = new AxisClient(event => events.push(event)); clients.push(client);
  const world = new AxisTransport(packet => Reflect.get(client, 'worldPacket').call(client, packet));
  Reflect.set(client, 'world', world); Reflect.set(client, 'worldReady', true); Reflect.set(client, 'session', 41); Reflect.set(client, 'citizen', 3);
  Reflect.set(client, 'settings', { ...defaultWorldSettings('Haven'), terrainEnabled: terrain });
  let propertyReply: ((packet: Packet) => void) | null = () => deliver(P.QueryUpToDate);
  const send = vi.spyOn(world, 'send').mockImplementation((type, fields = []) => {
    const packet = { type, fields, version: 4, flags: 2 }; packets.push(packet);
    if (type === P.Query3X3) propertyReply?.(packet);
  });
  function deliver(type: number, fields: Field[] = []) { Reflect.get(world, 'receive').call(world, encode(type, fields, 4)); }
  function property(id: number, cellX = 0, cellZ = 0, description = '', fields: Field[] = [], type: number = P.ObjectAdd) {
    deliver(type, overrides([i32(V.ObjectId, id), i32(V.ObjectNumber, id + 100), i32(V.CellX, cellX), i32(V.CellZ, cellZ), i32(V.ObjectOwner, 3), str(V.ObjectModel, 'bench.rwx'), str(V.ObjectDescription, description)], fields));
  }
  function cell(cellX: number, cellZ: number, sequence: number, ids: number[]) {
    deliver(P.CellBegin, [i32(V.CellX, cellX), i32(V.CellZ, cellZ), i32(V.CellSequence, sequence)]);
    for (const id of ids) property(id, cellX, cellZ, '', [i32(V.CellSequence, sequence)], P.CellUpdate);
    deliver(P.CellEnd);
  }
  const query = (x: number, z = 0) => client.command({ type: 'query', x, z });
  const objects = () => Reflect.get(client, 'objects') as Map<number, { object: WorldObject; number: number }>;
  const unloads = () => events.filter((event): event is Extract<ClientEvent, { type: 'stream-unload' }> => event.type === 'stream-unload');
  const terrainRequests = () => packets.filter(packet => packet.type === P.TerrainQuery);
  function begin(pageX = 0, pageZ = 0) { deliver(P.TerrainBegin, [i32(V.TerrainPageX, pageX), i32(V.TerrainPageZ, pageZ)]); }
  function tile(pageX = 0, pageZ = 0, nodeX = 0, nodeZ = 0, size = 32, fields: Field[] = []) {
    deliver(P.TerrainData, overrides([i32(V.TerrainPageX, pageX), i32(V.TerrainPageZ, pageZ), i32(V.TerrainNodeX, nodeX), i32(V.TerrainNodeZ, nodeZ), i32(V.TerrainNodeSize, size / 2), i32(V.TerrainNodeHeights, 100), i32(V.TerrainNodeTextures, 0)], fields));
  }
  function end(sequence = 7) { deliver(P.TerrainEnd, [i32(V.TerrainNodeSequence, sequence), i32(V.TerrainComplete, 1)]); }
  function changed(pageX = 0, pageZ = 0) { deliver(P.TerrainChanged, [i32(V.TerrainPageX, pageX), i32(V.TerrainPageZ, pageZ)]); }
  async function drainTerrain() {
    for (let i = 0; i < 40; i++) {
      const current = Reflect.get(client, 'terrainCurrent');
      if (current) { begin(current.pageX, current.pageZ); end(); }
      await flush(); if (!Reflect.get(client, 'terrainRunning')) return;
    }
    throw new Error('Terrain worker did not settle');
  }
  return { client, world, events, packets, send, deliver, property, cell, query, objects, unloads, terrainRequests, begin, tile, end, changed, drainTerrain,
    setPropertyReply: (reply: typeof propertyReply) => { propertyReply = reply; } };
}

describe('bounded property streaming', () => {
  it('unloads distance-evicted IDs without a server-delete event and drops late off-window data', async () => {
    const view = setup(); await view.query(0); view.property(1); view.property(2, 8);
    await view.query(80); expect([...view.objects().keys()]).toEqual([1, 2]);
    view.events.length = 0; await view.query(800);
    expect(view.objects().size).toBe(0);
    expect(view.unloads()).toContainEqual({ type: 'stream-unload', world: 'Haven', session: 41, objectIds: [1, 2], terrainPages: [], reason: 'distance' });
    view.cell(0, 0, 8, [1]); view.property(2, 16);
    expect(view.objects().size).toBe(0); expect(Reflect.get(view.client, 'sectors').has('0,0')).toBe(false);
    expect(view.events.some(event => event.type === 'object-delete')).toBe(false);
  });
  it('fully reloads revisited evicted sectors with sequence zero', async () => {
    const view = setup(); let visits = 0;
    view.setPropertyReply(packet => { if (num(packet, V.SectorX) === 0) { expect(num(packet, 4)).toBe(0); view.cell(0, 0, ++visits, [visits]); } view.deliver(P.QueryUpToDate); });
    await view.query(0); expect(view.objects().has(1)).toBe(true);
    await view.query(800); await view.query(0);
    expect([...view.objects().keys()]).toEqual([2]); expect(visits).toBe(2);
  });
  it('refreshes retained sectors returning to the live zone, including cells now completely empty', async () => {
    const view = setup(); let first = true;
    view.setPropertyReply(packet => { if (first) { view.cell(0, 0, 7, [1]); first = false; } view.deliver(P.QueryUpToDate); });
    await view.query(0); await view.query(160); expect(view.objects().has(1)).toBe(true);
    view.events.length = 0; await view.query(0);
    expect(view.objects().has(1)).toBe(false); expect(num(view.packets.filter(p => p.type === P.Query3X3).at(-1)!, 4)).toBe(0);
    expect(view.unloads().some(event => event.reason === 'refresh' && event.objectIds.includes(1))).toBe(true);
    expect(view.events.some(event => event.type === 'object-delete')).toBe(false);
  });
  it('coalesces rapid travel into one active and one latest pending property query', async () => {
    const view = setup(); view.setPropertyReply(null);
    const promises = [view.query(0)];
    for (let x = 80; x <= 800; x += 80) promises.push(view.query(x));
    expect(view.packets.filter(p => p.type === P.Query3X3)).toHaveLength(1);
    view.cell(0, 0, 9, [1]); view.deliver(P.QueryNeedMore); await flush();
    const queries = view.packets.filter(p => p.type === P.Query3X3); expect(queries).toHaveLength(2); expect(num(queries[1], V.SectorX)).toBe(10);
    expect(view.objects().size).toBe(0); view.deliver(P.QueryUpToDate); await Promise.all(promises);
    expect(view.events.filter(event => event.type === 'query-complete')).toHaveLength(1);
  });
  it('does not run queued old-world work or mutate new caches after disconnect', async () => {
    const view = setup(); view.setPropertyReply(null);
    const pending = [view.query(0).catch(error => error), view.query(800).catch(error => error)];
    view.client.disconnect(); await Promise.all(pending); await flush();
    expect(view.packets.filter(p => p.type === P.Query3X3)).toHaveLength(1); expect(view.objects().size).toBe(0);
    expect(Reflect.get(view.client, 'queryPending')).toBeUndefined(); expect(Reflect.get(view.client, 'queryRunning')).toBeUndefined();
  });
  it('pauses timed-out property chains and ignores late replies until world re-entry', async () => {
    vi.useFakeTimers(); const view = setup(); view.setPropertyReply(null);
    const pending = view.query(0).catch(error => error), queued = view.query(800).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await pending).toBeInstanceOf(Error); expect(await queued).toBeInstanceOf(Error);
    expect(Reflect.get(view.client, 'queryFailed')).toBe(true); expect(Reflect.get(view.client, 'queryPending')).toBeUndefined();
    view.cell(80, 0, 9, [1]); view.deliver(P.QueryUpToDate);
    await expect(view.query(800)).rejects.toThrow('paused until world re-entry');
    expect(view.objects().size).toBe(0); expect(view.packets.filter(packet => packet.type === P.Query3X3)).toHaveLength(1);
    expect(Reflect.get(view.world, 'waiters').size).toBe(0);
    Reflect.get(view.client, 'clearWorld').call(view.client);
    Reflect.set(view.client, 'settings', defaultWorldSettings('Haven')); view.setPropertyReply(() => view.deliver(P.QueryUpToDate));
    await view.query(0); expect(Reflect.get(view.client, 'queryFailed')).toBe(false);
  });
  it('cancels the registered property waiter on send failure and pauses the chain', async () => {
    const view = setup(); view.send.mockImplementation(() => { throw new Error('write failed'); });
    await expect(view.query(0)).rejects.toThrow('write failed');
    expect(Reflect.get(view.world, 'waiters').size).toBe(0);
    await expect(view.query(80)).rejects.toThrow('paused until world re-entry');
    expect(view.send).toHaveBeenCalledTimes(1);
  });
  it('pauses a non-progressing continuation instead of repeatedly requesting the same sectors', async () => {
    const view = setup(); view.setPropertyReply(() => view.deliver(P.QueryNeedMore));
    await expect(view.query(0)).rejects.toThrow('made no progress');
    await expect(view.query(80)).rejects.toThrow('paused until world re-entry');
    expect(view.packets).toHaveLength(1);
  });
  it('bounds count and invalidates the evicted sector without corrupting active continuation progress', async () => {
    const view = setup(); view.setPropertyReply(null); const pending = view.query(0);
    view.deliver(P.CellBegin, [i32(V.CellX, 0), i32(V.CellZ, 0), i32(V.CellSequence, 17)]);
    for (let id = 1; id <= STREAMING_LIMITS.maxObjects + 1; id++) view.property(id, 0, 0, '', [], P.CellUpdate);
    view.deliver(P.CellEnd); view.deliver(P.QueryNeedMore); await flush();
    expect(view.objects().size).toBe(STREAMING_LIMITS.maxObjects);
    expect(num(view.packets.filter(p => p.type === P.Query3X3)[1], 4)).toBe(17);
    expect(Reflect.get(view.client, 'sectors').has('0,0')).toBe(false);
    view.deliver(P.QueryUpToDate); await pending;
    expect(view.unloads().some(event => event.reason === 'budget')).toBe(true);
    expect(view.events.some(event => event.type === 'object-delete')).toBe(false);
  });
  it('bounds retained text bytes and rejects oversized individual records', async () => {
    const view = setup(); await view.query(0);
    const description = 'a'.repeat(120_000);
    for (let id = 1; id <= 142; id++) view.property(id, 0, 0, description);
    const retained = [...view.objects().values()].reduce((sum, record) => sum + objectStorageBytes(record.object), 0);
    expect(retained).toBeLessThanOrEqual(STREAMING_LIMITS.maxRetainedObjectBytes); expect(view.objects().size).toBeLessThan(142);
    expect(Reflect.get(view.client, 'objectBytes')).toBe(retained);
    view.property(999, 0, 0, 'b'.repeat(140_000)); expect(view.objects().has(999)).toBe(false);
    expect(view.events.filter(event => event.type === 'error')).toHaveLength(1);
  });
  it('does not accumulate sequence/cell bookkeeping while traversing hundreds of areas', async () => {
    const view = setup();
    view.setPropertyReply(packet => { const x = num(packet, V.SectorX); view.cell(x * 8, 0, 1, [x + 1]); view.deliver(P.QueryUpToDate); });
    for (let x = 0; x < 150; x++) { await view.query(x * 80); expect(view.objects().size).toBeLessThanOrEqual(5); expect(Reflect.get(view.client, 'sectors').size).toBeLessThanOrEqual(25); }
    expect(Reflect.get(view.client, 'incompleteSectors').size).toBeLessThanOrEqual(25); expect(Reflect.get(view.client, 'liveSectors').size).toBe(9);
  });
});

describe('streaming mutation safety', () => {
  it('retains a pending change through travel, emits canonical result, then unloads the out-of-window object', async () => {
    const view = setup(); await view.query(0); view.property(1);
    const old = view.objects().get(1)!.object;
    const change = view.client.command({ type: 'object-change', object: { ...old, description: 'changed' }, previous: old, requestId: 'pending-edit' });
    const request = view.packets.find(packet => packet.type === P.ObjectChange)!;
    await view.query(800); expect(view.objects().has(1)).toBe(true); view.events.length = 0;
    view.deliver(P.ObjectResult, [i32(V.ObjectCallbackReference, num(request, V.ObjectCallbackReference)), i32(V.ObjectId, 1)]);
    view.property(1, 0, 0, 'canonical', [i32(V.ObjectNumber, num(request, V.ObjectNumber)), i32(V.SessionId, 41)]);
    await change;
    const resultAt = view.events.findIndex(event => event.type === 'object-result'), unloadAt = view.events.findIndex(event => event.type === 'stream-unload');
    expect(resultAt).toBeGreaterThanOrEqual(0); expect(unloadAt).toBeGreaterThan(resultAt); expect(view.objects().has(1)).toBe(false);
    expect(Reflect.get(view.client, 'pendingMutations').size).toBe(0); expect(Reflect.get(view.client, 'pinnedObjects').size).toBe(0);
  });
  it('rejects unloaded or changed delete/change snapshots locally, without number-zero fallback', async () => {
    const view = setup(); await view.query(0); view.property(1); const old = view.objects().get(1)!.object;
    view.property(1, 0, 0, 'changed');
    await expect(view.client.command({ type: 'object-delete', object: old })).rejects.toThrow('changed');
    await view.query(800); view.packets.length = 0;
    await expect(view.client.command({ type: 'object-delete', object: old })).rejects.toThrow('no longer cached');
    await expect(view.client.command({ type: 'object-change', object: old, previous: old })).rejects.toThrow('no longer cached');
    expect(view.packets).toEqual([]);
  });
  it('caps pending mutation references and cleans every pin/waiter on disconnect', async () => {
    const view = setup(); const pending: Promise<unknown>[] = [];
    for (let i = 0; i < STREAMING_LIMITS.maxPendingMutations; i++) pending.push(view.client.command({ type: 'object-add', object: { ...object, id: 0 }, requestId: `add-${i}` }).catch(error => error));
    await expect(view.client.command({ type: 'object-add', object, requestId: 'overflow' })).rejects.toThrow('Too many pending');
    expect(view.packets.filter(p => p.type === P.ObjectAdd)).toHaveLength(64);
    view.client.disconnect(); await Promise.all(pending);
    expect(Reflect.get(view.client, 'pendingMutations').size).toBe(0); expect(Reflect.get(view.client, 'mutationNumbers').size).toBe(0); expect(Reflect.get(view.world, 'waiters').size).toBe(0);
  });
  it('pins a correlated add arriving out of range until its canonical result is emitted', async () => {
    const view = setup(); await view.query(0);
    const added = view.client.command({ type: 'object-add', object: { ...object, id: 0 }, requestId: 'new-offscreen' });
    const request = view.packets.find(packet => packet.type === P.ObjectAdd)!;
    await view.query(800); view.events.length = 0;
    view.property(44, 0, 0, 'canonical add', [i32(V.ObjectNumber, num(request, V.ObjectNumber)), i32(V.SessionId, 41)]);
    expect(view.objects().has(44)).toBe(true);
    view.deliver(P.ObjectResult, [i32(V.ObjectCallbackReference, num(request, V.ObjectCallbackReference)), i32(V.ObjectId, 44)]);
    await added;
    expect(view.events.findIndex(event => event.type === 'object-result')).toBeLessThan(view.events.findIndex(event => event.type === 'stream-unload'));
    expect(view.objects().has(44)).toBe(false); expect(Reflect.get(view.client, 'pinnedObjects').size).toBe(0);
  });
  it('releases out-of-window pins after rejection, preserving legacy ACK-only mutations', async () => {
    const view = setup(); await view.query(0); view.property(1); const old = view.objects().get(1)!.object;
    const rejected = view.client.command({ type: 'object-change', object: old, previous: old, requestId: 'denied' }).catch(error => error);
    const request = view.packets.find(packet => packet.type === P.ObjectChange)!;
    await view.query(800);
    view.deliver(P.ObjectResult, [i32(V.ObjectCallbackReference, num(request, V.ObjectCallbackReference)), i32(V.ReasonCode, 310)]);
    expect(await rejected).toBeInstanceOf(Error); expect(view.objects().size).toBe(0); expect(Reflect.get(view.world, 'waiters').size).toBe(0);
    const legacy = view.client.command({ type: 'object-add', object: { ...object, id: 0 } });
    const add = view.packets.find(packet => packet.type === P.ObjectAdd)!;
    view.deliver(P.ObjectResult, [i32(V.ObjectCallbackReference, num(add, V.ObjectCallbackReference)), i32(V.ObjectId, 55)]);
    await legacy; expect(view.events.some(event => event.type === 'object-result')).toBe(false);
    expect(Reflect.get(view.client, 'pendingMutations').size).toBe(0);
  });
  it('emits reset unload with the old world/session before disconnect clears identity', async () => {
    const view = setup(); view.property(1); view.events.length = 0; view.client.disconnect();
    expect(view.unloads()).toEqual([{ type: 'stream-unload', world: 'Haven', session: 41, objectIds: [1], terrainPages: [], reason: 'reset' }]);
  });
});

describe('bounded serialized terrain streaming', () => {
  it('sends only one terrain request at a time and keeps at most nine page sequences', async () => {
    const view = setup(true); await view.query(0);
    expect(view.terrainRequests()).toHaveLength(1); expect(Reflect.get(view.client, 'terrainPending').size).toBe(8);
    await view.drainTerrain(); expect(view.terrainRequests()).toHaveLength(9);
    expect(Reflect.get(view.client, 'terrainPages').size).toBe(9); expect(Reflect.get(view.client, 'terrainSequences').size).toBe(9);
  });
  it('unloads evicted pages, drops late data, and requests sequence zero on revisit', async () => {
    const view = setup(true); view.changed(); view.begin(); view.tile(); view.end(7); await flush();
    expect(Reflect.get(view.client, 'terrainSequences').get('0,0')).toBe(7);
    view.events.length = 0; await view.query(5000); await view.drainTerrain();
    expect(view.unloads().some(event => event.reason === 'distance' && event.terrainPages.some(page => page.pageX === 0 && page.pageZ === 0))).toBe(true);
    const before = view.events.filter(event => event.type === 'terrain').length; view.tile(); expect(view.events.filter(event => event.type === 'terrain')).toHaveLength(before);
    await view.query(0); await view.drainTerrain();
    const request = view.terrainRequests().filter(packet => num(packet, V.TerrainPageX) === 0 && num(packet, V.TerrainPageZ) === 0).at(-1)!;
    expect(num(request, V.TerrainNodeSequence)).toBe(-1); expect(Reflect.get(view.client, 'terrainPages').size).toBeLessThanOrEqual(9);
  });
  it('does not resurrect an obsolete partial page even if the visitor returns before its old End', async () => {
    const view = setup(true); view.changed(); view.begin(); view.tile();
    await view.query(5000); await view.query(0); view.events.length = 0;
    view.tile(0, 0, 32, 0); view.end(8); await flush();
    expect(view.events.some(event => event.type === 'terrain')).toBe(false);
    await view.drainTerrain();
    const repeated = view.terrainRequests().filter(packet => num(packet, V.TerrainPageX) === 0 && num(packet, V.TerrainPageZ) === 0);
    expect(repeated).toHaveLength(2); expect(num(repeated[1], V.TerrainNodeSequence)).toBe(-1);
  });
  it('clears a changed page before replacement and handles a page becoming completely empty', async () => {
    const view = setup(true); view.changed(); view.begin(); view.tile(); view.end(7); await flush();
    view.events.length = 0; view.changed(); view.begin(); view.tile(0, 0, 32, 0); view.end(8); await flush();
    expect(view.unloads()[0]).toMatchObject({ type: 'stream-unload', reason: 'refresh', terrainPages: [{ pageX: 0, pageZ: 0 }] });
    expect(Reflect.get(view.client, 'terrainPages').get('0,0').nodes.size).toBe(1);
    view.events.length = 0; view.changed(); view.begin(); view.end(0); await flush();
    expect(view.unloads()[0]).toMatchObject({ type: 'stream-unload', reason: 'refresh' }); expect(Reflect.get(view.client, 'terrainPages').get('0,0').nodes.size).toBe(0);
  });
  it('keeps an unchanged cached page when the reply contains no replacement nodes', async () => {
    const view = setup(true); view.changed(); view.begin(); view.tile(); view.end(7); await flush();
    view.events.length = 0; await view.query(0);
    for (let i = 0; i < 9; i++) {
      const request = Reflect.get(view.client, 'terrainCurrent'); view.begin(request.pageX, request.pageZ); view.end(request.key === '0,0' ? 7 : 0); await flush();
    }
    expect(Reflect.get(view.client, 'terrainPages').get('0,0').nodes.size).toBe(1);
    expect(view.unloads().some(event => event.terrainPages.some(page => page.pageX === 0 && page.pageZ === 0))).toBe(false);
  });
  it('bounds per-page node count and does not retain a completion sequence after overflow', async () => {
    const view = setup(true); view.changed(); view.begin();
    for (let i = 0; i < 257; i++) view.tile(0, 0, (i % 64) * 2, Math.floor(i / 64) * 2, 2);
    view.end(77); await flush();
    expect(Reflect.get(view.client, 'terrainPages').get('0,0').nodes.size).toBe(256);
    expect(Reflect.get(view.client, 'terrainSequences').has('0,0')).toBe(false);
    expect(view.events.filter(event => event.type === 'error')).toHaveLength(1);
  });
  it('bounds cumulative node area and rejects out-of-page or oversized sample data', async () => {
    const view = setup(true); view.changed(); view.begin(); view.tile(0, 0, 0, 0, 128); view.tile(0, 0, 2, 2, 2);
    view.tile(0, 0, 120, 120, 32); view.tile(0, 0, 0, 0, 2, [i32(V.TerrainNodeMultipleHeights, 1), blob(V.TerrainNodeHeights, Buffer.alloc(20))]);
    view.end(); await flush();
    expect(Reflect.get(view.client, 'terrainPages').get('0,0').cells).toBe(16384);
    expect(view.events.filter(event => event.type === 'terrain')).toHaveLength(1);
    expect(Reflect.get(view.client, 'terrainSequences').has('0,0')).toBe(false);
  });
  it('ignores off-window terrain-change notifications without scheduling network work', () => {
    const view = setup(true); for (let i = 100; i < 300; i++) view.changed(i, i);
    expect(view.terrainRequests()).toHaveLength(0); expect(Reflect.get(view.client, 'terrainPending').size).toBe(0); expect(Reflect.get(view.client, 'terrainSequences').size).toBe(0);
  });
  it('coalesces terrain changes during an active page and does not adopt its stale sequence', async () => {
    const view = setup(true); view.changed(); view.begin(); view.tile();
    for (let i = 0; i < 100; i++) view.changed();
    expect(Reflect.get(view.client, 'terrainPending').size).toBe(1);
    view.end(7); await flush();
    expect(Reflect.get(view.client, 'terrainSequences').has('0,0')).toBe(false);
    expect(view.terrainRequests()).toHaveLength(2); expect(num(view.terrainRequests()[1], V.TerrainNodeSequence)).toBe(-1);
    view.begin(); view.tile(); view.end(8); await flush();
    expect(Reflect.get(view.client, 'terrainSequences').get('0,0')).toBe(8);
  });
  it('pauses after an unidentifiable End timeout instead of misattributing late packets', async () => {
    vi.useFakeTimers(); const view = setup(true); await view.query(0);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(Reflect.get(view.client, 'terrainFailed')).toBe(true); expect(view.terrainRequests()).toHaveLength(1); expect(Reflect.get(view.client, 'terrainPending').size).toBe(0);
    view.begin(); view.tile(); view.end(); view.changed(); await flush();
    expect(view.terrainRequests()).toHaveLength(1); expect(view.events.filter(event => event.type === 'terrain')).toHaveLength(0);
  });
});

describe('shared streaming limits', () => {
  it('keeps centered sector/page boundaries and actual sub-sector query coordinates', () => {
    const window = new StreamingWindow(); window.set(620, -29);
    expect(window.sector).toEqual({ x: 8, z: 0 }); expect(window.page).toEqual({ x: 0, z: 0 }); expect(window.position.x).toBe(620);
    expect(window.hasSector(10, 2)).toBe(true); expect(window.hasSector(11, 0)).toBe(false); expect(window.pages()).toHaveLength(9);
  });
  it('validates node dimensions and rejects samples beyond the declared area', () => {
    const tile = { pageX: 0, pageZ: 0, nodeX: 0, nodeZ: 0, size: 8, heights: [0], textures: [0] };
    expect(validStreamTerrain(tile)).toBe(true); expect(validStreamTerrain({ ...tile, size: 3 })).toBe(false);
    expect(validStreamTerrain({ ...tile, nodeX: 125 })).toBe(false); expect(validStreamTerrain({ ...tile, heights: Array(65).fill(0) })).toBe(false);
    expect(validStreamTerrain({ ...tile, heights: Array(2).fill(0) })).toBe(false); expect(validStreamTerrain({ ...tile, textures: Array(63).fill(0) })).toBe(false);
    expect(validStreamTerrain({ ...tile, heights: Array(64).fill(0), textures: Array(64).fill(0) })).toBe(true);
  });
});
