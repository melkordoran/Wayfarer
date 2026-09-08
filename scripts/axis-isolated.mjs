/** Disposable, separately owned integration fixtures. Importing this module never
 * starts a process or writes a file. Existing .runtime/axis is strictly read-only.
 * There is deliberately NO attach/stop-by-manifest API: stale JSON cannot confer
 * authority to signal a process. Only live child handles from this module can. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { avatarFixtureAssets } from './axis-avatar-assets.mjs';
import { directXFixtureAssets } from './directx-fixture-assets.mjs';
import { directXAnimationAssets, withDirectXAnimationCatalog } from './directx-animation-assets.mjs';
import { restrictFixtureMovement } from './axis-isolated-attributes.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = join(projectRoot, '.runtime'), primaryRoot = join(runtimeRoot, 'axis');
const dotnet = join(runtimeRoot, 'dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const assetScript = join(projectRoot, 'scripts', 'axis-isolated-assets.mjs');
const pins = Object.freeze({ universe: '8ecd16abd46853f91c7af04f07d4d518f465017f', world: 'c3e7486fc153ac31b3df1a07bc2b03d20e348152', platform: 'f18054d5d16e3869d54243788bced30b59cccf05' });
const binaries = Object.freeze({ universe: join(primaryRoot, 'bin/universe/Axis.UniverseServer.dll'), world: join(primaryRoot, 'bin/world/Axis.WorldServer.dll'), seed: join(primaryRoot, 'bin/seed/AxisFixture.dll') });
export const ISOLATED_PORTS = Object.freeze({ universe: 26670, world: 27000, assets: 27400 });
const owned = new WeakMap();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const privateWrite = (path, bytes) => writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });

export function validateIsolatedPorts(value = ISOLATED_PORTS) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'assets,universe,world') throw new Error('Exactly universe, world and assets ports are required.');
  const ports = { universe: value.universe, world: value.world, assets: value.assets };
  for (const port of Object.values(ports)) if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || [16670, 17000, 17400].includes(port)) throw new Error('Isolated ports must be valid non-primary unprivileged ports.');
  if (new Set(Object.values(ports)).size !== 3) throw new Error('Isolated ports must be distinct.');
  return Object.freeze(ports);
}

/** Prove a port is bindable; do not connect to any existing service. The start
 * path repeats this check. OS bind arbitration, plus child health checks, handles
 * the unavoidable release-to-spawn race without killing an occupying process. */
export async function assertPortsFree(ports) {
  validateIsolatedPorts(ports);
  const reservations = [];
  try {
    for (const port of Object.values(ports)) {
      const server = createServer(); reservations.push(server);
      await new Promise((yes, no) => { server.once('error', no); server.listen({ host: '127.0.0.1', port, exclusive: true }, yes); });
    }
  } finally { await Promise.all(reservations.map(server => new Promise(resolve => server.close(() => resolve())))); }
}

export function assertIsolatedDirectory(directory, expectedRoot = runtimeRoot) {
  const parent = realpathSync(expectedRoot), candidate = resolve(directory);
  if (dirname(candidate) !== parent || !/^axis-isolated-[A-Za-z0-9]{6,}$/.test(candidate.slice(parent.length + 1))) throw new Error('Not a directly owned isolated fixture directory.');
  if (lstatSync(candidate).isSymbolicLink() || realpathSync(candidate) !== candidate || !lstatSync(candidate).isDirectory()) throw new Error('Isolated fixture directories cannot be symlinks.');
  return candidate;
}

