import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const runtime = join(root, '.runtime', 'axis');
export const dotnet = join(root, '.runtime', 'dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
export const env = {
  ...process.env,
  DOTNET_ROOT: dirname(dotnet),
  DOTNET_CLI_HOME: join(root, '.runtime', 'dotnet-home'),
  NUGET_PACKAGES: join(root, '.runtime', 'nuget'),
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
  DOTNET_NOLOGO: '1',
};
export const pins = {
  universe: { url: 'https://gitlab.pp16.org/axis/universe_server.git', commit: '8ecd16abd46853f91c7af04f07d4d518f465017f', project: 'Axis.UniverseServer' },
  world: { url: 'https://gitlab.pp16.org/axis/world_server.git', commit: 'c3e7486fc153ac31b3df1a07bc2b03d20e348152', project: 'Axis.WorldServer' },
  platform: { url: 'https://gitlab.pp16.org/axis/platform.git', commit: 'f18054d5d16e3869d54243788bced30b59cccf05' },
};
export const services = [
  { name: 'universe', port: 16670, dll: 'Axis.UniverseServer.dll' },
  { name: 'world', port: 17000, dll: 'Axis.WorldServer.dll' },
  { name: 'assets', port: 17400 },
];

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result.stdout?.toString().trim();
}

export function ensureRuntime() {
  for (const path of [runtime, join(runtime, 'logs'), join(runtime, 'universe'), join(runtime, 'world', 'data')]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

export function pidPath(name) { return join(runtime, `${name}.pid.json`); }
export function readPid(name) {
  const path = pidPath(name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function ownedProcess(name) {
  const record = readPid(name);
  if (!record || !Number.isInteger(record.pid) || record.pid <= 1) return null;
  try { process.kill(record.pid, 0); } catch { return null; }
  // PID files never authorize killing a reused PID: confirm the full command path.
  const command = spawnSync('ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' }).stdout || '';
  return command.includes(record.identity) && record.identity.startsWith(root + '/') ? record : null;
}

export async function listening(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
