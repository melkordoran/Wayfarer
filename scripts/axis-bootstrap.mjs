import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dotnet, ensureRuntime, pins, root, run, runtime, services, ownedProcess } from './axis-common.mjs';
import { ensureAssets } from './axis-fixtures.mjs';
import { ensureAvatarAssets } from './axis-avatar-assets.mjs';

ensureRuntime();
ensureAssets();
ensureAvatarAssets();
const rebuild = process.argv.includes('--rebuild');
if (services.some(service => ownedProcess(service.name))) {
  throw new Error('Stop the local Axis fixture before bootstrapping: npm run axis:stop');
}

if (!existsSync(dotnet)) {
  const downloadDir = join(root, '.runtime', 'downloads');
  mkdirSync(downloadDir, { recursive: true });
  const installer = join(downloadDir, 'dotnet-install.sh');
  run('curl', ['-fSL', 'https://dot.net/v1/dotnet-install.sh', '-o', installer]);
  run('bash', [installer, '--version', '10.0.400', '--install-dir', join(root, '.runtime', 'dotnet'), '--no-path']);
}

for (const name of ['universe', 'world']) {
  const source = join(root, 'vendor', `axis-${name}`);
  const pin = pins[name];
  if (!existsSync(join(source, '.git'))) {
    run('git', ['clone', pin.url, source]);
    run('git', ['-C', source, 'checkout', '--detach', pin.commit]);
  }
  const head = run('git', ['-C', source, 'rev-parse', 'HEAD'], { stdio: 'pipe' });
  if (head !== pin.commit) throw new Error(`${source} is at ${head}, expected ${pin.commit}; preserving checkout.`);
  const dirty = run('git', ['-C', source, 'status', '--porcelain'], { stdio: 'pipe' });
  if (dirty) throw new Error(`${source} has local changes; preserving them rather than building an unrecorded source revision.`);
  run('git', ['-C', source, '-c', 'url.https://gitlab.pp16.org/.insteadOf=git@gitlab.pp16.org:', 'submodule', 'update', '--init', '--recursive']);
  const platformHead = run('git', ['-C', join(source, 'Axis.Platform'), 'rev-parse', 'HEAD'], { stdio: 'pipe' });
  if (platformHead !== pins.platform.commit) throw new Error(`Unexpected Axis.Platform revision: ${platformHead}`);
  if (run('git', ['-C', join(source, 'Axis.Platform'), 'status', '--porcelain'], { stdio: 'pipe' })) {
    throw new Error(`${source}/Axis.Platform has local changes; preserving checkout.`);
  }
  if (rebuild || !existsSync(join(runtime, 'bin', name, `${pin.project}.dll`))) {
    run(dotnet, ['publish', join(source, pin.project, `${pin.project}.csproj`), '-c', 'Release', '--no-self-contained', '-o', join(runtime, 'bin', name)]);
  }
}

const seedProject = join(root, 'scripts', 'axis-seed', 'AxisFixture.csproj');
run(dotnet, ['publish', seedProject, '-c', 'Release', '--no-self-contained', '-o', join(runtime, 'bin', 'seed')]);
const seedDll = join(runtime, 'bin', 'seed', 'AxisFixture.dll');
const configPath = join(runtime, 'universe', 'appsettings.yml');
if (!existsSync(configPath)) {
  const privateKey = run(dotnet, [seedDll, '--key'], { stdio: 'pipe' });
  writeFileSync(configPath, `Log:\n  Console: true\nDatabase:\n  File: ${JSON.stringify(join(runtime, 'universe', 'universe.db'))}\n  Password: '${randomBytes(32).toString('hex')}'\n  InitialCitizenNumber: 2\nOptions:\n  AllowImmigration: false\n  AllowCitizenAdd: true\n  AllowCitizenEdit: true\n  AllowLicenseManagement: true\n  MaxContacts: 50\n  MaxConnectionsPerIpPerMinute: 0\nLicense:\n  PrivateKey: '${privateKey}'\n  Name: wayfarer\n  Address: 127.0.0.1\nListen:\n  Address: 127.0.0.1\n  Port: 16670\nEmail:\n  Settings:\n    Enable: false\n`, { mode: 0o600 });
  writeFileSync(join(runtime, 'universe', 'attributes.yml'), `name: Wayfarer\nbrowser_minimum: 1250\nbrowser_release: 1682\nbrowser_beta: 1682\nallow_tourists: true\nallow_immigration: false\nenable_user_list: true\nstart_world: Haven\nwelcome_message: Welcome to the Wayfarer development universe.\n`, { mode: 0o600 });
}