export function isolatedConfigurations(directory, ports, privateKey, databasePassword, adminPassword) {
  validateIsolatedPorts(ports);
  if (!/^[A-Za-z0-9+/=]+$/.test(privateKey) || !/^[a-f0-9]{64}$/.test(databasePassword) || !/^[a-f0-9]{48}$/.test(adminPassword)) throw new Error('Invalid generated fixture key material.');
  return {
    universe: `Log:\n  Console: true\nDatabase:\n  File: ${JSON.stringify(join(directory, 'universe/universe.db'))}\n  Password: '${databasePassword}'\n  InitialCitizenNumber: 2\nOptions:\n  AllowImmigration: false\n  AllowCitizenAdd: true\n  AllowCitizenEdit: true\n  AllowLicenseManagement: true\n  MaxContacts: 50\n  MaxConnectionsPerIpPerMinute: 0\nLicense:\n  PrivateKey: '${privateKey}'\n  Name: wayfarer-isolated\n  Address: 127.0.0.1\nListen:\n  Address: 127.0.0.1\n  Port: ${ports.universe}\nEmail:\n  Settings:\n    Enable: false\n`,
    attributes: 'name: Wayfarer isolated integration\nbrowser_minimum: 1250\nbrowser_release: 1682\nbrowser_beta: 1682\nallow_tourists: true\nallow_immigration: false\nenable_user_list: true\nstart_world: Haven\nwelcome_message: Original disposable integration fixture.\n',
    world: `Universe:\n  Host: 127.0.0.1\n  Port: ${ports.universe}\nListen:\n  Address: 127.0.0.1\n  Port: ${ports.world}\nWorldServer:\n  AutoStart: true\n  DataDirectory: ${JSON.stringify(join(directory, 'world/data'))}\n  AdminPassword: '${adminPassword}'\n  AlwaysRequireAdminPassword: true\n  DefaultObjectPath: http://127.0.0.1:${ports.assets}/\n  MinimumBrowserVersion: 1250\n  RestrictedRadiusAroundEntryPoint: false\n  GlobalAvatarPositions: true\n`,
  };
}

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
export function matchesOwnedProcess(record, currentIdentity) {
  return Boolean(record && Number.isSafeInteger(record.pid) && record.pid > 1 &&
    typeof record.birthAndCommand === 'string' && record.birthAndCommand.length > 25 &&
    currentIdentity === record.birthAndCommand && typeof record.directory === 'string' &&
    /^axis-isolated-[A-Za-z0-9]{6,}$/.test(record.directory.split(sep).at(-1) || '') &&
    currentIdentity.includes(`=${record.directory}/`) && record.birthAndCommand.includes(record.executable));
}

