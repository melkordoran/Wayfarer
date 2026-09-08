import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxisClient } from '../src/main/protocol/axis-client';
import { AxisTransport } from '../src/main/protocol/transport';
import { blob, encode, i32, num, str, type Field, type Packet } from '../src/main/protocol/codec';
import { P, V } from '../src/main/protocol/constants';
import { assertCommand } from '../src/shared/validation';
import type { ClientCommand, ClientEvent, Position } from '../src/shared/types';

const clients: AxisClient[] = [];
const gestureCommand = { type: 'gesture', gesture: 1, avatar: 7, world: 'Haven', session: 41 } as const;
const position: Position = { x: 1.25, y: -2.5, z: 3.75, yaw: Math.PI / 2, pitch: -Math.PI / 4 };
afterEach(() => { for (const client of clients.splice(0)) client.disconnect(); vi.restoreAllMocks(); vi.useRealTimers(); });

/** Real codec/transport packet dispatcher, but no sockets or fixture accounts. */
function setup() {
  const events: ClientEvent[] = [], requests: Packet[] = [];
  const client = new AxisClient(event => events.push(event)); clients.push(client);
  const transport = new AxisTransport(packet => Reflect.get(client, 'worldPacket').call(client, packet));
  Reflect.set(client, 'world', transport); Reflect.set(client, 'worldReady', true);
  Reflect.set(client, 'settings', Reflect.get(client, 'defaultSettings').call(client, 'Haven'));
  Reflect.set(client, 'session', 41); Reflect.set(client, 'avatarType', 7); Reflect.set(client, 'position', { ...position });
  const send = vi.spyOn(transport, 'send').mockImplementation((type, fields = []) => { requests.push({ type, fields, version: 3, flags: 2 }); });
  const deliver = (session: number, avatar: number, gesture: number) => Reflect.get(transport, 'receive').call(transport,
    encode(P.AvatarChange, [i32(V.AvatarSession, session), i32(V.AvatarType, avatar), i32(V.AvatarGesture, gesture)]));
  return { client, transport, send, requests, events, deliver };
}