const worldConfig = join(runtime, 'world', 'WorldServer.yml');
if (!existsSync(worldConfig)) {
  writeFileSync(worldConfig, `Universe:\n  Host: 127.0.0.1\n  Port: 16670\nListen:\n  Address: 127.0.0.1\n  Port: 17000\nWorldServer:\n  AutoStart: true\n  DataDirectory: ${JSON.stringify(join(runtime, 'world', 'data'))}\n  AdminPassword: '${randomBytes(24).toString('hex')}'\n  AlwaysRequireAdminPassword: true\n  DefaultObjectPath: http://127.0.0.1:17400/\n  MinimumBrowserVersion: 1250\n  RestrictedRadiusAroundEntryPoint: false\n  GlobalAvatarPositions: true\n`, { mode: 0o600 });
}

const seeded = join(runtime, 'seeded.json');
if (!existsSync(seeded)) {
  const citizens = [
    { ID: 2, Name: 'Wayfarer', Password: 'WayfarerLocal42!', PrivPass: 'WayfarerBot42!', Enabled: 1, Expiration: 2147483647, BotLimit: 3, Comment: 'Local fixture caretaker' },
    { ID: 3, Name: 'Explorer', Password: 'WayfarerLocal42!', PrivPass: 'ExplorerBot42!', Enabled: 1, Expiration: 2147483647, BotLimit: 3, Comment: 'Local fixture observer' },
  ];
  const worlds = [{ ID: 1, Name: 'Haven', Password: 'HavenLocal42!', Expiration: 2147483647, Users: 100, Wsize: 100, Hidden: '0', Tourists: '1', Plugins: '0', Voip: '0', Comment: 'Independent local fixture' }];
  const citizenFile = join(runtime, 'universe', 'fixture-citizens.json');
  const worldFile = join(runtime, 'universe', 'fixture-worlds.json');
  writeFileSync(citizenFile, JSON.stringify(citizens, null, 2), { mode: 0o600 });
  writeFileSync(worldFile, JSON.stringify(worlds, null, 2), { mode: 0o600 });
  const universeDll = join(runtime, 'bin', 'universe', 'Axis.UniverseServer.dll');
  for (const [flag, file] of [['--import-cit', citizenFile], ['--import-worlds', worldFile]]) {
    run(dotnet, [universeDll, `--working-dir=${join(runtime, 'universe')}`, `${flag}=${file}`]);
  }
  run(dotnet, [seedDll, join(runtime, 'world', 'data'), 'http://127.0.0.1:17400/', join(root, 'public', 'assets', 'haven.json')]);
  // The upstream import entrypoint logs failures and can return success; verify persisted rows.
  const count = run('sqlite3', [join(runtime, 'universe', 'universe.db'), "SELECT COUNT(*) FROM citizen WHERE citizen_name IN ('Wayfarer','Explorer');"], { stdio: 'pipe' });
  if (count !== '2') throw new Error(`Fixture citizen import failed: expected 2, found ${count}`);
  const licenseCount = run('sqlite3', [join(runtime, 'universe', 'universe.db'), "SELECT COUNT(*) FROM license WHERE license_name = 'Haven';"], { stdio: 'pipe' });
  if (licenseCount !== '1') throw new Error('Fixture Haven license import failed.');
  writeFileSync(seeded, JSON.stringify({ created: new Date().toISOString(), pins, world: 'Haven', schema: 1 }, null, 2));
}
console.log('Axis fixture ready. Start with npm run axis:start. Existing data and account passwords were preserved.');