function filesUnder(path) {
  if (!existsSync(path)) return [];
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`Refusing to follow a source symlink: ${path}`);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  return readdirSync(path).sort().flatMap(name => filesUnder(join(path, name)));
}
function primarySnapshot() {
  const paths = [join(primaryRoot, 'universe'), join(primaryRoot, 'world'), join(primaryRoot, 'bin'), join(projectRoot, 'public/assets'), ...['universe', 'world', 'assets'].map(name => join(primaryRoot, `${name}.pid.json`)), join(primaryRoot, 'seeded.json')];
  const files = {};
  for (const file of paths.flatMap(filesUnder)) {
    // Log growth is expected; capture data/config/binaries/assets, never log text.
    if (/\.(?:log|log\.\d+)$/.test(file)) continue;
    try { const bytes = readFileSync(file); files[file.slice(projectRoot.length + 1)] = { bytes: bytes.length, sha256: digest(bytes) }; }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  const processes = {};
  for (const name of ['universe', 'world', 'assets']) {
    const path = join(primaryRoot, `${name}.pid.json`);
    const record = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    processes[name] = { pid: record?.pid ?? null, identity: record ? processIdentity(record.pid) : null };
  }
  return { capturedAt: new Date().toISOString(), files, processes };
}
export function comparePrimarySnapshots(before, after) {
  const changedFiles = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(path => JSON.stringify(before.files[path]) !== JSON.stringify(after.files[path]));
  const changedProcesses = [...new Set([...Object.keys(before.processes), ...Object.keys(after.processes)])].filter(name => JSON.stringify(before.processes[name]) !== JSON.stringify(after.processes[name]));
  return { unchanged: changedFiles.length === 0 && changedProcesses.length === 0, changedFiles, changedProcesses,
    note: changedFiles.length || changedProcesses.length ? 'The live primary fixture changed during this interval. Active services may change data autonomously; this comparison establishes drift, not its cause. No primary data was restored or modified.' : 'Primary data/configuration/assets/binary hashes and recorded process identities match the pre-run snapshot.' };
}
function fixtureState(fixture) { const state = owned.get(fixture); if (!state) throw new Error('Only a fixture created in this process is owned; manifests cannot authorize lifecycle operations.'); assertIsolatedDirectory(state.directory); return state; }
export function verifyPrimaryUnchanged(fixture) {
  const state = fixtureState(fixture), after = primarySnapshot(), comparison = comparePrimarySnapshots(state.before, after);
  const report = join(state.directory, 'reports', `primary-${Date.now()}-${randomBytes(3).toString('hex')}.json`);
  privateWrite(report, json({ ...comparison, before: state.before, after }));
  return { ...comparison, report };
}

function localEnvironment(directory) {
  // Do not inherit Axis configuration override variables from the user's shell.
  // No SDK restore/build/install is performed; CLI state and temporary files are private.
  return { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    DOTNET_ROOT: dirname(dotnet), DOTNET_CLI_HOME: join(directory, 'dotnet-home'), DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    TMPDIR: join(directory, 'tmp'), TMP: join(directory, 'tmp'), TEMP: join(directory, 'tmp') };
}
function oneShot(state, name, command, args, cwd = state.directory) {
  const output = spawnSync(command, args, { cwd, env: state.env, encoding: 'utf8', timeout: 30000, maxBuffer: 4_000_000 });
  privateWrite(join(state.directory, 'logs', `${name}.log`), `${output.stdout || ''}${output.stderr || ''}`);
  if (output.error || output.status !== 0) throw new Error(`Isolated ${name} failed; inspect its private log in ${state.directory}.`);
  return output.stdout.trim();
}
/** Read-only preparation map; the default contains exactly the existing copied
 * original bytes. DirectX additions and its animation overlay require explicit
 * profiles; neither changes the public originals or previously prepared runs. */
export function isolatedAssetFiles(profile = 'baseline') {
  if (profile !== 'baseline' && profile !== 'directx' && profile !== 'directx-animation') throw new Error('Unknown isolated asset profile.');
  const assets = new Map();
  const relative = ['haven.json', 'LICENSE.txt', ...['ground', 'plaza', 'column', 'arch', 'tree', 'bench', 'sculpture', 'lamp'].map(name => `models/${name}.rwx`),
    ...avatarFixtureAssets().keys(), 'textures/LICENSE.txt', 'textures/terrain0.png', 'textures/terrain1.png', 'textures/terrain2.zip'];
  for (const name of relative) {
    const path = join(projectRoot, 'public/assets', name);
    if (lstatSync(path).isSymbolicLink()) throw new Error('Original fixture asset must not be a symlink.');
    const bytes = readFileSync(path);
    if (bytes.length > 1_000_000) throw new Error('Original fixture asset exceeds the copy limit.');
    assets.set(name, bytes);
  }
  if (profile === 'directx' || profile === 'directx-animation') for (const [name, bytes] of directXFixtureAssets()) {
    if (assets.has(name) && !['avatars/avatars.dat', 'avatars/avatars.zip'].includes(name)) throw new Error('DirectX profile cannot replace a baseline asset.');
    if (!/^[a-z0-9][a-z0-9_./-]*$/i.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') || bytes.length > 1_000_000) throw new Error('Invalid generated DirectX asset.');
    assets.set(name, Buffer.from(bytes));
  }
  if (profile === 'directx-animation') {
    const catalog = withDirectXAnimationCatalog(assets);
    for (const name of ['avatars/avatars.dat', 'avatars/avatars.zip']) {
      const bytes = catalog.get(name);
      if (!(bytes instanceof Uint8Array) || bytes.length > 1_000_000) throw new Error('Invalid generated DirectX animation catalog.');
      assets.set(name, Buffer.from(bytes));
    }
    for (const [name, bytes] of directXAnimationAssets()) {
      if (assets.has(name)) throw new Error('DirectX animation profile cannot replace an existing asset.');
      if (!/^seqs\/[a-z0-9][a-z0-9_.-]*$/i.test(name) || name.split('/').some(part => part === '.' || part === '..') || !(bytes instanceof Uint8Array) || bytes.length > 1_000_000) throw new Error('Invalid generated DirectX animation asset.');
      assets.set(name, Buffer.from(bytes));
    }
  }
  if (assets.size > 64 || [...assets.values()].reduce((total, bytes) => total + bytes.length, 0) > 10_000_000) throw new Error('Isolated asset profile exceeds fixture budgets.');
  return assets;
}
function copyOriginalAssets(directory, profile) {
  // Merge before the initial wx writes; no started fixture/catalog is replaced.
  const assets = isolatedAssetFiles(profile);
  const hashes = {};
  for (const [name, bytes] of assets) {
    const path = join(directory, 'assets', name); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); privateWrite(path, bytes); hashes[name] = digest(bytes);
  }
  return hashes;
}

/** Prepare fresh data using existing one-shot key/import/seed entrypoints only.
 * This does not start listening servers. Caller explicitly invokes start(). */
export async function createIsolatedFixture(options = {}) {
  if (options.restrictMovement !== undefined && typeof options.restrictMovement !== 'boolean') throw new Error('restrictMovement must be an explicit Boolean.');
  const assetProfile = options.assetProfile ?? 'baseline';
  if (assetProfile !== 'baseline' && assetProfile !== 'directx' && assetProfile !== 'directx-animation') throw new Error('Unknown isolated asset profile.');
  const ports = validateIsolatedPorts(options.ports || ISOLATED_PORTS);
  await assertPortsFree(ports);
  if (lstatSync(runtimeRoot).isSymbolicLink() || realpathSync(runtimeRoot) !== runtimeRoot) throw new Error('Runtime parent must be a real local directory.');
  for (const path of [dotnet, ...Object.values(binaries)]) if (!lstatSync(path).isFile()) throw new Error(`Missing already-built local dependency: ${path}`);
  const provenance = JSON.parse(readFileSync(join(primaryRoot, 'seeded.json'), 'utf8'));
  for (const [name, commit] of Object.entries(pins)) if (provenance.pins?.[name]?.commit !== commit) throw new Error('Existing binary fixture provenance does not match pinned sources.');
  const before = primarySnapshot(), directory = mkdtempSync(join(runtimeRoot, 'axis-isolated-'));
  // mkdtemp uses private permissions; enforce that all descendants are local.
  assertIsolatedDirectory(directory);
  for (const path of ['universe', 'world/data', 'assets', 'logs', 'reports', 'dotnet-home', 'tmp']) mkdirSync(join(directory, path), { recursive: true, mode: 0o700 });
  // Axis login/privilege passwords are ASCII with a 20-character maximum.
  const password = `I-${randomBytes(8).toString('hex')}!`;
  const state = { directory, ports, before, env: localEnvironment(directory), children: new Map(), cleanups: [], started: false, stopping: false, stopped: false, stopPromise: null, id: randomUUID() };
  try {
    const privateKey = oneShot(state, 'key-generation', dotnet, [binaries.seed, '--key']);
    const config = isolatedConfigurations(directory, ports, privateKey, randomBytes(32).toString('hex'), randomBytes(24).toString('hex'));
    privateWrite(join(directory, 'universe/appsettings.yml'), config.universe); privateWrite(join(directory, 'universe/attributes.yml'), config.attributes); privateWrite(join(directory, 'world/WorldServer.yml'), config.world);
    const assets = copyOriginalAssets(directory, assetProfile);
    const citizens = [{ ID: 2, Name: 'Wayfarer' }, { ID: 3, Name: 'Explorer' }].map(citizen => ({ ...citizen, Password: password, PrivPass: `B-${randomBytes(8).toString('hex')}!`, Enabled: 1, Expiration: 2147483647, BotLimit: 3, Comment: `Isolated run ${state.id}` }));
    const licenses = [{ ID: 1, Name: 'Haven', Password: 'HavenLocal42!', Expiration: 2147483647, Users: 100, Wsize: 100, Hidden: '0', Tourists: '1', Plugins: '0', Voip: '0', Comment: `Isolated run ${state.id}` }];
    for (const [flag, name, value] of [['--import-cit', 'citizens', citizens], ['--import-worlds', 'licenses', licenses]]) {
      const file = join(directory, 'universe', `${name}.json`); privateWrite(file, json(value));
      oneShot(state, `import-${name}`, dotnet, [binaries.universe, `--working-dir=${join(directory, 'universe')}`, `${flag}=${file}`], join(directory, 'universe'));
    }
    oneShot(state, 'world-seed', dotnet, [binaries.seed, join(directory, 'world/data'), `http://127.0.0.1:${ports.assets}/`, join(directory, 'assets/haven.json')]);
    let movementProfile = null;
    if (options.restrictMovement === true) {
      // This is a freshly created, not-yet-started directory. No caller-supplied
      // path or primary data can reach this narrowly scoped profile change.
      const path = join(directory, 'world/data/180f65f02e704b699a42497815a2d8a0/attributes.dat');
      if (realpathSync(path) !== path || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 1_000_000) throw new Error('Fresh fixture attributes must be a small regular file without symlink ancestors.');
      const original = readFileSync(path), restricted = restrictFixtureMovement(original);
      const backup = join(directory, 'reports/original-world-attributes.dat'); privateWrite(backup, original);
      writeFileSync(path, restricted, { flag: 'r+', mode: 0o600 }); chmodSync(path, 0o600);
      movementProfile = { allowFlying: false, allowTeleport: false, changedBytes: 2, originalSha256: digest(original), restrictedSha256: digest(restricted), backup };
    }
    const counts = oneShot(state, 'verify-seed', 'sqlite3', ['-readonly', join(directory, 'universe/universe.db'), "SELECT COUNT(*) FROM citizen WHERE citizen_name IN ('Wayfarer','Explorer'); SELECT COUNT(*) FROM license WHERE license_name='Haven';"]);
    if (counts !== '2\n1') throw new Error('Isolated citizen/license imports did not persist expected rows.');
    const credentials = Object.freeze({ wayfarer: Object.freeze({ username: 'Wayfarer', password, citizen: 2 }), explorer: Object.freeze({ username: 'Explorer', password, citizen: 3 }) });
    const metadata = { schema: 1, id: state.id, directory, preparedAt: new Date().toISOString(), ports, assets, assetProfile, pins, binaries: Object.fromEntries(Object.entries(binaries).map(([name, path]) => [name, { path, sha256: digest(readFileSync(path)) }])), world: 'Haven', objectPath: `http://127.0.0.1:${ports.assets}/`, credentials, restrictMovement: options.restrictMovement === true, movementProfile };
    privateWrite(join(directory, 'manifest.json'), json(metadata)); privateWrite(join(directory, 'reports/primary-before.json'), json(before));
    const accounts = Object.freeze([credentials.wayfarer, credentials.explorer]);
    const fixture = Object.freeze({ directory, ports, accounts, assetProfile, restrictMovement: metadata.restrictMovement, universePort: ports.universe, worldPort: ports.world, assetPort: ports.assets, objectPath: metadata.objectPath, world: 'Haven', credentials,
      connection: Object.freeze({ host: '127.0.0.1', port: ports.universe, tls: false, world: 'Haven' }),
      start: () => startIsolatedAxis(fixture), stop: () => stopIsolatedAxis(fixture), verifyPrimary: () => verifyPrimaryUnchanged(fixture),
      registerCleanup: callback => {
        fixtureState(fixture);
        if (typeof callback !== 'function' || state.stopping || state.cleanups.length >= 8) throw new Error('Fixture cleanup registration is unavailable or exceeds eight callbacks.');
        const entry = { callback }; state.cleanups.push(entry);
        return () => { if (!state.stopping) { const index = state.cleanups.indexOf(entry); if (index !== -1) state.cleanups.splice(index, 1); } };
      },
      writeReport: (name, value) => { fixtureState(fixture); if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) throw new Error('Invalid report name.'); const path = join(directory, 'reports', `${name}-${Date.now()}-${randomBytes(3).toString('hex')}.json`); const bytes = json(value); if (Buffer.byteLength(bytes) > 2_000_000) throw new Error('Report exceeds 2 MB limit.'); privateWrite(path, bytes); return path; },
    });
    owned.set(fixture, state); verifyPrimaryUnchanged(fixture); return fixture;
  } catch (cause) { privateWrite(join(directory, 'reports/preparation-failure.json'), json({ message: cause instanceof Error ? cause.message : 'Preparation failed', primary: comparePrimarySnapshots(before, primarySnapshot()) })); throw new Error(`Isolated fixture preparation failed; data/logs retained at ${directory}. ${cause instanceof Error ? cause.message : ''}`); }
}
export const prepareIsolatedAxis = createIsolatedFixture;

