/** Real local Axis social checks. Never signs in as Wayfarer or touches remote hosts.
 * Run `node scripts/axis-social-provision.mjs` once first. Existing contact options
 * are restored. Only fixture-authored queued telegrams are consumed.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { AxisClient } from '../src/main/protocol/axis-client';
import { CONTACT_OPTIONS, type ClientEvent, type TelegramMessage } from '../src/shared/types';

const database = join(import.meta.dirname, '..', '.runtime', 'axis', 'universe', 'universe.db');
const unrelated = Number(execFileSync('sqlite3', [database, 'SELECT COUNT(*) FROM telegram WHERE recipient_id IN (3,4) AND status=0 AND sender_id NOT IN (3,4)'], { encoding: 'utf8' }).trim());
assert.equal(unrelated, 0, 'Refusing to consume telegrams from non-fixture senders');
const aEvents: ClientEvent[] = [], bEvents: ClientEvent[] = [];
const a = new AxisClient(event => aEvents.push(event)), b = new AxisClient(event => bEvents.push(event));
const base = { host: '127.0.0.1', port: 16670, tls: false, world: 'Haven' };
const aOptions = { ...base, username: 'Explorer', password: 'WayfarerLocal42!' };
const bOptions = { ...base, username: 'SocialTester', password: 'SocialTesterLocal42!' };
const prefix = `Wayfarer social smoke ${randomUUID()}`;
const started = Date.now(); let checks = 0, bConnected = false;
type ContactSnapshot = Extract<ClientEvent, { type: 'contacts' }>;
let aInitial: ContactSnapshot | undefined, bInitial: ContactSnapshot | undefined;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function contacts(events: ClientEvent[]): ContactSnapshot {
  const value = [...events].reverse().find((event): event is ContactSnapshot => event.type === 'contacts');
  assert(value, 'Missing server contact snapshot'); return value;
}
function messages(events: ClientEvent[], from = 0): TelegramMessage[] { return events.slice(from).flatMap(e => e.type === 'telegram' && e.message.direction === 'incoming' ? [e.message] : []); }
function pending(events: ClientEvent[]) { return [...events].reverse().find(e => e.type === 'telegram-pending'); }
async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await pause(10); }
}
function passed(label: string) { checks++; console.log(`PASS ${label}`); }
async function restore(client: AxisClient, snapshot: ContactSnapshot, target: number) {
  const original = snapshot.contacts.find(contact => contact.citizen === target);
  if (original) await client.command({ type: 'contact-add', name: original.name, options: original.options });
  else await client.command({ type: 'contact-delete', citizen: target });
  await client.command({ type: 'contact-change', citizen: 0, options: snapshot.defaultOptions });
}

try {
  await a.command({ type: 'connect', options: aOptions });
  await b.command({ type: 'connect', options: bOptions }); bConnected = true;
  assert(aEvents.some(e => e.type === 'login' && e.citizen === 3)); assert(bEvents.some(e => e.type === 'login' && e.citizen === 4));
  await a.command({ type: 'contacts-list' }); await b.command({ type: 'contacts-list' });
  aInitial = contacts(aEvents); bInitial = contacts(bEvents);
  await a.command({ type: 'contact-change', citizen: 0, options: 0 }); await b.command({ type: 'contact-change', citizen: 0, options: 0 });
  // Clear only already queued messages whose sender preflight verified is a fixture account.
  for (const [client, events] of [[a, aEvents], [b, bEvents]] as const) {
    for (let count = 0; count < 100 && (pending(events) as { pending?: boolean } | undefined)?.pending; count++) await client.command({ type: 'telegram-fetch' });
  }
  passed('Two dedicated fixture citizens authenticate; existing privacy snapshots retained');

  await a.command({ type: 'contact-add', name: 'SocialTester' }); await b.command({ type: 'contact-add', name: 'Explorer' });
  const online = contacts(aEvents).contacts.find(contact => contact.citizen === 4);
  assert.equal(online?.state, 'online'); assert.equal(online?.world, 'Haven');
  passed('Contact add/list returns actual online state and world');

  b.disconnect(); bConnected = false;
  await waitFor(() => contacts(aEvents).contacts.find(c => c.citizen === 4)?.state === 'offline', 'contact offline broadcast');
  await b.command({ type: 'connect', options: bOptions }); bConnected = true;
  await waitFor(() => contacts(aEvents).contacts.find(c => c.citizen === 4)?.state === 'online', 'contact online broadcast');
  passed('Contact live offline/online status broadcasts');

  const beforeOnline = bEvents.length;
  await a.command({ type: 'telegram-send', to: 'SocialTester', text: `${prefix} online` });
  await waitFor(() => (pending(bEvents) as { pending?: boolean })?.pending === true, 'telegram pending notice');
  assert.equal(messages(bEvents, beforeOnline).length, 0, 'Notifications must not automatically consume');
  await b.command({ type: 'telegram-fetch' });
  assert.equal(messages(bEvents, beforeOnline)[0]?.text, `${prefix} online`); assert.equal(messages(bEvents, beforeOnline)[0]?.from, 'Explorer');
  passed('Online telegram notice, explicit collection and sender/body decode');

  const longText = (prefix + ' ').padEnd(1000, 'x'), beforeLong = bEvents.length;
  await a.command({ type: 'telegram-send', to: 'SocialTester', text: longText }); await b.command({ type: 'telegram-fetch' });
  assert.equal(messages(bEvents, beforeLong)[0]?.text.length, 1000);
  passed('Full 1000-character telegram round trip without truncation');

  b.disconnect(); bConnected = false;
  await a.command({ type: 'telegram-send', to: 'SocialTester', text: `${prefix} offline1` });
  await a.command({ type: 'telegram-send', to: 'SocialTester', text: `${prefix} offline2` });
  await b.command({ type: 'connect', options: bOptions }); bConnected = true;
  await waitFor(() => (pending(bEvents) as { pending?: boolean })?.pending === true, 'offline inbox notice');
  const beforeQueue = bEvents.length;
  await b.command({ type: 'telegram-fetch' }); assert.equal(messages(bEvents, beforeQueue).length, 1); assert.equal((pending(bEvents) as { pending: boolean }).pending, true);
  await b.command({ type: 'telegram-fetch' }); assert.deepEqual(messages(bEvents, beforeQueue).map(m => m.text), [`${prefix} offline1`, `${prefix} offline2`]);
  await b.command({ type: 'telegram-fetch' }); assert.equal(messages(bEvents, beforeQueue).length, 2); assert.equal((pending(bEvents) as { pending: boolean }).pending, false);
  passed('Offline queue survives reconnect; exactly one message collected per command and empty inbox reason37');

  await b.command({ type: 'contact-change', citizen: 3, options: CONTACT_OPTIONS.telegramOff });
  const blockedStart = bEvents.length;
  await a.command({ type: 'telegram-send', to: 'SocialTester', text: `${prefix} blocked` }); await b.command({ type: 'telegram-fetch' });
  assert.equal(messages(bEvents, blockedStart).length, 0);
  assert(aEvents.some(e => e.type === 'telegram' && e.message.text === `${prefix} blocked` && e.message.status === 'submitted'));
  await b.command({ type: 'contact-change', citizen: 3, options: 0 });
  passed('Privacy readback and real silently-blocked telegram reports submitted, not delivered');

  await b.command({ type: 'contact-change', citizen: 0, options: CONTACT_OPTIONS.requestBlocked });
  await a.command({ type: 'contact-delete', citizen: 4 }); const requestStart = bEvents.length;
  await a.command({ type: 'contact-add', name: 'SocialTester' }); await b.command({ type: 'telegram-fetch' });
  assert.deepEqual(messages(bEvents, requestStart)[0]?.contactRequest, { citizen: 3, name: 'Explorer' });
  await b.command({ type: 'contact-confirm', citizen: 3 });
  await b.command({ type: 'contact-change', citizen: 0, options: 0 });
  passed('Consent-required contact request telegram and explicit confirmation while requester online');

  await a.command({ type: 'contact-delete', citizen: 4 }); assert(!contacts(aEvents).contacts.some(c => c.citizen === 4));
  passed('Contact deletion readback');
  assert.deepEqual([...aEvents, ...bEvents].filter(event => event.type === 'error'), []);
  console.log(`All ${checks} social checks passed in ${Date.now() - started}ms.`);
} finally {
  if (!bConnected && bInitial) await b.command({ type: 'connect', options: bOptions }).then(() => { bConnected = true; }).catch(() => {});
  if (aInitial) await restore(a, aInitial, 4).catch(error => console.error('Explorer contact restore failed:', String(error)));
  if (bInitial && bConnected) await restore(b, bInitial, 3).catch(error => console.error('SocialTester contact restore failed:', String(error)));
  a.disconnect(); b.disconnect();
}
