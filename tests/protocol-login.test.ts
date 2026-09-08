import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxisClient } from '../src/main/protocol/axis-client';
import { AxisTransport } from '../src/main/protocol/transport';
import { encode, i32, str, string, type Field, type Packet } from '../src/main/protocol/codec';
import { P, V } from '../src/main/protocol/constants';
import type { ClientEvent, ConnectionOptions } from '../src/shared/types';

const clients: AxisClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.disconnect(); vi.restoreAllMocks(); });

/** Script packet replies through the actual client/transport dispatcher while
 * replacing socket creation. No server processes or fixture accounts are used. */
function setup() {
  const events: ClientEvent[] = [], requests: Packet[] = [];
  const client = new AxisClient(event => events.push(event)); clients.push(client);
  const connect = vi.spyOn(AxisTransport.prototype, 'connect').mockResolvedValue();
  vi.spyOn(AxisTransport.prototype, 'send').mockImplementation(function (this: AxisTransport, type: number, fields: Field[] = []) {
    const request = { type, fields, version: 3, flags: 2 }; requests.push(request);
    const deliver = (packetType: number, reply: Field[]) => Reflect.get(this, 'receive').call(this, encode(packetType, reply));
    if (type === P.Login) deliver(P.Login, [i32(V.ReasonCode, 0), i32(V.SessionId, 41), i32(V.CitizenNumber, 3), str(V.CitizenName, 'Test Citizen')]);
    else if (type === P.WorldList) {
      deliver(P.WorldList, [str(V.WorldListName, 'Haven'), i32(V.WorldListStatus, 3), i32(V.WorldListUsers, 0)]);
      deliver(P.WorldListResult, [i32(V.ReasonCode, 0)]);
    } else if (type === P.ContactList) {
      deliver(P.ContactList, [i32(V.ContactListCitizenId, 0), i32(V.ContactListOptions, 0), i32(V.ReasonCode, 0)]);
    } else if (type === P.TelegramGet) deliver(P.TelegramDeliver, [i32(V.ReasonCode, 37)]);
    else if (type === P.WorldLookup) deliver(P.WorldLookup, [str(V.WorldName, string(request, V.WorldName)), i32(V.ReasonCode, 27)]);
    else throw new Error(`Unexpected outgoing packet ${type}`);
  });
  return { client, events, requests, connect };
}

const options: ConnectionOptions = { host: 'unused.invalid', port: 16670, tls: false, username: 'Test Citizen', password: 'test-only' };

describe('optional starting world', () => {
  it.each([undefined, '', ' ', '\t \n'])('keeps a Universe-only session for starting world %j', async world => {
    const { client, events, requests, connect } = setup();
    await client.command({ type: 'connect', options: { ...options, ...(world === undefined ? {} : { world }) } });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(requests.map(packet => packet.type)).toEqual([P.Login, P.WorldList]);
    expect(events.filter(event => event.type === 'status').map(event => event.phase)).toEqual(['disconnected', 'connecting', 'authenticating', 'connected']);
    expect(events).toContainEqual({ type: 'login', citizen: 3, session: 41, name: 'Test Citizen' });
    expect(events).toContainEqual({ type: 'worlds', worlds: [{ name: 'Haven', status: 'stopped', users: 0 }] });
    expect(events.some(event => event.type === 'error')).toBe(false);

    await client.command({ type: 'contacts-list' });
    await client.command({ type: 'telegram-fetch' });
    expect(events).toContainEqual({ type: 'contacts', contacts: [], defaultOptions: 0 });
    expect(events).toContainEqual({ type: 'telegram-pending', pending: false });
    expect(requests.some(packet => packet.type === P.WorldLookup || packet.type === P.Enter)).toBe(false);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'status').at(-1)).toMatchObject({ phase: 'connected' });
  });

  it('normalizes an explicitly selected world and reports the real lookup rejection', async () => {
    const { client, requests, events } = setup();
    await expect(client.command({ type: 'connect', options: { ...options, world: '  Haven  ' } }))
      .rejects.toThrow('Find world: World does not exist or is not currently running (Axis 27)');
    const lookup = requests.find(packet => packet.type === P.WorldLookup);
    expect(lookup).toBeDefined();
    expect(string(lookup!, V.WorldName)).toBe('Haven');
    expect(events.some(event => event.type === 'status' && event.phase === 'entering')).toBe(true);
  });
});
