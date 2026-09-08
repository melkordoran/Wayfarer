import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxisSocial, contactFromPacket, telegramFromPacket } from '../src/main/protocol/social';
import { AxisTransport } from '../src/main/protocol/transport';
import { byte, encode, i32, num, str, string, type Field, type Packet } from '../src/main/protocol/codec';
import { P, V } from '../src/main/protocol/constants';
import { assertCommand } from '../src/shared/validation';
import { CONTACT_OPTIONS, type ClientEvent } from '../src/shared/types';

const cleanups: Array<() => void> = [];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });
const packet = (type: number, fields: Field[] = []): Packet => ({ type, fields, version: 3, flags: 2 });
function setup(citizen = 3) {
  const events: ClientEvent[] = [], requests: Packet[] = [];
  let social: AxisSocial;
  const transport = new AxisTransport(p => social.receive(p));
  social = new AxisSocial(transport, event => events.push(event), () => ({ citizen, name: 'Explorer' }));
  const send = vi.spyOn(transport, 'send').mockImplementation((type, fields = []) => { requests.push(packet(type, fields)); });
  const deliver = (...packets: Packet[]) => Reflect.get(transport, 'receive').call(transport, Buffer.concat(packets.map(p => encode(p.type, p.fields))));
  cleanups.push(() => { social.close(); transport.close(); });
  return { social, transport, events, requests, send, deliver };
}
function contact(citizen: number, name: string, state = 1, more = 1, options = 0): Packet {
  return packet(P.ContactList, [i32(V.ContactListCitizenId, citizen), str(V.ContactListName, name), i32(V.ContactListStatus, state), str(V.ContactListWorld, state === 1 ? 'Haven' : ''), byte(V.ContactListMore, more), i32(V.ContactListOptions, options)]);
}
const end = (options = 0) => contact(0, '', 4, 0, options);
function telegram(text: string, more = false): Packet {
  return packet(P.TelegramDeliver, [i32(V.ReasonCode, 0), str(V.TelegramCitizenName, 'SocialTester'), str(V.TelegramMessage, text), i32(V.TelegramAge, 120), byte(V.TelegramsMoreRemain, more ? 1 : 0)]);
}

