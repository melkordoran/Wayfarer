import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxisClient } from '../src/main/protocol/axis-client';
import { AxisTransport } from '../src/main/protocol/transport';
import { blob, encode, i32, num, str, string, type Field, type Packet } from '../src/main/protocol/codec';
import { P, V } from '../src/main/protocol/constants';
import { WORLD_ATTRIBUTE as A, WORLD_CAPABILITY as C } from '../src/main/protocol/world-settings';
import { assertCommand } from '../src/shared/validation';
import type { ClientCommand, ClientEvent } from '../src/shared/types';

const clients: AxisClient[] = [];
const destination = { x: 80, y: 99, z: -130, yaw: 1.7, pitch: 0.3 };
afterEach(() => { clients.splice(0).forEach(client => client.disconnect()); vi.restoreAllMocks(); });

/** Real packet codec and dispatcher; scripted protocol peers, never sockets. */
async function setup(allow = false, caretaker = false, deferPermissions = false) {
  const events: ClientEvent[] = [], requests: Packet[] = [];
  const client = new AxisClient(event => events.push(event)); clients.push(client);
  const connect = vi.spyOn(AxisTransport.prototype, 'connect').mockResolvedValue();
  vi.spyOn(AxisTransport.prototype, 'send').mockImplementation(function (this: AxisTransport, type, fields = []) {
    requests.push({ type, fields, version: 3, flags: 2 });
    const reply = (packet: number, data: Field[] = []) => Reflect.get(this, 'receive').call(this, encode(packet, data, 4));
    if (type === P.Login) reply(P.Login, [i32(V.SessionId, 41), i32(V.CitizenNumber, 3), str(V.CitizenName, 'Test')]);
    else if (type === P.WorldList) reply(P.WorldListResult);
    else if (type === P.WorldLookup) reply(P.WorldLookup, [str(V.WorldName, string({ fields } as Packet, V.WorldName)), blob(V.WorldAddress, Buffer.from([127, 0, 0, 1])), i32(V.WorldPort, 17000)]);
    else if (type === P.Enter) {
      reply(P.Attributes, [...(deferPermissions ? [] : [str(A.AllowTeleport, allow ? 'Y' : 'N')]), str(A.EntryPoint, '3N 4W 2A 90'), str(A.EnableTerrain, 'N')]);
      if (!deferPermissions) reply(P.Capabilities, [str(C.Caretaker, caretaker ? 'Y' : 'N')]);
      reply(P.Enter);
    } else if (type === P.Query3X3) reply(P.QueryUpToDate);
    else if (![P.StateChange, P.Listen, P.TerrainQuery].includes(type as never)) throw new Error(`Unexpected packet ${type}`);
  });
  await client.command({ type: 'connect', options: { host: 'unused.invalid', port: 16670, tls: false, username: 'Test', password: 'test-only', world: 'Haven' } });
  const deliver = (type: number, fields: Field[]) => Reflect.get(Reflect.get(client, 'world'), 'receive').call(Reflect.get(client, 'world'), encode(type, fields, 4));
  return { client, events, requests, connect, deliver };
}