async function listening(port) {
  return new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port }); const done = yes => { socket.destroy(); resolve(yes); }; socket.setTimeout(250); socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('timeout', () => done(false)); });
}
async function startChild(state, name) {
  if (state.stopping) throw new Error('Isolated startup cancelled by shutdown.');
  const isAsset = name === 'assets', executable = isAsset ? assetScript : binaries[name];
  const command = isAsset ? process.execPath : dotnet;
  // Asset argument includes a child path too, making both ownership forms exact.
  const args = isAsset ? [assetScript, `--manifest=${join(state.directory, 'manifest.json')}`] : [executable, `--working-dir=${join(state.directory, name)}`, ...(name === 'world' ? ['--headless'] : [])];
  const logPath = join(state.directory, 'logs', `${name}.log`), fd = openSync(logPath, 'wx', 0o600);
  const child = spawn(command, args, { cwd: state.directory, env: state.env, stdio: ['ignore', fd, fd] }); closeSync(fd);
  const entry = { child, record: null, logPath, name, initialized: null }; state.children.set(name, entry);
  entry.initialized = (async () => {
    await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no); });
    // Persisted PID records are diagnostic ONLY; never accepted as authority by stop.
    const record = { pid: child.pid, executable, directory: state.directory, birthAndCommand: processIdentity(child.pid) };
    entry.record = record;
    if (!matchesOwnedProcess(record, record.birthAndCommand)) throw new Error(`Could not establish isolated ${name} process ownership.`);
    privateWrite(join(state.directory, `${name}.process.json`), json(record));
  })();
  await entry.initialized;
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (state.stopping) throw new Error('Isolated startup cancelled by shutdown.');
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Isolated ${name} exited before readiness. See ${logPath}`);
    const log = readFileSync(logPath, 'utf8');
    const marker = name === 'world' ? log.includes('Started world Haven:') : name === 'assets' ? log.includes('ISOLATED_ASSETS_READY') : new RegExp(`127\\.0\\.0\\.1:${state.ports.universe}\\s+LISTENING`).test(log);
    if (marker && await listening(state.ports[name]) && child.exitCode === null && child.signalCode === null) return entry.record;
    await pause(100);
  }
  throw new Error(`Isolated ${name} readiness timed out. See ${logPath}`);
}
export async function startIsolatedAxis(fixture) {
  const state = fixtureState(fixture);
  if (state.started || state.stopped) throw new Error('An isolated run starts only once; create a fresh fixture for another run.');
  await assertPortsFree(state.ports); state.started = true;
  try {
    for (const name of ['assets', 'universe', 'world']) await startChild(state, name);
    return { directory: state.directory, processes: [...state.children.values()].map(entry => ({ name: entry.name, pid: entry.record.pid, log: entry.logPath })) };
  } catch (cause) { await stopIsolatedAxis(fixture); throw cause; }
}
export async function stopIsolatedAxis(fixture) {
  const state = fixtureState(fixture);
  if (state.stopPromise) return state.stopPromise;
  state.stopping = true;
  state.stopPromise = (async () => {
  const stopped = [], refused = [], cleanupErrors = [];
  // Callers register only resources they own, such as an isolated UI/bridge.
  // This gives signal cleanup the same ordering as normal finally cleanup.
  for (const { callback } of [...state.cleanups].reverse()) {
    let timer;
    try { await Promise.race([Promise.resolve().then(callback), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Registered fixture cleanup timed out.')), 10000); })]); }
    catch (cause) { cleanupErrors.push(cause instanceof Error ? cause.message.slice(0, 500) : 'Registered fixture cleanup failed.'); }
    finally { clearTimeout(timer); }
  }
  state.cleanups.length = 0;
  // Only the exact ChildProcess handles created above can reach this operation.
  for (const name of ['world', 'universe', 'assets']) {
    const entry = state.children.get(name); if (!entry) continue;
    await entry.initialized?.catch(() => {});
    const { child, record } = entry;
    if (child.exitCode !== null || child.signalCode !== null) { stopped.push(name); continue; }
    if (!record || !matchesOwnedProcess(record, processIdentity(child.pid))) { refused.push(name); continue; }
    child.kill('SIGTERM');
    const until = Date.now() + 5000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < until) await pause(50);
    if (child.exitCode === null && child.signalCode === null) {
      if (!matchesOwnedProcess(record, processIdentity(child.pid))) { refused.push(name); continue; }
      child.kill('SIGKILL');
      const hardUntil = Date.now() + 2000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < hardUntil) await pause(50);
    }
    if (child.exitCode === null && child.signalCode === null) refused.push(name); else stopped.push(name);
  }
  state.stopped = refused.length === 0;
  const result = { stopped, refused, cleanupErrors, retainedDirectory: state.directory, primary: verifyPrimaryUnchanged(fixture) };
  fixture.writeReport('stop', result);
  if (refused.length) throw new Error(`Preserved processes whose ownership/exit could not be confirmed: ${refused.join(', ')}. See ${state.directory}`);
  if (cleanupErrors.length) throw new Error(`Registered isolated cleanup needs attention; see the private stop report in ${state.directory}.`);
  return result;
  })();
  return state.stopPromise;
}
export async function withIsolatedAxis(callback, options = {}) {
  const fixture = await createIsolatedFixture(options);
  let interrupted = false;
  const onSignal = signal => {
    if (interrupted) return; interrupted = true;
    fixture.writeReport('interrupted', { signal, timestamp: new Date().toISOString(), note: 'Stopping only this run\'s owned child handles; retaining all fixture data.' });
    void fixture.stop().then(() => process.exit(signal === 'SIGINT' ? 130 : 143), error => {
      console.error(`Isolated cleanup needs attention: ${error instanceof Error ? error.message : String(error)}`); process.exit(1);
    });
  };
  const onInterrupt = () => onSignal('SIGINT'), onTerminate = () => onSignal('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  try { await fixture.start(); return await callback(fixture); }
  finally { try { await fixture.stop(); } finally { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== 'prepare') throw new Error('Usage: node scripts/axis-isolated.mjs prepare. Server start/stop requires the exported owned lifecycle API.');
  const fixture = await createIsolatedFixture();
  console.log(JSON.stringify({ directory: fixture.directory, universePort: fixture.universePort, worldPort: fixture.worldPort, assetPort: fixture.assetPort, prepared: true, serversStarted: false }));
}