describe('Axis contact protocol', () => {
  it('reconstructs initial list batches, sorts names and retains default privacy', () => {
    const { deliver, events } = setup();
    deliver(contact(4, 'Zed'), contact(2, 'Alice', 0), end(CONTACT_OPTIONS.requestBlocked));
    const result = events.at(-1);
    expect(result).toMatchObject({ type: 'contacts', defaultOptions: 8192, contacts: [{ citizen: 2, name: 'Alice', state: 'offline' }, { citizen: 4, name: 'Zed', state: 'online', world: 'Haven' }] });
  });
  it('does not mistake a live status More=0 packet for list completion', async () => {
    const { social, deliver, events } = setup(); let completed = false;
    const pending = social.command({ type: 'contacts-list' }).then(() => { completed = true; }); await flush();
    deliver(contact(4, 'SocialTester', 3, 0)); await Promise.resolve(); expect(completed).toBe(false);
    deliver(end()); await pending;
    expect(events.at(-1)).toMatchObject({ type: 'contacts', contacts: [{ citizen: 4, state: 'away' }] });
    deliver(contact(4, 'SocialTester', 5, 0)); expect(events.at(-1)).toMatchObject({ type: 'contacts', contacts: [] });
  });
  it('refreshes a list after add and delete ACKs without optimistic success', async () => {
    const { social, send, deliver, events, requests } = setup(); let included = false;
    send.mockImplementation((type, fields = []) => {
      requests.push(packet(type, fields));
      if (type === P.ContactAdd || type === P.ContactDelete) { included = type === P.ContactAdd; deliver(packet(type, [i32(V.ReasonCode, 0), i32(V.ContactListCitizenId, 4)])); }
      if (type === P.ContactList) deliver(...(included ? [contact(4, 'SocialTester')] : []), end());
    });
    await social.command({ type: 'contact-add', name: ' SocialTester ', options: 16 });
    expect(string(requests[0], V.ContactListName)).toBe('SocialTester'); expect(num(requests[0], V.ContactListOptions)).toBe(16);
    expect(events.at(-1)).toMatchObject({ type: 'contacts', contacts: [{ citizen: 4 }] });
    await social.command({ type: 'contact-delete', citizen: 4 });
    expect(events.at(-1)).toMatchObject({ type: 'contacts', contacts: [] });
  });
  it('uses list readback to verify no-ACK privacy changes', async () => {
    const { social, send, deliver, requests } = setup(); let options = 0;
    send.mockImplementation((type, fields = []) => {
      requests.push(packet(type, fields));
      if (type === P.ContactChange) options = num(packet(type, fields), V.ContactListOptions);
      if (type === P.ContactList) deliver(contact(4, 'SocialTester', 1, 1, options), end(options));
    });
    await social.command({ type: 'contact-change', citizen: 4, options: CONTACT_OPTIONS.telegramOff });
    await social.command({ type: 'contact-change', citizen: 0, options: CONTACT_OPTIONS.worldOff });
    expect(requests.map(p => p.type)).toEqual([P.ContactChange, P.ContactList, P.ContactChange, P.ContactList]);
  });
  it('rejects a privacy change when readback does not contain the requested options', async () => {
    const { social, send, deliver } = setup();
    send.mockImplementation(type => { if (type === P.ContactList) deliver(end()); });
    await expect(social.command({ type: 'contact-change', citizen: 4, options: 32 })).rejects.toThrow('did not confirm');
  });
  it('matches confirmation responses by target citizen and refreshes after success', async () => {
    const { social, send, deliver, requests } = setup();
    send.mockImplementation((type, fields = []) => {
      requests.push(packet(type, fields));
      if (type === P.ContactConfirm) deliver(packet(type, [i32(V.ReasonCode, 0), i32(V.ContactListCitizenId, 4)]));
      if (type === P.ContactList) deliver(end());
    });
    await social.command({ type: 'contact-confirm', citizen: 4 }); expect(num(requests[0], V.ContactListCitizenId)).toBe(4);
  });
  it('serializes commands lacking callback IDs and recovers the queue after rejection', async () => {
    const { social, requests, deliver } = setup();
    const first = social.command({ type: 'contact-add', name: 'Nobody' });
    const firstAssertion = expect(first).rejects.toThrow('No such citizen');
    const second = social.command({ type: 'contacts-list' }); await flush();
    expect(requests).toHaveLength(1); deliver(packet(P.ContactAdd, [i32(V.ReasonCode, 3)])); await firstAssertion;
    await flush(); expect(requests.at(-1)!.type).toBe(P.ContactList); deliver(end()); await second;
  });
  it('rejects tourist commands locally and drops notifications after close', async () => {
    const { social, requests, events } = setup(0);
    await expect(social.command({ type: 'contacts-list' })).rejects.toThrow('citizen login'); expect(requests).toHaveLength(0);
    social.close(); const count = events.length; social.receive(contact(2, 'Alice')); expect(events).toHaveLength(count);
  });
  it('validates malformed server contact records', () => {
    expect(() => contactFromPacket(contact(-1, 'Invalid'))).toThrow('Invalid contact');
    expect(() => contactFromPacket(contact(4, 'Invalid', 99))).toThrow('Invalid contact');
  });
});

