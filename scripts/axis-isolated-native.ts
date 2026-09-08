/** Launch only the explicitly selected supported packaged app with a fresh QA
 * profile. No automatic login. q/EOF/signals stop only this owned native process. */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { withIsolatedAxis } from './axis-isolated.mjs';
import { assertNativePackageUnchanged, matchesNativeQaProcess, nativeLaunchArguments, nativeQaArguments, readNativeQaReceipt, verifyNativeQaPackage, type NativeQaExpected, type NativeQaMode, type NativeQaProcess } from './native-qa-helpers';

const root = dirname(import.meta.dirname), args = nativeQaArguments(process.argv.slice(2));
// Unsupported/old packages fail here, BEFORE creating a profile or starting Axis.
const bundle = verifyNativeQaPackage(args.app, root);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Owner = { directory: string; registerCleanup(callback: () => void | Promise<void>): () => void; writeReport(name: string, value: unknown): string };
function identity(pid: number): string | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

async function visit(owner: Owner, qa: NativeQaMode) {
  const profileDir = join(owner.directory, 'native-profile'); mkdirSync(profileDir, { mode: 0o700 });
  if (realpathSync(profileDir) !== profileDir || !lstatSync(profileDir).isDirectory()) throw new Error('Native QA profile must be a fresh real directory.');
  owner.writeReport('native-package-preflight', bundle);
  assertNativePackageUnchanged(bundle);
  const logPath = join(owner.directory, 'logs/native-app.log'), log = openSync(logPath, 'wx', 0o600);
  const child = spawn(bundle.executable, nativeLaunchArguments(profileDir, qa), {
    cwd: owner.directory, stdio: ['ignore', log, log], env: {
      PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: join(owner.directory, 'tmp'),
      // In particular, do not inherit ELECTRON_RUN_AS_NODE, NODE_OPTIONS,
      // WAYFARER_DEV or unrelated application configuration overrides.
    },
  });
  closeSync(log);
  let record: NativeQaProcess | null = null;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => reject(new Error('The owned packaged native process could not start.')));
  });
  void exited.catch(() => {});
  const earlyExit = exited.then(() => { throw new Error('The native app exited before a verified ready receipt.'); });
  void earlyExit.catch(() => {});
  const initialized = (async () => {
    await new Promise<void>((yes, no) => { child.once('spawn', yes); child.once('error', no); });
    record = { pid: child.pid!, executable: bundle.executable, profileDir, birthAndCommand: identity(child.pid!) };
    if (!matchesNativeQaProcess(record, record.birthAndCommand)) throw new Error('Could not establish exact native child ownership.');
    owner.writeReport('native-process', record);
  })();
  owner.registerCleanup(async () => {
    await initialized.catch(() => {});
    if (child.exitCode !== null || child.signalCode !== null) {
      owner.writeReport('native-stopped', { pid: child.pid, profileDir, exitCode: child.exitCode, signalCode: child.signalCode, alreadyExited: true, retained: true }); return;
    }
    if (!record || !matchesNativeQaProcess(record, identity(child.pid!))) throw new Error('Preserving native process whose ownership cannot be confirmed.');
    child.kill('SIGTERM'); const until = Date.now() + 5000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < until) await pause(50);
    if (child.exitCode === null && child.signalCode === null) {
      if (!matchesNativeQaProcess(record, identity(child.pid!))) throw new Error('Native process identity changed during shutdown; preserving it.');
      child.kill('SIGKILL'); const hardUntil = Date.now() + 2000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < hardUntil) await pause(50);
    }
    if (child.exitCode === null && child.signalCode === null) throw new Error('The owned native process did not exit.');
    owner.writeReport('native-stopped', { pid: child.pid, profileDir, exitCode: child.exitCode, signalCode: child.signalCode, retained: true });
  });
  await Promise.race([initialized, earlyExit]);
  const expected: NativeQaExpected = { pid: child.pid!, version: bundle.version, profileDir, appPath: bundle.appPath, qa };
  async function receipt(ready: boolean) {
    const path = join(profileDir, ready ? 'native-ready.json' : 'native-startup.json'), until = Date.now() + 25000;
    while (Date.now() < until) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Native app exited while awaiting its private receipt.');
      try { return readNativeQaReceipt(path, expected, ready); }
      catch (error) {
        // A fresh wx write can be observed while its small JSON body is still in
        // flight. Only missing/incomplete JSON is retried; identity errors fail.
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await Promise.race([pause(100), earlyExit]);
    }
    throw new Error(`Timed out waiting for verified ${ready ? 'ready' : 'startup'} receipt. Private log: ${logPath}`);
  }
  const startup = await receipt(false), ready = await receipt(true);
  assertNativePackageUnchanged(bundle);
  owner.writeReport('native-ready-verified', { startup, ready, archiveSha256: bundle.archiveSha256, executableSha256: bundle.executableSha256 });
  console.log(`Verified packaged Wayfarer ${bundle.version} · Isolated QA`);
  console.log(`Private native profile: ${profileDir}`);
  console.log(`Private run: ${owner.directory}`);
  if (qa.mode === 'fixture') console.log(`Use only fresh manifest credentials with Universe 127.0.0.1:${qa.universePort}; no automatic login was performed.`);
  else console.log('Offline QA policy confirmed: no native server connections or external assets are allowed.');
  console.log('Type q then Enter to stop this owned QA app. Unsaved test drafts may be discarded; the private profile is retained.');
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  owner.registerCleanup(() => input.close());
  const finished = new Promise<void>(resolve => { input.on('line', line => { if (line.trim().toLowerCase() === 'q') resolve(); }); input.once('close', resolve); });
  await Promise.race([finished, exited.then(result => {
    if (result.code !== 0) throw new Error(`Native QA process exited unexpectedly (${result.code ?? result.signal}).`);
  })]);
}

