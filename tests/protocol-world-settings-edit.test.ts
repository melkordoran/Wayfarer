import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxisClient } from '../src/main/protocol/axis-client';
import { AxisTransport } from '../src/main/protocol/transport';
import { blob, compressed, encode, i32, str, string, type Field, type Packet } from '../src/main/protocol/codec';
import { P, V } from '../src/main/protocol/constants';
import { WORLD_ATTRIBUTE as A } from '../src/main/protocol/world-settings';
import type { ClientEvent, WorldSettings } from '../src/shared/types';
import type { WorldSettingsSetCommand } from '../src/shared/world-settings-edit';

const clients: AxisClient[] = [];
const epoch = '049022a0-6ddd-4a38-8451-9924e625838d';
const caps = (caretaker = 'Y') => Array.from({ length: 7 }, (_, id) => str(id, id === 1 ? caretaker : id === 6 ? 'N' : 'Y'));
afterEach(() => { clients.splice(0).forEach(client => client.disconnect()); vi.restoreAllMocks(); vi.useRealTimers(); });

/** Actual codec/transport dispatch, independent packets, no sockets/services. */
function setup(version = 4) {
  const events: ClientEvent[] = [], sent: Packet[] = [];
  const client = new AxisClient(event => events.push(event)); clients.push(client);
  const world = new AxisTransport(packet => {
    if (Reflect.get(client, 'world') === world) Reflect.get(client, 'worldPacket').call(client, packet);
  }, () => {
    if (Reflect.get(client, 'world') === world) { Reflect.set(client, 'world', undefined); Reflect.get(client, 'clearWorld').call(client); }
  });
  Reflect.set(client, 'world', world); Reflect.set(client, 'worldReady', true);
  Reflect.set(client, 'worldGeneration', 1); Reflect.set(client, 'worldSettingsEntryId', epoch);
  Reflect.set(client, 'session', 41); Reflect.set(client, 'citizen', 3);
  Reflect.set(client, 'settings', Reflect.get(client, 'defaultSettings').call(client, 'Haven'));
  const send = vi.spyOn(world, 'send').mockImplementation((type, fields = [], version = world.version) => { sent.push({ type, fields, version, flags: 2 }); });
  const receive = (bytes: Buffer) => Reflect.get(world, 'receive').call(world, bytes);
  const deliver = (type: number, fields: Field[] = []) => receive(encode(type, fields, version));
  const direct = (type: number, fields: Field[]) => Reflect.get(client, 'worldPacket').call(client, { type, fields, version: 4, flags: 0 });
  const settings = () => Reflect.get(client, 'settings') as WorldSettings;
  const results = () => events.filter((e): e is Extract<ClientEvent, { type: 'world-settings-result' }> => e.type === 'world-settings-result');
  deliver(P.Attributes, [str(A.Title, 'Original'), str(A.WelcomeMessage, 'Hello'), str(A.AllowFlying, 'Y'), str(A.Gravity, '1'), str(A.FogMinimum, '40'), str(A.FogMaximum, '120')]);
  deliver(P.Capabilities, caps()); events.length = 0;
  const command = (overrides: Partial<WorldSettingsSetCommand> = {}): WorldSettingsSetCommand => ({
    type: 'world-settings-set', requestId: 'settings-1', world: 'Haven', session: 41, entryId: epoch,
    revision: settings().editContext!.revision, changes: [{ id: A.Title, before: settings().rawAttributes![A.Title] ?? null, value: 'Changed' }], ...overrides,
  });
  const pair = (fields: Field[] = [str(A.Title, 'Changed')], capabilityFields = caps(), envelopeVersion = 3) => receive(compressed([encode(P.Attributes, fields), encode(P.Capabilities, capabilityFields, envelopeVersion)], envelopeVersion));
  return { client, world, events, sent, send, receive, deliver, direct, settings, results, command, pair };
}