describe('Axis telegram protocol', () => {
  it('exposes pending notification without automatically consuming messages', () => {
    const { deliver, requests, events } = setup(); deliver(packet(P.TelegramNotify));
    expect(events.at(-1)).toEqual({ type: 'telegram-pending', pending: true }); expect(requests).toHaveLength(0);
  });
  it('explicitly fetches queued telegrams and ends cleanly on no-message reason37', async () => {
    const { social, send, deliver, events } = setup(); let count = 0;
    send.mockImplementation(type => { if (type === P.TelegramGet) deliver(++count === 1 ? telegram('First', true) : count === 2 ? telegram('Second') : packet(P.TelegramDeliver, [i32(V.ReasonCode, 37)])); });
    await social.command({ type: 'telegram-fetch' }); await social.command({ type: 'telegram-fetch' }); await social.command({ type: 'telegram-fetch' });
    expect(events.filter(e => e.type === 'telegram').map(e => [e.message.text, e.message.status, e.message.direction])).toEqual([['First', 'received', 'incoming'], ['Second', 'received', 'incoming']]);
    expect(events.at(-1)).toEqual({ type: 'telegram-pending', pending: false });
  });
  it('does not lose a notification coalesced after a last-message response', async () => {
    const { social, send, deliver, events } = setup(); let count = 0;
    send.mockImplementation(type => { if (type === P.TelegramGet) { if (++count === 1) deliver(telegram('Old last message'), packet(P.TelegramNotify)); else deliver(telegram('New arrival')); } });
    await social.command({ type: 'telegram-fetch' });
    expect(events.at(-1)).toEqual({ type: 'telegram-pending', pending: true });
    expect(count).toBe(1); // The caller must persist before explicitly consuming again.
    await social.command({ type: 'telegram-fetch' });
    expect(events.filter(e => e.type === 'telegram').map(e => e.message.text)).toEqual(['Old last message', 'New arrival']);
  });
  it('collects exactly one message per explicit command and preserves pending state', async () => {
    const { social, send, deliver, events } = setup(); let count = 0;
    send.mockImplementation(type => { if (type === P.TelegramGet) { count++; deliver(telegram(`Item ${count}`, true)); } });
    await social.command({ type: 'telegram-fetch' }); expect(count).toBe(1);
    expect(events.at(-1)).toEqual({ type: 'telegram-pending', pending: true });
  });
  it('labels successful sends submitted, never delivered, even if the server silently blocks them', async () => {
    const { social, send, deliver, events, requests } = setup();
    send.mockImplementation((type, fields = []) => { requests.push(packet(type, fields)); deliver(packet(type, [i32(V.ReasonCode, 0)])); });
    await social.command({ type: 'telegram-send', to: ' SocialTester ', text: '  Preserve whitespace\nHello  ' });
    expect(string(requests[0], V.TelegramMessage)).toBe('  Preserve whitespace\nHello  ');
    expect(events.at(-1)).toMatchObject({ type: 'telegram', message: { to: 'SocialTester', from: 'Explorer', status: 'submitted', direction: 'outgoing' } });
  });
  it('emits no outgoing success message after a rejected send', async () => {
    const { social, send, deliver, events } = setup();
    send.mockImplementation(type => deliver(packet(type, [i32(V.ReasonCode, 232)])));
    await expect(social.command({ type: 'telegram-send', to: 'SocialTester', text: 'Test' })).rejects.toThrow('server policy');
    expect(events.some(e => e.type === 'telegram')).toBe(false);
  });
  it('does not attribute a late telegram result to a new login after disconnection', async () => {
    const { social, deliver, events } = setup();
    const pending = social.command({ type: 'telegram-send', to: 'SocialTester', text: 'Old session' }); await flush();
    deliver(packet(P.TelegramSend, [i32(V.ReasonCode, 0)])); social.close();
    await expect(pending).rejects.toThrow('Session ended');
    expect(events.some(e => e.type === 'telegram')).toBe(false);
  });
  it('decodes approximate age and untrusted contact-request text without auto-confirming', () => {
    const decoded = telegramFromPacket(telegram('\n\x01(4)SocialTester'), 'Explorer', 200000);
    expect(decoded).toMatchObject({ from: 'SocialTester', to: 'Explorer', time: 80000, contactRequest: { citizen: 4, name: 'SocialTester' } });
    expect(decoded.id).toMatch(/^[\da-f-]{36}$/);
  });
});

describe('social renderer-boundary validation', () => {
  it.each([
    { type: 'contact-add', name: '' }, { type: 'contact-add', name: 'A', options: 65536 },
    { type: 'contact-delete', citizen: 0 }, { type: 'contact-confirm', citizen: -1 },
    { type: 'contact-change', citizen: 3.5, options: 0 }, { type: 'contact-change', citizen: 0, options: NaN },
    { type: 'telegram-send', to: '*VERIFY', text: '123' }, { type: 'telegram-send', to: 'A', text: 'x'.repeat(1001) },
    { type: 'telegram-send', to: 'A', text: '\0bad' }, { type: 'telegram-send', to: 'A', text: '  ' },
  ])('rejects malformed or out-of-scope social commands %j', command => expect(() => assertCommand(command)).toThrow());
  it('accepts full1000-character telegrams and default privacy citizen0', () => {
    expect(() => assertCommand({ type: 'telegram-send', to: 'SocialTester', text: 'x'.repeat(1000) })).not.toThrow();
    expect(() => assertCommand({ type: 'contact-change', citizen: 0, options: 65535 })).not.toThrow();
  });
});
