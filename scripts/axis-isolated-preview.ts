/** Real-app interactive QA, on separately owned ports and fresh disposable data.
 * Run with `npx tsx scripts/axis-isolated-preview.ts`; type q + Enter to stop.
 * No automatic login or password output. Saved primary endpoints are blocked. */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { matchesOwnedProcess, withIsolatedAxis } from './axis-isolated.mjs';
import { isolatedPreviewFileAllowlist } from './isolated-preview-config';

const root = dirname(import.meta.dirname), uiPort = 5183, bridgePort = 5184;
if (process.argv.slice(2).some(argument => argument !== '--restricted') || process.argv.slice(2).length > 1) throw new Error('Usage: npx tsx scripts/axis-isolated-preview.ts [--restricted]');
const restrictMovement = process.argv.includes('--restricted');
const uiOrigin = `http://127.0.0.1:${uiPort}`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function identity(pid: number): string | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
// Check both new ports without connecting to, changing, or stopping their owners.
const reserved = [];
try {
  for (const port of [uiPort, bridgePort]) {
    const server = createNetServer(); reserved.push(server);
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen({ host: '127.0.0.1', port, exclusive: true }, yes); });
  }
} finally { await Promise.all(reserved.map(server => new Promise<void>(resolve => server.close(() => resolve())))); }

await withIsolatedAxis(async fixture => {
  const script = join(root, 'scripts/bridge.ts'), logPath = join(fixture.directory, 'logs/preview-bridge.log');
  const fd = openSync(logPath, 'wx', 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', script, `--fixture=${join(fixture.directory, 'manifest.json')}`], {
    cwd: root, stdio: ['ignore', fd, fd], env: {
      PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8',
      TMPDIR: join(fixture.directory, 'tmp'), NODE_ENV: 'development',
      WAYFARER_PREVIEW_BRIDGE_PORT: String(bridgePort), WAYFARER_PREVIEW_ORIGIN: uiOrigin,
      WAYFARER_PREVIEW_ISOLATED: '1', WAYFARER_PREVIEW_ISOLATED_UNIVERSE_PORT: String(fixture.ports.universe), WAYFARER_PREVIEW_ISOLATED_WORLD_PORT: String(fixture.ports.world), WAYFARER_PREVIEW_ISOLATED_ASSET_PORT: String(fixture.ports.assets),
    },
  });
  closeSync(fd);
  // Observe exit immediately; a bridge that dies between its ready log and the
  // interactive wait must still reject the visit. Attach a rejection observer
  // now, while setup may await other work, to avoid an unhandled rejection.
  const bridgeExited = new Promise<never>((_resolve, reject) => {
    child.once('exit', () => reject(new Error('The isolated preview bridge exited unexpectedly.')));
    child.once('error', () => reject(new Error('The isolated preview bridge could not start.')));
  });
  void bridgeExited.catch(() => {});
  let record: { pid: number; executable: string; directory: string; birthAndCommand: string | null } | null = null;
  const initialized = (async () => {
    await new Promise<void>((yes, no) => { child.once('spawn', yes); child.once('error', no); });
    record = { pid: child.pid!, executable: script, directory: fixture.directory, birthAndCommand: identity(child.pid!) };
    if (!matchesOwnedProcess(record, record.birthAndCommand)) throw new Error('Could not confirm isolated preview bridge ownership.');
    fixture.writeReport('preview-bridge-process', record);
  })();
  fixture.registerCleanup(async () => {
    await initialized.catch(() => {});
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!record || !matchesOwnedProcess(record, identity(child.pid!))) throw new Error('Preserving an unverified preview bridge process.');
    child.kill('SIGTERM'); const until = Date.now() + 5000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < until) await delay(50);
    if (child.exitCode === null && child.signalCode === null) {
      if (!matchesOwnedProcess(record, identity(child.pid!))) throw new Error('Preview bridge identity changed during shutdown.');
      child.kill('SIGKILL'); const hardUntil = Date.now() + 2000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < hardUntil) await delay(50);
    }
    if (child.exitCode === null && child.signalCode === null) throw new Error('Owned preview bridge did not exit.');
  });
  await Promise.race([initialized, bridgeExited]);
  const deadline = Date.now() + 10000;
  while (!readFileSync(logPath, 'utf8').includes(`Wayfarer preview bridge listening on 127.0.0.1:${bridgePort}`)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`Isolated preview bridge failed; inspect ${logPath}`);
    await delay(100);
  }
  let closingUi = false;
  const uiReady = (async () => {
  const vite = await createViteServer({
    configFile: false, envDir: false, envPrefix: [], root, base: './', plugins: [react()], cacheDir: join(fixture.directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: uiPort, strictPort: true, open: false,
      fs: { strict: true, allow: isolatedPreviewFileAllowlist(root, fixture.directory) }, proxy: {
      '/bridge': { target: `http://127.0.0.1:${bridgePort}`, ws: true },
      '^/asset(?:\\?|$)': { target: `http://127.0.0.1:${bridgePort}` },
    } },
  });
  if (!closingUi) await vite.listen();
  return vite;
  })();
  // Await any in-flight Vite initialization/listen before closing it, so signal
  // cleanup cannot finish immediately before a late listener comes online.
  fixture.registerCleanup(async () => { closingUi = true; await (await uiReady).close(); });
  await uiReady;
  if (closingUi) return;
  if (child.exitCode !== null || child.signalCode !== null) throw new Error('The isolated preview bridge exited before interactive readiness.');
  fixture.writeReport('preview-ready', { uiOrigin, bridgePort, bridgePid: child.pid, fixture: fixture.directory, isolatedUniverse: fixture.ports.universe, isolatedAssets: fixture.ports.assets });
  console.log(`Isolated Wayfarer preview: ${uiOrigin}`);
  console.log(`Private fixture: ${fixture.directory}`);
  if (fixture.restrictMovement) console.log('Restricted movement profile: world flying/teleport rules disabled; caretaker exceptions remain server-owned.');
  console.log('Use the private manifest credentials with Universe 127.0.0.1:' + fixture.ports.universe + '. Primary and remote endpoints are blocked.');
  console.log('Type q then Enter to stop this preview and its owned disposable services.');
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  fixture.registerCleanup(() => input.close());
  const inputFinished = new Promise<void>(yes => {
    input.on('line', line => { if (line.trim().toLowerCase() === 'q') yes(); });
    input.once('close', yes);
  });
  await Promise.race([inputFinished, bridgeExited]);
}, { restrictMovement });