describe('guarded world settings writes without server acknowledgements', () => {
  it.each([
    ['Boolean', A.AllowFlying, 'Y', 'N'], ['integer', A.FogMinimum, '40', '0'], ['one-character text', A.Title, 'Original', 'x'],
  ] as const)('uses explicit v4 for a legacy 16-byte %s update without changing its field or value', async (_label, id, before, value) => {
    const view = setup(3); expect(view.world.version).toBe(3);
    expect(() => encode(P.AttributeChange, [str(id, value)], 3)).toThrow('ambiguous');
    const pending = view.client.command(view.command({ changes: [{ id, before, value }] }));
    expect(view.sent).toHaveLength(1); expect(view.sent[0]).toMatchObject({ type: P.AttributeChange, version: 4, fields: [str(id, value)] });
    expect(view.send).toHaveBeenCalledWith(P.AttributeChange, [str(id, value)], 4);
    const wire = encode(P.AttributeChange, view.sent[0].fields, view.sent[0].version);
    expect(wire.readUInt16BE(0)).toBe(16); expect(wire.readUInt16BE(2)).toBe(4);
    expect(view.world.version).toBe(3); // sending alone does not invent negotiated state
    view.pair([str(id, value), str(A.WelcomeMessage, 'Hello')], caps(), 4); await pending;
    expect(view.world.version).toBe(4); expect(view.results()[0].status).toBe('observed');
    expect(view.settings().rawAttributes![id]).toBe(value); expect(view.sent[0].fields).toHaveLength(1);
  });

  it('keeps an ordinary legacy title update at v3 without changing negotiation', async () => {
    const view = setup(3), pending = view.client.command(view.command());
    expect(view.world.version).toBe(3); expect(view.send).toHaveBeenCalledWith(P.AttributeChange, [str(A.Title, 'Changed')], 3);
    expect(view.sent[0].version).toBe(3); view.pair(); await pending;
    expect(view.results()[0].status).toBe('observed'); expect(view.world.version).toBe(3);
  });

  it('sends only String changes and waits for Attributes plus Capabilities, not an AttributeChange echo', async () => {
    const view = setup(), input = view.command(); let complete = false;
    const pending = view.client.command(input).then(() => { complete = true; });
    expect(view.sent).toHaveLength(1); expect(view.sent[0].type).toBe(P.AttributeChange);
    expect(view.sent[0].fields).toEqual([str(A.Title, 'Changed')]);
    expect(view.settings().title).toBe('Original'); expect(view.results()).toEqual([]);
    view.deliver(P.AttributeChange, [str(A.Title, 'Changed')]); view.deliver(P.Capabilities, caps());
    await Promise.resolve(); expect(complete).toBe(false); expect(view.results()).toEqual([]);
    view.deliver(P.Attributes, [str(A.Title, 'Changed')]); expect(view.results()).toEqual([]);
    view.deliver(P.Capabilities, caps()); await pending;
    expect(view.results()).toEqual([expect.objectContaining({ requestId: 'settings-1', world: 'Haven', session: 41, entryId: epoch, status: 'observed' })]);
    expect(view.results()[0].message).toContain('not an atomic or durable');
    expect(view.events.at(-2)).toMatchObject({ type: 'world', settings: { title: 'Changed', editContext: { blocked: false } } });
    expect(view.events.at(-1)?.type).toBe('world-settings-result'); expect(view.sent).toHaveLength(1);
    expect(Reflect.get(view.world, 'waiters').size).toBe(0); expect(Reflect.get(view.client, 'worldSettingsEdit')).toBeUndefined();
  });

  it('accepts the actual compressed full-attributes/capabilities packet order', async () => {
    const view = setup(), pending = view.client.command(view.command());
    view.pair(); await pending; expect(view.results()[0].status).toBe('observed');
  });

  it('registers readback before dispatch, including synchronous transport delivery', async () => {
    const view = setup(); view.send.mockImplementationOnce(() => { view.pair(); });
    await view.client.command(view.command()); expect(view.results()[0].status).toBe('observed');
  });

  it('clones caller changes for both dispatch and later comparison', async () => {
    const view = setup(), input = view.command(), pending = view.client.command(input);
    input.changes[0].id = A.ObjectPassword; input.changes[0].value = 'Mutated'; input.requestId = 'another';
    view.pair(); await pending;
    expect(view.sent[0].fields).toEqual([str(A.Title, 'Changed')]);
    expect(view.results()[0]).toMatchObject({ status: 'observed', requestId: 'settings-1' });
  });

  it('rejects a second pending write instead of queuing it and rejects stale replay after readback', async () => {
    const view = setup(), input = view.command(), pending = view.client.command(input);
    await expect(view.client.command(input)).rejects.toThrow('already pending');
    view.pair(); await pending;
    await expect(view.client.command(input)).rejects.toThrow('changed since'); expect(view.sent).toHaveLength(1);
    const next = view.client.command(view.command({ requestId: 'settings-2', changes: [{ id: A.Title, before: 'Changed', value: 'Third' }] }));
    view.pair([str(A.Title, 'Third')]); await next; expect(view.sent).toHaveLength(2);
  });

  it('uses actual float32 semantics when Axis writes a shorter invariant decimal', async () => {
    const view = setup(), pending = view.client.command(view.command({ changes: [{ id: A.Gravity, before: '1', value: String(Math.fround(0.3)) }] }));
    expect(string(view.sent[0], A.Gravity)).toBe(String(Math.fround(0.3)));
    view.pair([str(A.Gravity, '0.3')]); await pending; expect(view.results()[0].status).toBe('observed');
  });

  it('reports differing canonical values as conflict without rollback or retry and blocks later writes', async () => {
    const view = setup(), pending = view.client.command(view.command());
    view.pair([str(A.Title, 'Another caretaker')]); await pending;
    expect(view.results()[0].status).toBe('conflict'); expect(view.settings()).toMatchObject({ title: 'Another caretaker', editContext: { blocked: true } });
    await expect(view.client.command(view.command())).rejects.toThrow('paused until world re-entry');
    expect(view.sent).toHaveLength(1);
  });

  it('applies recalculated permission loss before its observed result and prevents the next write', async () => {
    const view = setup(), pending = view.client.command(view.command());
    view.pair([str(A.Title, 'Changed')], caps('N')); await pending;
    expect(view.results()[0].status).toBe('observed'); expect(view.settings().caretaker).toBe(false);
    expect(view.events.at(-2)).toMatchObject({ type: 'world', settings: { caretaker: false } });
    await expect(view.client.command(view.command())).rejects.toThrow('Caretaker'); expect(view.sent).toHaveLength(1);
  });

  it('does not increment the edit revision for capabilities, but does for all attribute packets', () => {
    const view = setup(), first = view.settings().editContext!.revision;
    view.deliver(P.Capabilities, caps()); expect(view.settings().editContext!.revision).toBe(first);
    view.deliver(P.Attributes, []); expect(view.settings().editContext!.revision).toBe(first + 1);
    view.deliver(P.AttributeChange, [i32(A.Title, 3)]); expect(view.settings().editContext!.revision).toBe(first + 2);
  });
});

