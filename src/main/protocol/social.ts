import { randomUUID } from 'node:crypto';
import type { ClientEvent, Contact, ContactState, SocialCommand, TelegramMessage } from '../../shared/types';
import { assertCommand } from '../../shared/validation';
import { i32, num, str, string, type Packet } from './codec';
import { P, V } from './constants';
import type { AxisTransport } from './transport';

/** Independent implementation of pinned Axis Universe protocol facts:
 * 8ecd16abd46853f91c7af04f07d4d518f465017f ContactHandler/ContactService,
 * TelegramHandler/TelegramService/TelegramRepository and UniverseClient notifications.
 * Contact-change has no ACK. Telegram collection marks a message consumed on the
 * server before it reaches this client. Fetch is explicit; no automatic retrieval
 * occurs on notifications. A successful send may be silently privacy-blocked and
 * therefore means "submitted", never "delivered". No server telegram ID is exposed.
 */
const STATES: ContactState[] = ['offline', 'online', 'invalid', 'away', 'unknown', 'removed', 'default'];
const MAX_CONTACTS = 10000;
function accepted(packet: Packet, action: string): void {
  const reason = num(packet, V.ReasonCode);
  const messages: Record<number, string> = { 3: 'No such citizen (contact confirmation requires the citizen to be online)', 31: 'Citizen login required', 38: 'Unable to set contact', 232: 'Not allowed by server policy' };
  if (reason) throw new Error(`${action}: ${messages[reason] ?? 'Server rejected request'} (Axis ${reason})`);
}

export function contactFromPacket(packet: Packet): Contact {
  const citizen = num(packet, V.ContactListCitizenId), state = num(packet, V.ContactListStatus), options = num(packet, V.ContactListOptions);
  if (!Number.isInteger(citizen) || citizen <= 0 || citizen > 0x7fffffff || !STATES[state] || options < 0 || options > 65535) throw new Error('Invalid contact record');
  const name = string(packet, V.ContactListName), world = string(packet, V.ContactListWorld);
  if (name.length > 256 || world.length > 256) throw new Error('Contact text exceeds client limit');
  return { citizen, name, state: STATES[state], world, options };
}
export function telegramFromPacket(packet: Packet, recipient: string, now = Date.now()): TelegramMessage {
  const text = string(packet, V.TelegramMessage), match = /^\n\x01\((\d{1,10})\)([^\r\n]+)$/.exec(text);
  if (text.length > 4096 || string(packet, V.TelegramCitizenName).length > 256) throw new Error('Telegram text exceeds client limit');
  const citizen = match ? Number(match[1]) : 0;
  const request = match && citizen > 0 && citizen <= 0x7fffffff ? { citizen, name: match[2] } : undefined;
  return { id: randomUUID(), direction: 'incoming', from: string(packet, V.TelegramCitizenName), to: recipient, text,
    time: now - (num(packet, V.TelegramAge) >>> 0) * 1000, status: 'received', ...(request ? { contactRequest: request } : {}) };
}

