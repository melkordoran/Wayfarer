import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { ClientCommand, ClientEvent } from '../src/shared/types';

const origin = 'http://127.0.0.1:5173';
const bridgeUrl = 'ws://127.0.0.1:5174/bridge';
const httpBase = 'http://127.0.0.1:5174';
const events: ClientEvent[] = [];
const checks: string[] = [];
const started = Date.now();
const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let serial = 0;
const socket = new WebSocket(bridgeUrl, { origin });

const opened = new Promise<void>((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
socket.on('message', bytes => {
  let message;
  try { message = JSON.parse(bytes.toString()); }
  catch { throw new Error('Bridge returned invalid JSON.'); }
  if (message.event) events.push(message.event);
  if (typeof message.id === 'number' && pending.has(message.id)) {
    const request = pending.get(message.id)!;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else if (message.ok === true) request.resolve();
    else request.reject(new Error('Bridge reply omitted acknowledgement.'));
  }
});
socket.on('close', () => {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Bridge closed before acknowledging command.')); }
  pending.clear();
});
function command(command: ClientCommand): Promise<void> {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Bridge ${command.type} command timed out.`)); }, 12000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, command }));
  });
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function pass(name: string) { checks.push(name); console.log(`PASS ${name}`); }
async function waitFor(predicate: (event: ClientEvent) => boolean, from = 0) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const event = events.slice(from).find(predicate);
    if (event) return event;
    await pause(25);
  }
  throw new Error('Expected bridge event did not arrive.');
}
async function proxy(asset: string, headers: Record<string, string>) {
  const url = new URL('/asset', httpBase); url.searchParams.set('url', asset);
  return fetch(url, { headers, signal: AbortSignal.timeout(6000) });
}
async function refusedOrigin() {
  const rejected = new WebSocket(bridgeUrl, { origin: 'https://untrusted.example' });
  let opened = false;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { rejected.terminate(); reject(new Error('Untrusted WebSocket did not close.')); }, 3000);
    rejected.once('open', () => { opened = true; rejected.close(); });
    rejected.once('error', () => {}); // Rejection normally emits ECONNRESET; it is the expected result.
    rejected.once('close', () => { clearTimeout(timer); resolve(); });
  });
  assert.equal(opened, false);
}

try {
  await opened;
  pass('Allowed preview Origin opens WebSocket bridge');
  await command({ type: 'connect', options: { host: '127.0.0.1', port: 16670, tls: false, username: 'Explorer', password: 'WayfarerLocal42!', world: 'Haven' } });
  assert(events.some(event => event.type === 'login' && event.citizen === 3));
  assert(events.some(event => event.type === 'status' && event.phase === 'online'));
  assert(events.some(event => event.type === 'worlds' && event.worlds.some(world => world.name === 'Haven')));
  const objects = new Map(events.flatMap(event => event.type === 'objects' ? event.objects.map(object => [object.id, object] as const) : []));
  assert(objects.size >= 32, `Expected fixture property through bridge, received ${objects.size}`);
  pass('Connect acknowledgement and real Universe/world/property events cross bridge');

  const chatStart = events.length;
  const message = `Bridge smoke ${Date.now()}`;
  await command({ type: 'chat', text: message });
  await waitFor(event => event.type === 'chat' && event.message.text === message, chatStart);
  await command({ type: 'move', position: { x: 1, y: 0, z: -25, yaw: 0 } });
  pass('Chat event and movement acknowledgement cross bridge');

  const headers = { Origin: origin, Referer: origin + '/' };
  const validAsset = await proxy('http://127.0.0.1:17400/models/sculpture.rwx', headers);
  assert.equal(validAsset.status, 200);
  assert.equal(validAsset.headers.get('x-asset-content-type'), 'text/plain');
  assert.equal(validAsset.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await validAsset.text(), /ModelBegin[\s\S]+ModelEnd/);
  pass('Asset proxy retrieves actual fixture RWX with safe response headers');

  const invalidAsset = await proxy('file:///etc/passwd', headers);
  assert.equal(invalidAsset.status, 400); await invalidAsset.arrayBuffer();
  pass('Asset proxy rejects non-HTTP resource URL');

  const invalidOrigin = await proxy('http://127.0.0.1:17400/models/sculpture.rwx', { ...headers, Origin: 'https://untrusted.example' });
  assert.equal(invalidOrigin.status, 403); await invalidOrigin.arrayBuffer();
  await refusedOrigin();
  pass('Untrusted Origin refused by both HTTP asset and WebSocket endpoints');

  const malformedReferer = await proxy('http://127.0.0.1:17400/models/sculpture.rwx', { Referer: '%' });
  assert.equal(malformedReferer.status, 403); await malformedReferer.arrayBuffer();
  const afterMalformed = await proxy('http://127.0.0.1:17400/models/sculpture.rwx', headers);
  assert.equal(afterMalformed.status, 200); await afterMalformed.arrayBuffer();
  pass('Malformed Referer returns 403 and bridge remains healthy');

  const disconnectStart = events.length;
  await command({ type: 'disconnect' });
  await waitFor(event => event.type === 'status' && event.phase === 'disconnected', disconnectStart);
  pass('Disconnect acknowledgement and session cleanup event cross bridge');
  assert.deepEqual(events.filter(event => event.type === 'error'), []);
  const result = { passed: true, timestamp: new Date().toISOString(), checks, elapsedMs: Date.now() - started };
  await writeFile(join(import.meta.dirname, '..', '.runtime', 'bridge-smoke.json'), JSON.stringify(result, null, 2));
  console.log(`All ${checks.length} bridge checks passed in ${result.elapsedMs}ms.`);
} finally {
  if (socket.readyState === WebSocket.OPEN) await command({ type: 'disconnect' }).catch(() => {});
  socket.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  pending.clear();
}