describe('manual and authored world navigation', () => {
  it.each(['Haven', '  hAvEn  '])('rejects same-world manual entry %s before disconnecting or looking up the world', async world => {
    const { client, requests, events } = await setup(); const socket = Reflect.get(client, 'world'), close = vi.spyOn(socket, 'close');
    requests.length = 0; events.length = 0;
    await expect(client.command({ type: 'enter', world, position: destination })).rejects.toThrow('Local teleporting is disabled');
    expect(requests).toEqual([]); expect(close).not.toHaveBeenCalled(); expect(Reflect.get(client, 'worldReady')).toBe(true);
    expect(events.every(event => event.type === 'error')).toBe(true);
  });
  it('also rejects same-world manual re-entry without coordinates', async () => {
    const { client, requests } = await setup(); requests.length = 0;
    await expect(client.command({ type: 'enter', world: 'Haven' })).rejects.toThrow('Local teleporting is disabled');
    expect(requests).toEqual([]);
  });
  it.each([undefined, destination])('allows cross-world manual entry but forces horizontal origin regardless of requested coordinates %j', async position => {
    const { client, events, requests } = await setup(); events.length = 0; requests.length = 0;
    await client.command({ type: 'enter', world: 'Other', position });
    expect(events).toContainEqual({ type: 'teleport', position: { x: 0, y: 20, z: 0, yaw: Math.PI / 2 } });
    const movement = requests.find(packet => packet.type === P.StateChange)!;
    expect([V.AvatarXCoordinate, V.AvatarYCoordinate, V.AvatarZCoordinate, V.AvatarYOrientation].map(id => num(movement, id))).toEqual([0, 2000, 0, 900]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', phase: 'online' }));
  });
  it('applies the same forced origin on initial connection and keeps authored altitude/heading as an explicit client policy', async () => {
    const { events } = await setup(); expect(events).toContainEqual({ type: 'teleport', position: { x: 0, y: 20, z: 0, yaw: Math.PI / 2 } });
  });
  it('fails closed for missing/out-of-order permission packets and applies later authoritative permission without jumping', async () => {
    const { client, deliver, events } = await setup(true, false, true);
    expect(events.filter(event => event.type === 'world').every(event => event.settings.canTeleport === false)).toBe(true);
    expect(events).toContainEqual({ type: 'teleport', position: { x: 0, y: 20, z: 0, yaw: Math.PI / 2 } });
    await expect(client.command({ type: 'enter', world: 'Haven', position: destination })).rejects.toThrow('Local teleporting is disabled');
    deliver(P.AttributeChange, [str(A.AllowTeleport, 'maybe')]); expect(Reflect.get(client, 'settings').canTeleport).toBe(false);
    events.length = 0;
    deliver(P.AttributeChange, [str(A.AllowTeleport, 'Y')]); expect(Reflect.get(client, 'settings').canTeleport).toBe(true);
    expect(events.some(event => event.type === 'teleport')).toBe(false);
    deliver(P.AttributeChange, [str(A.AllowTeleport, 'invalid')]); expect(Reflect.get(client, 'settings').canTeleport).toBe(true);
  });
  it('rejects forged server origin even for direct AxisClient callers before lookup or socket closure', async () => {
    const { client, requests } = await setup(true); const transport = Reflect.get(client, 'world'); requests.length = 0;
    await expect(client.command({ type: 'enter', world: 'Other', origin: 'server' } as unknown as ClientCommand)).rejects.toThrow('Invalid travel origin');
    expect(requests).toEqual([]); expect(Reflect.get(client, 'world')).toBe(transport);
  });
  it.each([[true, false], [false, true]])('retains manual requested destination when allow=%s caretaker=%s', async (allow, caretaker) => {
    const { client, events } = await setup(allow, caretaker);
    await client.command({ type: 'enter', world: 'Haven', position: destination });
    expect(events).toContainEqual({ type: 'teleport', position: destination });
  });
  it('uses authored entry when manual travel is allowed and no coordinates were requested', async () => {
    const { events } = await setup(true); expect(events).toContainEqual({ type: 'teleport', position: { x: 40, y: 20, z: 30, yaw: Math.PI / 2 } });
  });
  it.each(['Other', 'Haven'])('preserves scoped object-action exception for %s', async world => {
    const { client, events } = await setup();
    await client.command({ type: 'enter', world, position: destination, origin: 'action', fromWorld: '  HAVEN ', session: 41 });
    expect(events).toContainEqual({ type: 'teleport', position: destination });
  });
  it.each([{ fromWorld: 'Different', session: 41 }, { fromWorld: 'Haven', session: 42 }])('rejects stale action scope %j before leaving current world', async scope => {
    const { client, requests } = await setup(); requests.length = 0;
    await expect(client.command({ type: 'enter', world: 'Other', origin: 'action', ...scope })).rejects.toThrow('source world or session changed');
    expect(requests).toEqual([]); expect(Reflect.get(client, 'worldReady')).toBe(true);
  });
  it('rejects an action after world entry was cleared', async () => {
    const { client, requests } = await setup(); Reflect.get(client, 'clearWorld').call(client); requests.length = 0;
    await expect(client.command({ type: 'enter', world: 'Other', origin: 'action', fromWorld: 'Haven', session: 41 })).rejects.toThrow('source world or session changed');
    expect(requests).toEqual([]);
  });
  it('does not send a delayed action Enter after disconnect supersedes an in-flight world connection', async () => {
    const { client, connect, requests } = await setup(); let release!: () => void;
    connect.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const travel = client.command({ type: 'enter', world: 'Other', origin: 'action', fromWorld: 'Haven', session: 41 });
    const outcome = travel.catch(error => error);
    await vi.waitFor(() => expect(release).toBeDefined()); client.disconnect(); requests.length = 0;
    release(); expect(await outcome).toMatchObject({ message: 'World entry superseded' });
    expect(requests.some(packet => packet.type === P.Enter)).toBe(false);
  });
  it('forwards a trusted local server teleport independently of manual permissions', async () => {
    const { deliver, events } = await setup(); events.length = 0;
    deliver(P.Teleport, [str(V.TeleportWorld, 'haven'), i32(V.TeleportX, 8000), i32(V.TeleportY, 500), i32(V.TeleportZ, -300), i32(V.TeleportYaw, 900)]);
    expect(events).toEqual([{ type: 'teleport', position: { x: 80, y: 5, z: -3, yaw: Math.PI / 2 } }]);
  });
  it('routes trusted cross-world server teleports internally without exposing a public privilege flag', async () => {
    const { deliver, events } = await setup(); events.length = 0;
    deliver(P.Teleport, [str(V.TeleportWorld, 'Other'), i32(V.TeleportX, 8000), i32(V.TeleportY, 500), i32(V.TeleportZ, -300), i32(V.TeleportYaw, 900)]);
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'teleport', position: { x: 80, y: 5, z: -3, yaw: Math.PI / 2 } }));
    expect(events.filter(event => event.type === 'teleport')).toHaveLength(1);
  });
  it.each(['  ', 'a'.repeat(65), 'bad\0world'])('rejects malformed server destinations %j before leaving the current world', async world => {
    const { client, deliver, requests, events } = await setup(); const transport = Reflect.get(client, 'world'); requests.length = 0; events.length = 0;
    deliver(P.Teleport, [{ id: V.TeleportWorld, type: 4, data: Buffer.from(world + '\0') }]);
    expect(events).toEqual([{ type: 'error', message: 'The server supplied an invalid teleport world.' }]);
    expect(requests).toEqual([]); expect(Reflect.get(client, 'world')).toBe(transport); expect(Reflect.get(client, 'worldReady')).toBe(true);
  });
});