describe('world settings readback validation', () => {
  it.each(['missing', 'number', 'duplicate', 'internal NUL', 'invalid UTF-8', 'oversized'])('does not verify a %s field using cumulative cached values', async kind => {
    const view = setup(), pending = view.client.command(view.command());
    view.deliver(P.AttributeChange, [str(A.Title, 'Changed')]); // desired value is cached, but not read back
    const fields = kind === 'missing' ? [str(A.WelcomeMessage, 'Hello')]
      : kind === 'number' ? [i32(A.Title, 123)]
      : kind === 'duplicate' ? [str(A.Title, 'Changed'), str(A.Title, 'Changed')]
      : [{ id: A.Title, type: 4, data: kind === 'internal NUL' ? Buffer.from('Changed\0junk\0') : kind === 'invalid UTF-8' ? Buffer.from([0xc0, 0xaf, 0]) : Buffer.alloc(8193, 65) }];
    view.direct(P.Attributes, fields); view.deliver(P.Capabilities, caps()); expect(view.results()).toEqual([]);
    view.pair(); await pending; expect(view.results()[0].status).toBe('observed');
  });

  it('requires all changed IDs in the same Attributes packet, not accumulated across partial packets', async () => {
    const view = setup(), pending = view.client.command(view.command({ changes: [{ id: A.Title, before: 'Original', value: 'Changed' }, { id: A.WelcomeMessage, before: 'Hello', value: 'Welcome' }] }));
    view.deliver(P.Attributes, [str(A.Title, 'Changed')]); view.deliver(P.Attributes, [str(A.WelcomeMessage, 'Welcome')]);
    view.deliver(P.Capabilities, caps()); expect(view.results()).toEqual([]);
    view.pair([str(A.Title, 'Changed'), str(A.WelcomeMessage, 'Welcome')]); await pending;
    expect(view.results()[0].status).toBe('observed');
  });

  it.each(['partial', 'duplicate', 'numeric', 'invalid boolean'])('invalidates an Attributes candidate after %s capabilities', async kind => {
    const view = setup(), pending = view.client.command(view.command());
    view.deliver(P.Attributes, [str(A.Title, 'Changed')]);
    view.deliver(P.Capabilities, kind === 'partial' ? caps().slice(0, 6) : kind === 'duplicate' ? [...caps(), str(1, 'Y')]
      : caps().map(f => f.id !== 1 ? f : kind === 'numeric' ? i32(1, 1) : str(1, 'true')));
    view.deliver(P.Capabilities, caps()); expect(view.results()).toEqual([]);
    view.pair(); await pending; expect(view.results()[0].status).toBe('observed');
  });

  it.each([P.Attributes, P.AttributeChange])('does not pair capabilities across intervening partial attribute packet %i', async type => {
    const view = setup(), pending = view.client.command(view.command());
    view.deliver(P.Capabilities, caps()); view.deliver(P.Attributes, [str(A.Title, 'Changed')]);
    view.deliver(type, [str(A.WelcomeMessage, 'Other')]); view.deliver(P.Capabilities, caps());
    expect(view.results()).toEqual([]); view.pair(); await pending; expect(view.results()[0].status).toBe('observed');
  });
});

