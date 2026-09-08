import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxisClient, type AxisClientPolicy } from '../src/main/protocol/axis-client';
import { AxisTransport } from '../src/main/protocol/transport';
import { blob, encode, i32, str, string, type Field, type Packet } from '../src/main/protocol/codec';
import { P, V } from '../src/main/protocol/constants';
import { WORLD_ATTRIBUTE as A } from '../src/main/protocol/world-settings';
import type { ClientEvent } from '../src/shared/types';

const clients: AxisClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.disconnect()); vi.restoreAllMocks(); });
const fixturePolicy = vi.fn((target: { host: string; port: number; tls: boolean }) => {
  if (target.host !== '127.0.0.1' || target.port !== 27000 || target.tls !== false) throw new Error('Isolated World destination refused');
});
/** No listeners or accounts: all transport requests use real encoded replies. */
async function setup(policy?: AxisClientPolicy, tls = false) {
  fixturePolicy.mockClear();
  const events: ClientEvent[] = [], packets: Packet[] = [];
  const advertisement = { ip: [127, 0, 0, 1], port: 27000 };
  const client = new AxisClient(event => events.push(event), policy); clients.push(client);
  const connect = vi.spyOn(AxisTransport.prototype, 'connect').mockResolvedValue();
  vi.spyOn(AxisTransport.prototype, 'send').mockImplementation(function (this: AxisTransport, type, fields = []) {
    packets.push({ type, fields, version: 3, flags: 2 });
    const reply = (type: number, fields: Field[] = []) => Reflect.get(this, 'receive').call(this, encode(type, fields, 4));
    if (type === P.Login) reply(P.Login, [i32(V.SessionId, 41), i32(V.CitizenNumber, 3), str(V.CitizenName, 'Isolated')]);
    else if (type === P.WorldList) reply(P.WorldListResult);
    else if (type === P.WorldLookup) reply(P.WorldLookup, [str(V.WorldName, string({ fields } as Packet, V.WorldName)), blob(V.WorldAddress, Buffer.from(advertisement.ip)), i32(V.WorldPort, advertisement.port)]);
    else if (type === P.Enter) { reply(P.Attributes, [str(A.AllowTeleport, 'Y'), str(A.EnableTerrain, 'N')]); reply(P.Enter); }
    else if (type === P.Query3X3) reply(P.QueryUpToDate);
  });
  await client.command({ type: 'connect', options: { host: '127.0.0.1', port: 26670, tls, username: 'Isolated', password: 'test-only' } });
  connect.mockClear(); packets.length = 0;
  const deliverTeleport = () => {
    const world = Reflect.get(client, 'world');
    Reflect.get(world, 'receive').call(world, encode(P.Teleport, [str(V.TeleportWorld, 'Elsewhere')], 4));
  };
  return { client, connect, events, packets, advertisement, deliverTeleport };
}

describe('trusted World endpoint authorization', () => {
  it('preserves default behavior without a host policy', async () => {
    const { client, advertisement, connect } = await setup(); advertisement.ip = [203, 0, 113, 42]; advertisement.port = 7777;
    await client.command({ type: 'enter', world: 'Haven' });
    expect(connect).toHaveBeenCalledWith('203.0.113.42', 7777, false);
  });
  it.each([{ ip: [127, 0, 0, 1] }, { ip: [0, 0, 0, 0] }])('authorizes resolved isolated endpoint from advertised IP %j', async ({ ip }) => {
    const { client, advertisement, connect } = await setup({ authorizeWorldConnection: fixturePolicy }); advertisement.ip = ip;
    await client.command({ type: 'enter', world: 'Haven' });
    expect(fixturePolicy).toHaveBeenCalledExactlyOnceWith({ host: '127.0.0.1', port: 27000, tls: false });
    expect(connect).toHaveBeenCalledWith('127.0.0.1', 27000, false);
  });
  it.each([
    { ip: [127, 0, 0, 1], port: 17000 },
    { ip: [203, 0, 113, 42], port: 27000 },
    { ip: [127, 0, 0, 2], port: 27000 },
  ])('blocks an advertised endpoint %j before World connect or nonce dispatch', async target => {
    const { client, advertisement, connect, packets, events } = await setup({ authorizeWorldConnection: fixturePolicy }); Object.assign(advertisement, target);
    await expect(client.command({ type: 'enter', world: 'Haven' })).rejects.toThrow('Isolated World destination refused');
    expect(connect).not.toHaveBeenCalled(); expect(packets.some(packet => packet.type === P.Enter)).toBe(false);
    expect(events).toContainEqual({ type: 'status', phase: 'connected', message: 'World destination blocked by host policy' });
  });
  it('passes TLS mode to the host policy before connecting', async () => {
    const { client, connect } = await setup({ authorizeWorldConnection: fixturePolicy }, true);
    await expect(client.command({ type: 'enter', world: 'Haven' })).rejects.toThrow('Isolated World destination refused');
    expect(fixturePolicy).toHaveBeenCalledWith({ host: '127.0.0.1', port: 27000, tls: true }); expect(connect).not.toHaveBeenCalled();
  });
  it('enforces the same policy for scoped authored action entry', async () => {
    const { client, advertisement, connect, packets } = await setup({ authorizeWorldConnection: fixturePolicy });
    await client.command({ type: 'enter', world: 'Haven' }); connect.mockClear(); packets.length = 0; advertisement.port = 17000;
    await expect(client.command({ type: 'enter', world: 'Elsewhere', origin: 'action', fromWorld: 'Haven', session: 41 })).rejects.toThrow('Isolated World destination refused');
    expect(connect).not.toHaveBeenCalled(); expect(packets.some(packet => packet.type === P.Enter)).toBe(false);
  });
  it('does not let trusted server teleport bypass host isolation policy', async () => {
    const { client, advertisement, connect, packets, events, deliverTeleport } = await setup({ authorizeWorldConnection: fixturePolicy });
    await client.command({ type: 'enter', world: 'Haven' }); connect.mockClear(); packets.length = 0; advertisement.ip = [203, 0, 113, 42];
    deliverTeleport();
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'error', message: 'Isolated World destination refused' }));
    expect(connect).not.toHaveBeenCalled(); expect(packets.some(packet => packet.type === P.Enter)).toBe(false);
  });
});
