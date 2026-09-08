/** Read-only fixture diagnostic. Run only when Explorer is not in use:
 * npx tsx scripts/axis-universe-only-smoke.ts --explorer-is-free
 * One browser session per citizen is allowed, so login can replace that citizen's
 * existing session. Never enters World, mutates contacts, or retrieves telegrams.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AxisClient } from '../src/main/protocol/axis-client';
import { AxisTransport } from '../src/main/protocol/transport';
import { P } from '../src/main/protocol/constants';
import type { ClientEvent } from '../src/shared/types';

assert(process.argv.includes('--explorer-is-free'), 'Confirm Explorer is free before running with --explorer-is-free');
const runtime = join(import.meta.dirname, '..', '.runtime', 'axis');
const pidRecords = () => Object.fromEntries(['universe', 'world', 'assets'].map(name => [name, JSON.parse(readFileSync(join(runtime, `${name}.pid.json`), 'utf8'))]));
const before = pidRecords(), started = Date.now(), timestamp = new Date(started).toISOString();
const packets: number[] = [], phases: string[] = [], events: ClientEvent[] = [];
const allowed = new Set<number>([P.PublicKeyRequest, P.PublicKeyResponse, P.StreamKeyResponse, P.Heartbeat, P.Login, P.WorldList, P.ContactList]);
const send = AxisTransport.prototype.send, connect = AxisTransport.prototype.connect;
// Fail closed if a future client regression attempts a World lookup, telegram
// retrieval, contact mutation, or any connection other than the local Universe.
AxisTransport.prototype.send = function (this: AxisTransport, type, fields = [], version = this.version, flags = 2) {
  assert(allowed.has(type), `Read-only diagnostic refused outgoing packet ${type}`);
  packets.push(type); return send.call(this, type, fields, version, flags);
};
AxisTransport.prototype.connect = function (this: AxisTransport, host, port, secure = false) {
  assert.equal(host, '127.0.0.1'); assert.equal(port, 16670); assert.equal(secure, false);
  return connect.call(this, host, port, secure);
};
const client = new AxisClient(event => { events.push(event); if (event.type === 'status') phases.push(event.phase); });
let failure: string | undefined;
let contactCount: number | undefined;
let worlds: Extract<ClientEvent, { type: 'worlds' }>['worlds'] | undefined;
try {
  await client.command({ type: 'connect', options: {
    host: '127.0.0.1', port: 16670, tls: false,
    username: 'Explorer', password: 'WayfarerLocal42!', world: '',
  } });
  assert(events.some(event => event.type === 'login' && event.citizen === 3), 'Expected Explorer citizen 3');
  assert.equal(phases.at(-1), 'connected');
  assert(!phases.includes('entering') && !phases.includes('online'), 'Must remain Universe-only');
  worlds = [...events].reverse().find((event): event is Extract<ClientEvent, { type: 'worlds' }> => event.type === 'worlds')?.worlds;
  assert(worlds, 'Expected world-list completion');
  await client.command({ type: 'contacts-list' });
  const contacts = [...events].reverse().find((event): event is Extract<ClientEvent, { type: 'contacts' }> => event.type === 'contacts');
  assert(contacts, 'Expected read-only contact-list completion'); contactCount = contacts.contacts.length;
  assert.equal(phases.at(-1), 'connected');
  assert(!events.some(event => event.type === 'error'), 'Unexpected client error event');
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  client.disconnect();
  AxisTransport.prototype.send = send; AxisTransport.prototype.connect = connect;
}
const after = pidRecords();
if (JSON.stringify(before) !== JSON.stringify(after)) failure ??= 'Service PID records changed during diagnostic';
const report = {
  timestamp, passed: !failure, elapsedMs: Date.now() - started,
  endpoint: { host: '127.0.0.1', port: 16670, tls: false }, citizen: 3,
  startingWorld: '', phases, worldList: worlds, contactCount,
  outgoingPacketTypes: packets,
  forbiddenPacketsSent: packets.filter(type => !allowed.has(type)),
  servicePidRecordsUnchanged: JSON.stringify(before) === JSON.stringify(after),
  disconnected: phases.at(-1) === 'disconnected',
  ...(failure ? { error: failure } : {}),
};
const directory = join(runtime, 'reports'); mkdirSync(directory, { recursive: true, mode: 0o700 });
const path = join(directory, `universe-only-${timestamp.replace(/[:.]/g, '-')}.json`);
writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ ...report, reportPath: path }, null, 2));
if (failure) process.exitCode = 1;