describe('world settings authority, baselines, and lifecycle', () => {
  it.each(['world', 'session', 'entry', 'revision', 'caretaker', 'ready', 'missing world'])('rejects stale or unauthorized %s before sending', async kind => {
    const view = setup(), input = view.command();
    if (kind === 'world') input.world = 'Elsewhere';
    if (kind === 'session') input.session++;
    if (kind === 'entry') input.entryId = 'aad72209-8572-4f96-9f65-4a487fef7eab';
    if (kind === 'revision') input.revision++;
    if (kind === 'caretaker') Reflect.get(view.client, 'settings').caretaker = false;
    if (kind === 'ready') Reflect.set(view.client, 'worldReady', false);
    if (kind === 'missing world') Reflect.set(view.client, 'world', undefined);
    await expect(view.client.command(input)).rejects.toThrow();
    expect(view.sent).toEqual([]); expect(view.results()).toEqual([]); expect(Reflect.get(view.client, 'worldSettingsBlocked')).toBe(false);
  });

  it('requires an exact raw before value even when numeric semantics would compare equal', async () => {
    const view = setup();
    await expect(view.client.command(view.command({ changes: [{ id: A.Gravity, before: '1.0', value: '0.5' }] }))).rejects.toThrow('baseline changed');
    expect(view.sent).toEqual([]);
  });

  it('checks cross-field constraints against the latest baseline before sending', async () => {
    const view = setup();
    await expect(view.client.command(view.command({ changes: [{ id: A.FogMinimum, before: '40', value: '121' }] }))).rejects.toThrow();
    expect(view.sent).toEqual([]); expect(Reflect.get(view.client, 'worldSettingsBlocked')).toBe(false);
  });

  it.each([A.ObjectPassword, A.CavObjectPassword, 0x9b, 0xffff])('rejects disallowed attribute %i even for a caretaker', async id => {
    const view = setup(); await expect(view.client.command(view.command({ changes: [{ id, before: null, value: 'unsafe' }] }))).rejects.toThrow();
    expect(view.sent).toEqual([]); expect(view.results()).toEqual([]);
  });

  it('rejects empty/no-op changes without sending a synthetic read or locking editing', async () => {
    const view = setup();
    await expect(view.client.command(view.command({ changes: [] }))).rejects.toThrow();
    await expect(view.client.command(view.command({ changes: [{ id: A.Title, before: 'Original', value: 'Original' }] }))).rejects.toThrow();
    expect(view.sent).toEqual([]); expect(Reflect.get(view.client, 'worldSettingsBlocked')).toBe(false);
  });

  it('times out at 12 seconds, emits uncertainty before resolving, ignores late readback and never retries', async () => {
    vi.useFakeTimers(); const view = setup(); let complete = false;
    const pending = view.client.command(view.command()).then(() => { expect(view.results()[0].status).toBe('uncertain'); complete = true; });
    await vi.advanceTimersByTimeAsync(11999); expect(complete).toBe(false); expect(view.results()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(view.settings().editContext!.blocked).toBe(true); expect(vi.getTimerCount()).toBe(0);
    view.pair(); expect(view.results()).toHaveLength(1);
    await expect(view.client.command(view.command())).rejects.toThrow('paused until world re-entry'); expect(view.sent).toHaveLength(1);
  });

  it('handles dispatch exceptions as uncertain without disclosing transport errors or automatic resubmission', async () => {
    const view = setup(); view.send.mockImplementationOnce(() => { throw new Error('private endpoint details'); });
    await view.client.command(view.command());
    expect(view.results()[0].status).toBe('uncertain'); expect(view.results()[0].message).not.toContain('private endpoint');
    expect(view.settings().editContext!.blocked).toBe(true);
    await expect(view.client.command(view.command())).rejects.toThrow('paused until world re-entry'); expect(view.send).toHaveBeenCalledTimes(1);
  });

  it.each(['disconnect', 'world close', 'entry clear'])('resolves pending edits as scoped uncertainty on %s and releases timer state', async action => {
    vi.useFakeTimers(); const view = setup(), pending = view.client.command(view.command());
    if (action === 'disconnect') view.client.disconnect();
    else if (action === 'world close') view.world.close();
    else Reflect.get(view.client, 'clearWorld').call(view.client);
    await pending;
    expect(view.results()).toEqual([expect.objectContaining({ status: 'uncertain', world: 'Haven', session: 41, entryId: epoch })]);
    expect(Reflect.get(view.client, 'worldSettingsEdit')).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    expect(Reflect.get(view.client, 'worldSettingsBlocked')).toBe(false);
    await vi.advanceTimersByTimeAsync(12001); expect(view.results()).toHaveLength(1);
  });

  it('generates a distinct entry UUID on each real entry even with the same world and Universe session', async () => {
    const view = setup(), oldDraft = view.command(), oldPending = view.client.command(oldDraft);
    const universe = new AxisTransport(() => {}); Reflect.set(view.client, 'universe', universe);
    Reflect.set(view.client, 'options', { host: '127.0.0.1', port: 6670, tls: false, username: 'test' });
    vi.spyOn(universe, 'request').mockResolvedValue({ type: P.WorldLookup, version: 3, flags: 0, fields: [str(V.WorldName, 'Haven'), blob(V.WorldAddress, Buffer.from([127, 0, 0, 1])), i32(V.WorldPort, 7000), blob(V.WorldUserNonce, Buffer.alloc(16))] });
    vi.spyOn(AxisTransport.prototype, 'connect').mockResolvedValue();
    vi.spyOn(AxisTransport.prototype, 'request').mockResolvedValue({ type: P.Enter, version: 3, flags: 0, fields: [i32(V.ReasonCode, 0)] });
    vi.spyOn(AxisTransport.prototype, 'send').mockImplementation(() => {});
    vi.spyOn(view.client as unknown as { query: () => Promise<void> }, 'query').mockResolvedValue(undefined);
    Reflect.get(view.client, 'settings').canTeleport = true;
    await Reflect.get(view.client, 'enter').call(view.client, 'Haven');
    await oldPending; expect(view.results()[0]).toMatchObject({ status: 'uncertain', entryId: epoch });
    const first = view.settings().editContext!.entryId;
    expect(first).toMatch(/^[a-f0-9-]{36}$/); expect(first).not.toBe(epoch);
    view.pair(); expect(view.results()).toHaveLength(1); expect(view.settings().editContext!.revision).toBe(0);
    await expect(view.client.command(oldDraft)).rejects.toThrow('entry or session changed');
    Reflect.get(view.client, 'settings').canTeleport = true;
    await Reflect.get(view.client, 'enter').call(view.client, 'Haven');
    expect(view.settings().editContext!.entryId).not.toBe(first);
    expect(view.settings().editContext).toMatchObject({ revision: 0, blocked: false });
    expect(Reflect.get(view.client, 'session')).toBe(41);
  });
});