export class AxisSocial {
  private contacts = new Map<number, Contact>();
  private batch?: Map<number, Contact>;
  private defaultOptions = 0;
  private telegramNotice = 0;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private transport: AxisTransport, private emit: (event: ClientEvent) => void,
    private identity: () => { citizen: number; name: string }) {}

  close(): void {
    this.closed = true; this.contacts.clear(); this.batch = undefined;
    this.emit({ type: 'contacts', contacts: [], defaultOptions: 0 }); this.emit({ type: 'telegram-pending', pending: false });
  }
  receive(packet: Packet): boolean {
    if (this.closed) return false;
    if (packet.type === P.TelegramNotify) { this.telegramNotice++; this.emit({ type: 'telegram-pending', pending: true }); return true; }
    if (packet.type !== P.ContactList) return false;
    if (num(packet, V.ContactListCitizenId) === 0) {
      // Only citizen zero ends a list. Live status notifications also have More=0.
      this.defaultOptions = num(packet, V.ContactListOptions) & 65535;
      if (this.batch) { this.contacts = this.batch; this.batch = undefined; }
      this.publishContacts(); return true;
    }
    const contact = contactFromPacket(packet);
    if (num(packet, V.ContactListMore)) {
      this.batch ??= new Map(); this.setContact(this.batch, contact);
    } else {
      this.setContact(this.contacts, contact); if (this.batch) this.setContact(this.batch, contact);
      this.publishContacts();
    }
    return true;
  }
  private setContact(target: Map<number, Contact>, contact: Contact): void {
    if (contact.state === 'removed') target.delete(contact.citizen);
    else {
      if (!target.has(contact.citizen) && target.size >= MAX_CONTACTS) throw new Error('Contact list exceeds client limit');
      target.set(contact.citizen, contact);
    }
  }
  private publishContacts(): void {
    this.emit({ type: 'contacts', contacts: [...this.contacts.values()].map(contact => ({ ...contact })).sort((a, b) => a.name.localeCompare(b.name)), defaultOptions: this.defaultOptions });
  }
  command(command: SocialCommand): Promise<void> {
    assertCommand(command);
    // These packets lack request IDs. Serialize to prevent one request consuming
    // another's reply, and use a fresh list as the ContactChange ordering barrier.
    const pending = this.queue.catch(() => {}).then(async () => {
      if (this.closed || this.identity().citizen <= 0) throw new Error('Contacts and telegrams require a citizen login');
      switch (command.type) {
        case 'contacts-list': await this.refreshContacts(); break;
        case 'contact-add': {
          accepted(await this.transport.request(P.ContactAdd, [str(V.ContactListName, command.name.trim()), i32(V.ContactListOptions, command.options ?? 0)]), 'Add contact');
          await this.refreshContacts(); break;
        }
        case 'contact-delete': {
          accepted(await this.transport.request(P.ContactDelete, [i32(V.ContactListCitizenId, command.citizen)]), 'Delete contact');
          await this.refreshContacts(); break;
        }
        case 'contact-change': {
          this.transport.send(P.ContactChange, [i32(V.ContactListCitizenId, command.citizen), i32(V.ContactListOptions, command.options)]);
          await this.refreshContacts();
          const actual = command.citizen === 0 ? this.defaultOptions : this.contacts.get(command.citizen)?.options;
          if (actual !== command.options) throw new Error('Server did not confirm the requested contact options');
          break;
        }
        case 'contact-confirm': {
          accepted(await this.transport.request(P.ContactConfirm, [i32(V.ContactListCitizenId, command.citizen), i32(V.ContactListOptions, command.options ?? 0)], P.ContactConfirm,
            packet => num(packet, V.ContactListCitizenId) === command.citizen), 'Confirm contact');
          await this.refreshContacts(); break;
        }
        case 'telegram-send': {
          const to = command.to.trim();
          accepted(await this.transport.request(P.TelegramSend, [str(V.TelegramTo, to), str(V.TelegramMessage, command.text)]), 'Submit telegram');
          if (this.closed) throw new Error('Session ended before telegram submission completed');
          this.emit({ type: 'telegram', message: { id: randomUUID(), direction: 'outgoing', from: this.identity().name, to, text: command.text, time: Date.now(), status: 'submitted' } });
          break;
        }
        case 'telegram-fetch': await this.collectTelegrams(); break;
      }
    });
    this.queue = pending; return pending;
  }
  private async refreshContacts(): Promise<void> {
    this.batch = new Map();
    try {
      const response = await this.transport.request(P.ContactList, [], P.ContactList, packet => num(packet, V.ContactListCitizenId) === 0);
      accepted(response, 'Load contacts');
    } catch (error) { this.batch = undefined; throw error; }
  }
  private async collectTelegrams(): Promise<void> {
    // Exactly one irreversible retrieval. The caller must persist this event
    // successfully before explicitly requesting the next pending message.
    const notice = this.telegramNotice;
    const response = await this.transport.request(P.TelegramGet, [], P.TelegramDeliver);
    if (this.closed) throw new Error('Session ended before telegram retrieval completed');
    if (num(response, V.ReasonCode) === 37) {
      this.emit({ type: 'telegram-pending', pending: notice !== this.telegramNotice });
      return;
    }
    accepted(response, 'Receive telegram');
    this.emit({ type: 'telegram', message: telegramFromPacket(response, this.identity().name) });
    const more = !!num(response, V.TelegramsMoreRemain) || notice !== this.telegramNotice;
    this.emit({ type: 'telegram-pending', pending: more });
  }
}