if (!args.offline) {
  await withIsolatedAxis(fixture => visit(fixture, { mode: 'fixture', universePort: fixture.ports.universe, worldPort: fixture.ports.world, assetPort: fixture.ports.assets }), { restrictMovement: args.restrictMovement });
} else {
  // Offline mode never invokes Axis preparation, keys, imports, or listeners.
  const runtime = join(root, '.runtime');
  if (realpathSync(runtime) !== runtime || !lstatSync(runtime).isDirectory()) throw new Error('The runtime parent must be a real directory.');
  const directory = mkdtempSync(join(runtime, 'native-qa-'));
  for (const name of ['logs', 'reports', 'tmp']) mkdirSync(join(directory, name), { mode: 0o700 });
  const callbacks: Array<() => void | Promise<void>> = [];
  let stopping = false, stopPromise: Promise<void> | undefined;
  const owner: Owner = {
    directory,
    registerCleanup(callback) {
      if (stopping || callbacks.length >= 8) throw new Error('Offline QA cleanup registration is unavailable.');
      callbacks.push(callback); return () => { if (!stopping) { const index = callbacks.indexOf(callback); if (index >= 0) callbacks.splice(index, 1); } };
    },
    writeReport(name, value) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) throw new Error('Invalid private report name.');
      const path = join(directory, 'reports', `${name}-${Date.now()}.json`), bytes = JSON.stringify(value, null, 2);
      if (Buffer.byteLength(bytes) > 2_000_000) throw new Error('Private report exceeds the limit.');
      writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' }); return path;
    },
  };
  function stop() {
    if (stopPromise) return stopPromise; stopping = true;
    stopPromise = (async () => {
      const failures: string[] = [];
      for (const callback of [...callbacks].reverse()) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([Promise.resolve().then(callback), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Offline QA cleanup timed out.')), 10000); })]); }
        catch (error) { failures.push(error instanceof Error ? error.message : 'Cleanup failed'); }
        finally { clearTimeout(timer); }
      }
      owner.writeReport('offline-stop', { failures, retainedDirectory: directory, axisStarted: false });
      if (failures.length) throw new Error(`Offline QA cleanup needs attention; inspect ${directory}`);
    })(); return stopPromise;
  }
  const onInterrupt = () => { void stop().then(() => process.exit(130), () => process.exit(1)); };
  const onTerminate = () => { void stop().then(() => process.exit(143), () => process.exit(1)); };
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
  try { await visit(owner, { mode: 'offline' }); }
  finally { try { await stop(); } finally { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); } }
}