describe('navigation renderer validation', () => {
  it.each([undefined, 'user', 'action'])('accepts supported origin %s', origin => {
    expect(() => assertCommand({ type: 'enter', world: 'Other', origin, fromWorld: 'Haven', session: 41 })).not.toThrow();
  });
  it.each(['server', 'trusted', true, null, {}, 1])('rejects invented privilege origin %j', origin => {
    expect(() => assertCommand({ type: 'enter', world: 'Other', origin })).toThrow('Invalid travel origin');
  });
  it.each([{ fromWorld: undefined }, { fromWorld: ' ' }, { fromWorld: 'bad\0world' }, { session: undefined }, { session: 0 }, { session: 1.5 }, { session: 0x80000000 }])('requires a valid action source scope %j', invalid => {
    expect(() => assertCommand({ type: 'enter', world: 'Other', origin: 'action', fromWorld: 'Haven', session: 41, ...invalid })).toThrow();
  });
  it.each([{ world: '  ' }, { position: { ...destination, x: Infinity } }, { position: { ...destination, z: 21474836.48 } }])('rejects malformed destination %j', invalid => {
    expect(() => assertCommand({ type: 'enter', world: 'Other', ...invalid } as ClientCommand)).toThrow();
  });
});

describe('failed and superseded World lookup recovery', () => {
  it.each(['rejected', 'timeout', 'malformed address'])('restores Universe-only connected state after %s and permits a later entry', async failure => {
    const { client, events, connect } = await setup(true); events.length = 0; connect.mockClear();
    const universe = Reflect.get(client, 'universe');
    const request = vi.spyOn(universe, 'request');
    if (failure === 'timeout') request.mockRejectedValueOnce(new Error('Axis request timed out'));
    else request.mockResolvedValueOnce({ type: P.WorldLookup, version: 4, flags: 0, fields: [str(V.WorldName, 'Other'), i32(V.ReasonCode, failure === 'rejected' ? 27 : 0), blob(V.WorldAddress, Buffer.from([127, 0, 0]))] });
    await expect(client.command({ type: 'enter', world: 'Other' })).rejects.toThrow();
    expect(events.filter(event => event.type === 'status').at(-1)).toEqual({ type: 'status', phase: 'connected', message: 'World lookup failed' });
    expect(Reflect.get(client, 'universe')).toBe(universe); expect(Reflect.get(client, 'world')).toBeUndefined(); expect(connect).not.toHaveBeenCalled();
    await client.command({ type: 'enter', world: 'Haven' });
    expect(events.filter(event => event.type === 'status').at(-1)).toMatchObject({ phase: 'online' });
  });
  it.each(['new entry', 'disconnect'])('does not let a delayed lookup failure overwrite a superseding %s', async action => {
    const { client, events } = await setup(true); let reject!: (error: Error) => void;
    vi.spyOn(Reflect.get(client, 'universe'), 'request').mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const older = client.command({ type: 'enter', world: 'Other' }).catch(error => error);
    if (action === 'new entry') await client.command({ type: 'enter', world: 'Newest' }); else client.disconnect();
    events.length = 0; reject(new Error('Old lookup failed')); expect(await older).toMatchObject({ message: 'Old lookup failed' });
    expect(events.some(event => event.type === 'status')).toBe(false);
    expect(Reflect.get(client, 'worldReady')).toBe(action === 'new entry');
    if (action === 'new entry') expect(Reflect.get(client, 'settings').name).toBe('Newest');
  });
});