describe('guarded explicit gesture state', () => {
  it('sends raw gesture in StateChange without changing avatar or position, and does not invent an ACK', async () => {
    const { client, requests, transport, events } = setup();
    await client.command(gestureCommand);
    expect(requests).toHaveLength(1);
    const request = requests[0]; expect(request.type).toBe(P.StateChange);
    expect([V.AvatarGesture, V.AvatarType, V.AvatarXCoordinate, V.AvatarYCoordinate, V.AvatarZCoordinate, V.AvatarYOrientation, V.AvatarPitch].map(id => num(request, id)))
      .toEqual([1, 7, 125, -250, 375, 900, -450]);
    expect(events).toEqual([{ type: 'local-avatar', avatar: 7, gesture: 1, source: 'submitted' }]);
    expect(Reflect.get(transport, 'waiters').size).toBe(0);
  });

  it('carries gesture through movement and explicitly clears it without switching type', async () => {
    const { client, requests, events } = setup();
    await client.command(gestureCommand);
    await client.command({ type: 'move', position: { ...position, x: 4 } });
    await client.command({ ...gestureCommand, gesture: 0 });
    await client.command({ type: 'move', position });
    expect(requests.map(packet => num(packet, V.AvatarGesture))).toEqual([1, 1, 0, 0]);
    expect(requests.map(packet => num(packet, V.AvatarType))).toEqual([7, 7, 7, 7]);
    expect(num(requests[2], V.AvatarXCoordinate)).toBe(400);
    expect(events).toEqual([
      { type: 'local-avatar', avatar: 7, gesture: 1, source: 'submitted' },
      { type: 'local-avatar', avatar: 7, gesture: 0, source: 'submitted' },
    ]);
  });

  it('does not add a synthetic retrigger bit, neutral packet, or delayed timer on repetition', async () => {
    vi.useFakeTimers();
    const { client, requests, events } = setup();
    await client.command(gestureCommand); await client.command(gestureCommand);
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(events).toEqual([
      { type: 'local-avatar', avatar: 7, gesture: 1, source: 'submitted' },
      { type: 'local-avatar', avatar: 7, gesture: 1, source: 'submitted' },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [{ session: 42 }, 'session changed'],
    [{ avatar: 8 }, 'avatar changed'],
    [{ world: 'Other' }, 'world changed'],
  ] as const)('rejects stale guards %j before writing or changing cached gesture', async (guard, message) => {
    const { client, requests } = setup();
    Reflect.set(client, 'gesture', 2);
    await expect(client.command({ ...gestureCommand, ...guard, gesture: 0 })).rejects.toThrow(message);
    expect(requests).toEqual([]);
    expect(Reflect.get(client, 'gesture')).toBe(2);
    expect(Reflect.get(client, 'avatarType')).toBe(7);
  });

  it('matches canonical world name without case or surrounding-space differences', async () => {
    const { client, requests } = setup();
    await client.command({ ...gestureCommand, world: '  hAvEn  ' });
    expect(requests).toHaveLength(1);
  });

  it.each(['worldReady', 'world', 'settings'] as const)('rejects absent entered-world state %s', async property => {
    const { client, requests } = setup(); Reflect.set(client, property, undefined);
    await expect(client.command(gestureCommand)).rejects.toThrow('Enter a world');
    expect(requests).toEqual([]);
  });

  it('resets latched gesture on leaving while retaining avatar selection as a preference', async () => {
    const { client } = setup(); await client.command(gestureCommand);
    Reflect.get(client, 'clearWorld').call(client);
    expect(Reflect.get(client, 'gesture')).toBe(0);
    expect(Reflect.get(client, 'worldReady')).toBe(false);
    expect(Reflect.get(client, 'avatarType')).toBe(7);
    await expect(client.command({ ...gestureCommand, gesture: 0 })).rejects.toThrow('Enter a world');
  });

  it('does not latch a rejected gesture, avatar selection, or position after a failed send', async () => {
    const { client, send, events } = setup(); Reflect.set(client, 'gesture', 2);
    const commands: ClientCommand[] = [gestureCommand, { type: 'avatar-set', avatar: 8, gesture: 3 }, { type: 'avatar-select', avatar: 8, world: 'Haven', session: 41 }, { type: 'move', position: { ...position, x: 100 } }];
    for (const command of commands) {
      send.mockImplementationOnce(() => { throw new Error('socket unavailable'); });
      await expect(client.command(command)).rejects.toThrow('socket unavailable');
      expect(Reflect.get(client, 'avatarType')).toBe(7);
      expect(Reflect.get(client, 'gesture')).toBe(2);
      expect(Reflect.get(client, 'position')).toEqual(position);
    }
    expect(events.some(event => event.type === 'local-avatar')).toBe(false);
  });

  it('keeps legacy avatar-set callers working and defaults a type change to neutral', async () => {
    const { client, requests, events } = setup();
    await client.command({ type: 'avatar-set', avatar: 9, gesture: 2 });
    await client.command({ type: 'move', position });
    await client.command({ type: 'avatar-set', avatar: 10 });
    expect(requests.map(packet => [num(packet, V.AvatarType), num(packet, V.AvatarGesture)])).toEqual([[9, 2], [9, 2], [10, 0]]);
    expect(events).toEqual([
      { type: 'local-avatar', avatar: 9, gesture: 2, source: 'submitted' },
      { type: 'local-avatar', avatar: 10, gesture: 0, source: 'submitted' },
    ]);
  });

  it('honors a server self-avatar override so a stale completion cannot restore the old type', async () => {
    const { client, deliver, requests, events } = setup();
    deliver(41, 9, 2);
    await expect(client.command({ ...gestureCommand, gesture: 0 })).rejects.toThrow('avatar changed');
    expect(requests).toEqual([]);
    await client.command({ type: 'move', position });
    expect([num(requests[0], V.AvatarType), num(requests[0], V.AvatarGesture)]).toEqual([9, 2]);
    await client.command({ ...gestureCommand, avatar: 9, gesture: 0 });
    expect(events[0]).toEqual({ type: 'local-avatar', avatar: 9, gesture: 2, source: 'server' });
    expect(events[1]).toMatchObject({ type: 'avatar', avatar: { session: 41, type: 9, gesture: 2 } });
  });

  it('forwards repeated remote raw gesture states without mutating local state or fabricating trigger metadata', async () => {
    const { client, deliver, events, requests } = setup();
    deliver(42, 8, 513); deliver(42, 8, 513);
    expect(events).toHaveLength(2); expect(events[1]).toEqual(events[0]);
    expect(events[0]).toMatchObject({ type: 'avatar', avatar: { gesture: 513 } });
    await client.command(gestureCommand);
    expect([num(requests[0], V.AvatarType), num(requests[0], V.AvatarGesture)]).toEqual([7, 1]);
  });
});

describe('scoped avatar selection', () => {
  const select = { type: 'avatar-select', avatar: 9, world: 'Haven', session: 41 } as const;
  it('intentionally changes type and clears gesture, notifying the UI only after dispatch', async () => {
    const { client, requests, events } = setup(); Reflect.set(client, 'gesture', 2);
    await client.command({ ...select, world: ' hAvEn ' });
    expect([num(requests[0], V.AvatarType), num(requests[0], V.AvatarGesture)]).toEqual([9, 0]);
    expect(events).toEqual([{ type: 'local-avatar', avatar: 9, gesture: 0, source: 'submitted' }]);
    await client.command({ type: 'move', position });
    expect([num(requests[1], V.AvatarType), num(requests[1], V.AvatarGesture)]).toEqual([9, 0]);
    expect(events).toHaveLength(1);
  });
  it.each([{ session: 42 }, { world: 'Other' }])('rejects stale selection scope %j without changing cached type', async scope => {
    const { client, requests, events } = setup(); Reflect.set(client, 'gesture', 2);
    await expect(client.command({ ...select, ...scope })).rejects.toThrow('changed');
    expect(requests).toEqual([]); expect(events.some(event => event.type === 'local-avatar')).toBe(false);
    expect(Reflect.get(client, 'avatarType')).toBe(7); expect(Reflect.get(client, 'gesture')).toBe(2);
  });
  it.each(['worldReady', 'world', 'settings'] as const)('requires completed world entry: %s', async property => {
    const { client, requests } = setup(); Reflect.set(client, property, undefined);
    await expect(client.command(select)).rejects.toThrow('Enter a world'); expect(requests).toEqual([]);
  });
  it('accepts selection without any gesture or previous-avatar field', () => {
    expect(() => assertCommand(select)).not.toThrow();
  });
  it.each([
    { avatar: -1 }, { avatar: 1.5 }, { avatar: 65536 }, { avatar: undefined },
    { session: 0 }, { session: 1.5 }, { session: 0x80000000 }, { session: undefined },
    { world: ' ' }, { world: undefined }, { world: 'a'.repeat(65) },
  ])('rejects invalid selection field %j at the renderer boundary', invalid => {
    expect(() => assertCommand({ ...select, ...invalid })).toThrow();
  });
});

describe('gesture renderer boundary', () => {
  it.each([0, 1, 2, 255])('accepts supported outgoing gesture %s with all guards', gesture => {
    expect(() => assertCommand({ ...gestureCommand, gesture })).not.toThrow();
  });
  it.each([
    { gesture: -1 }, { gesture: 256 }, { gesture: 1.5 }, { gesture: NaN }, { gesture: Infinity }, { gesture: undefined },
    { avatar: -1 }, { avatar: 65536 }, { avatar: undefined },
    { session: -1 }, { session: 0 }, { session: 1.5 }, { session: 0x80000000 }, { session: undefined },
    { world: '' }, { world: ' \t ' }, { world: 'a'.repeat(65) }, { world: 'bad\0world' }, { world: undefined },
  ])('rejects invalid or missing field %j', invalid => {
    expect(() => assertCommand({ ...gestureCommand, ...invalid })).toThrow();
  });
});

describe('entry handshake gesture readiness', () => {
  it.each([0, 212])('allows gesture only after an accepted Enter response (reason %s)', async reason => {
    const events: ClientEvent[] = [];
    const client = new AxisClient(event => events.push(event)); clients.push(client);
    Reflect.set(client, 'avatarType', 7); Reflect.set(client, 'gesture', 2);
    const requests: Packet[] = []; let releaseEntry: (() => void) | undefined;
    vi.spyOn(AxisTransport.prototype, 'connect').mockResolvedValue();
    vi.spyOn(AxisTransport.prototype, 'send').mockImplementation(function (this: AxisTransport, type: number, fields: Field[] = []) {
      requests.push({ type, fields, version: 3, flags: 2 });
      const reply = (packetType: number, replyFields: Field[] = []) => Reflect.get(this, 'receive').call(this, encode(packetType, replyFields));
      if (type === P.Login) reply(P.Login, [i32(V.SessionId, 41), i32(V.CitizenNumber, 3), str(V.CitizenName, 'Test Citizen')]);
      else if (type === P.WorldList) reply(P.WorldListResult);
      else if (type === P.WorldLookup) reply(P.WorldLookup, [str(V.WorldName, 'Haven'), blob(V.WorldAddress, Buffer.from([127, 0, 0, 1])), i32(V.WorldPort, 17000)]);
      else if (type === P.Enter) releaseEntry = () => reply(P.Enter, [i32(V.ReasonCode, reason)]);
      else if (type === P.Query3X3) reply(P.QueryUpToDate);
      else if (type !== P.StateChange && type !== P.Listen && type !== P.TerrainQuery) throw new Error(`Unexpected packet ${type}`);
    });
    const connection = client.command({ type: 'connect', options: { host: 'unused.invalid', port: 16670, tls: false, username: 'Test Citizen', password: 'test-only', world: 'Haven' } });
    const outcome = connection.then(() => undefined, error => error as Error);
    await vi.waitFor(() => expect(releaseEntry).toBeDefined());
    await expect(client.command(gestureCommand)).rejects.toThrow('Enter a world');
    expect(requests.some(packet => packet.type === P.StateChange)).toBe(false);
    expect(events.some(event => event.type === 'local-avatar')).toBe(false);
    releaseEntry!();
    if (reason) {
      expect(await outcome).toBeInstanceOf(Error);
      await expect(client.command(gestureCommand)).rejects.toThrow('Enter a world');
      expect(Reflect.get(client, 'worldReady')).toBe(false);
      expect(events.some(event => event.type === 'local-avatar')).toBe(false);
    } else {
      expect(await outcome).toBeUndefined();
      expect(num(requests.find(packet => packet.type === P.StateChange)!, V.AvatarGesture)).toBe(0);
      expect(events.filter(event => event.type === 'local-avatar')).toEqual([{ type: 'local-avatar', avatar: 7, gesture: 0, source: 'submitted' }]);
      await client.command(gestureCommand);
      expect(num(requests.at(-1)!, V.AvatarGesture)).toBe(1);

      await client.command({ type: 'avatar-set', avatar: 9, gesture: 2 });
      client.disconnect(); events.length = 0; releaseEntry = undefined;
      const reconnect = client.command({ type: 'connect', options: { host: 'unused.invalid', port: 16670, tls: false, username: 'Test Citizen', password: 'test-only', world: 'Haven' } });
      await vi.waitFor(() => expect(releaseEntry).toBeDefined());
      expect(events.some(event => event.type === 'local-avatar')).toBe(false);
      (releaseEntry as unknown as () => void)(); await reconnect;
      expect(events.filter(event => event.type === 'local-avatar')).toEqual([{ type: 'local-avatar', avatar: 9, gesture: 0, source: 'submitted' }]);
    }
  });

  it('emits submitted state after the write and cache update, before command resolution', async () => {
    const { client, send } = setup(); const order: string[] = [];
    send.mockImplementation(() => { order.push('write'); });
    Reflect.set(client, 'onEvent', (event: ClientEvent) => {
      if (event.type !== 'local-avatar') return;
      expect(Reflect.get(client, 'avatarType')).toBe(event.avatar);
      expect(Reflect.get(client, 'gesture')).toBe(event.gesture);
      order.push(event.source);
    });
    await client.command({ type: 'avatar-set', avatar: 9, gesture: 2 }).then(() => { order.push('resolved'); });
    expect(order).toEqual(['write', 'submitted', 'resolved']);
  });
});
