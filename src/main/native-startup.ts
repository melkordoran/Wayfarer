import { accessSync, constants, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ClientCommand } from '../shared/types';
import { assetUrl } from '../shared/validation';

export const NATIVE_QA_SCHEMA = 'wayfarer.native-qa/v1';
export type NativeQaMode = { mode: 'offline' } | { mode: 'fixture'; universePort: number; worldPort: number; assetPort: number };
export interface NativeStartup { profileDir?: string; qa?: NativeQaMode }

/** A malformed isolation request must never fall through to the normal profile. */
export function nativeStartupOptions(args: readonly string[]): NativeStartup {
  let profileDir: string | undefined, qa: NativeQaMode | undefined;
  for (const argument of args) {
    if (argument.startsWith('--profile-dir')) {
      if (profileDir !== undefined || !argument.startsWith('--profile-dir=')) throw new Error('Use one --profile-dir=<absolute existing directory>.');
      profileDir = argument.slice('--profile-dir='.length);
      if (!profileDir || /[\x00-\x1f\x7f]/.test(profileDir) || !isAbsolute(profileDir)) throw new Error('Profile directory must be an absolute path without control characters.');
      profileDir = resolve(profileDir);
      if (profileDir === parse(profileDir).root || profileDir === homedir()) throw new Error('Choose a dedicated profile directory, not a filesystem root or home directory.');
    } else if (argument.startsWith('--qa-offline') || argument.startsWith('--qa-network')) {
      if (qa) throw new Error('Choose exactly one native QA mode.');
      if (argument === '--qa-offline') qa = { mode: 'offline' };
      else if (argument.startsWith('--qa-network=')) {
        const values = argument.slice('--qa-network='.length).split(','), ports = values.map(Number);
        if (values.length !== 3 || values.some(value => !/^\d{4,5}$/.test(value)) || ports.some(port => port < 1024 || port > 65535 || [16670, 17000, 17400, 4173, 5173, 5174].includes(port)) || new Set(ports).size !== 3)
          throw new Error('Native QA requires three distinct unprivileged non-primary fixture ports.');
        qa = { mode: 'fixture', universePort: ports[0], worldPort: ports[1], assetPort: ports[2] };
      } else throw new Error('Invalid native QA option.');
    }
  }
  if (qa && !profileDir) throw new Error('Native QA requires an explicit empty --profile-dir.');
  return { ...(profileDir ? { profileDir } : {}), ...(qa ? { qa } : {}) };
}

export interface ProfileApp {
  isReady(): boolean;
  setPath(name: 'userData' | 'sessionData' | 'logs' | 'crashDumps', path: string): void;
}
/** Validate before redirecting Electron. No normal-profile migration or deletion.
 * The caller must exit if configuration fails; never retry with default paths. */
export function configureNativeProfile(app: ProfileApp, options: NativeStartup): string | undefined {
  if (!options.profileDir) return undefined;
  if (app.isReady()) throw new Error('Profile isolation must be configured before Electron is ready.');
  const requested = options.profileDir, info = lstatSync(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Profile must be an existing non-symlink directory.');
  const directory = realpathSync(requested);
  if (directory === parse(directory).root || directory === realpathSync(homedir())) throw new Error('Profile must be a dedicated directory.');
  accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  if (options.qa && readdirSync(directory).length) throw new Error('Native QA refuses a non-empty profile. Create a fresh test directory.');
  const paths = { userData: directory, sessionData: directory, logs: join(directory, 'logs'), crashDumps: join(directory, 'crash-dumps') };
  for (const child of [paths.logs, paths.crashDumps]) {
    try { mkdirSync(child, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const info = lstatSync(child);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Profile subdirectories must not be files or symlinks.');
  }
  for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) app.setPath(name, paths[name]);
  return directory;
}

export function assertNativeCommandTarget(command: ClientCommand, qa?: NativeQaMode): void {
  if (!qa || command.type === 'disconnect') return;
  if (qa.mode === 'offline') throw new Error('This isolated desktop QA session is offline. Network commands are disabled.');
  if (command.type === 'connect' && (command.options.host !== '127.0.0.1' || command.options.port !== qa.universePort || command.options.tls !== false))
    throw new Error('Native QA can connect only to its own loopback test Universe. Primary and remote connections are blocked.');
}
export function assertNativeWorldTarget(target: Readonly<{ host: string; port: number; tls: boolean }>, qa?: NativeQaMode): void {
  if (!qa) return;
  if (qa.mode !== 'fixture' || target.host !== '127.0.0.1' || target.port !== qa.worldPort || target.tls !== false)
    throw new Error('Native QA can enter only its own loopback test World server.');
}
export function nativeQaAssetTarget(input: string, qa: NativeQaMode): string {
  if (qa.mode === 'offline') throw new Error('External assets are disabled in offline desktop QA.');
  const url = assetUrl(input);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(qa.assetPort) || url.search || url.hash)
    throw new Error('Native QA can load only its own copied loopback fixture assets.');
  return url.href;
}

export interface NativeQaReceipt {
  schema: typeof NATIVE_QA_SCHEMA;
  pid: number;
  version: string;
  profileDir: string;
  userData: string;
  sessionData: string;
  appPath: string;
  isPackaged: boolean;
  qa: NativeQaMode;
  timestamp: string;
}
export function writeNativeQaReceipt(directory: string, name: 'native-startup.json' | 'native-ready.json', receipt: NativeQaReceipt & { nativeWindowVisible?: boolean; size?: number[]; url?: string }): void {
  // Never replace a receipt or follow an existing symlink; QA profiles are one-shot.
  writeFileSync(join(directory, name), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
}
