import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractFile } from '@electron/asar';
import { validateIsolatedPorts } from './axis-isolated.mjs';

export type NativeQaMode = { mode: 'offline' } | { mode: 'fixture'; universePort: number; worldPort: number; assetPort: number };
export interface NativeQaExpected { pid: number; version: string; profileDir: string; appPath: string; qa: NativeQaMode }
export interface NativeQaProcess { pid: number; executable: string; profileDir: string; birthAndCommand: string | null }
export interface NativeQaPackage { app: string; executable: string; appPath: string; version: string; executableSha256: string; archiveSha256: string; verification: unknown }
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function scopedProfile(path: string) {
  return resolve(path) === path && !/[\x00-\x1f\x7f]/.test(path) && basename(path) === 'native-profile' &&
    /^(?:axis-isolated|native-qa)-[A-Za-z0-9]{6,}$/.test(basename(dirname(path))) && basename(dirname(dirname(path))) === '.runtime';
}

export function nativeQaArguments(args: readonly string[]) {
  const apps = args.filter(value => !value.startsWith('--'));
  if (apps.length !== 1 || args.some(value => value.startsWith('--') && !['--offline', '--restricted'].includes(value)) || new Set(args).size !== args.length || (args.includes('--offline') && args.includes('--restricted')))
    throw new Error('Usage: npx tsx scripts/axis-isolated-native.ts release/VERSION/mac-arm64/Wayfarer.app [--offline | --restricted]');
  return { app: apps[0], offline: args.includes('--offline'), restrictMovement: args.includes('--restricted') };
}
export function nativeQaMode(value: unknown): NativeQaMode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native QA mode.');
  const record = value as Record<string, unknown>, keys = Object.keys(record).sort().join(',');
  if (record.mode === 'offline' && keys === 'mode') return { mode: 'offline' };
  if (record.mode !== 'fixture' || keys !== 'assetPort,mode,universePort,worldPort') throw new Error('Invalid native QA mode fields.');
  const ports = validateIsolatedPorts({ universe: record.universePort, world: record.worldPort, assets: record.assetPort });
  return { mode: 'fixture', universePort: ports.universe, worldPort: ports.world, assetPort: ports.assets };
}
export function nativeLaunchArguments(profileDir: string, qa: NativeQaMode): string[] {
  const mode = nativeQaMode(qa);
  if (!scopedProfile(profileDir)) throw new Error('An absolute fresh isolated native profile path is required.');
  return [`--profile-dir=${profileDir}`, mode.mode === 'offline' ? '--qa-offline' : `--qa-network=${mode.universePort},${mode.worldPort},${mode.assetPort}`];
}
export function validateNativeQaReceipt(value: unknown, expected: NativeQaExpected, ready = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native QA receipt.');
  const receipt = value as Record<string, unknown>;
  if (receipt.schema !== 'wayfarer.native-qa/v1' || !Number.isSafeInteger(receipt.pid) || receipt.pid !== expected.pid || expected.pid <= 1 || receipt.version !== expected.version || receipt.isPackaged !== true)
    throw new Error('Native QA receipt has an unexpected process, version, schema, or package identity.');
  if ([receipt.profileDir, receipt.userData, receipt.sessionData].some(path => path !== expected.profileDir) || receipt.appPath !== expected.appPath)
    throw new Error('Native QA receipt does not confirm the exact isolated profile and packaged application path.');
  if (JSON.stringify(nativeQaMode(receipt.qa)) !== JSON.stringify(nativeQaMode(expected.qa))) throw new Error('Native QA receipt does not confirm the requested endpoint policy.');
  if (ready && (receipt.nativeWindowVisible !== true || !Array.isArray(receipt.size) || receipt.size.length !== 2 || !receipt.size.every(value => Number.isSafeInteger(value) && value >= 100 && value <= 20000) || receipt.url !== pathToFileURL(join(expected.appPath, 'dist/index.html')).href))
    throw new Error('Native QA ready receipt does not confirm a visible packaged window with the expected entry.');
  return receipt;
}
export function readNativeQaReceipt(path: string, expected: NativeQaExpected, ready = false) {
  if (path !== join(expected.profileDir, ready ? 'native-ready.json' : 'native-startup.json') || realpathSync(path) !== path) throw new Error('Unexpected native receipt path or symlink.');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 64000 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Native receipts must be small, privately owned regular files.');
  return validateNativeQaReceipt(JSON.parse(readFileSync(path, 'utf8')), expected, ready);
}
export function matchesNativeQaProcess(record: NativeQaProcess, current: string | null): boolean {
  if (!Number.isSafeInteger(record.pid) || record.pid <= 1 || !scopedProfile(record.profileDir) || !record.birthAndCommand || current !== record.birthAndCommand || !record.executable.endsWith('/Wayfarer.app/Contents/MacOS/Wayfarer')) return false;
  const argument = `--profile-dir=${record.profileDir}`, index = current.indexOf(argument);
  return current.includes(record.executable) && index >= 0 && (index + argument.length === current.length || /\s/.test(current[index + argument.length]));
}
export function validateNativePackageMetadata(value: unknown, version: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid packaged application metadata.');
  const metadata = value as Record<string, unknown>;
  if (metadata.version !== version || metadata.wayfarerNativeQa !== 1 || metadata.main !== 'dist-electron/main.cjs') throw new Error('This package has not declared the required native profile/QA capability. Rebuild the supported package before launch.');
}
/** Runs the existing read-only package/current-build comparison BEFORE spawn.
 * This is a controlled QA preflight, not attestation against hostile local swaps. */
export function verifyNativeQaPackage(argument: string, projectRoot: string): NativeQaPackage {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This packaged native QA launcher currently supports macOS arm64 only.');
  const root = resolve(projectRoot), app = resolve(root, argument), source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expected = join(root, 'release', source.version, 'mac-arm64/Wayfarer.app');
  if (app !== expected || realpathSync(app) !== app || !lstatSync(app).isDirectory()) throw new Error('Choose the current versioned release/VERSION/mac-arm64/Wayfarer.app, without symlinks.');
  const executable = join(app, 'Contents/MacOS/Wayfarer'), appPath = join(app, 'Contents/Resources/app.asar');
  for (const path of [executable, appPath]) if (realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error('Packaged executable/archive must be regular files without symlink ancestors.');
  validateNativePackageMetadata(JSON.parse(extractFile(appPath, 'package.json').toString('utf8')), source.version);
  const output = execFileSync(process.execPath, [join(root, 'scripts/verify-mac-package.mjs'), app, source.version], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 4_000_000 });
  const verification = JSON.parse(output);
  if (verification.passed !== true || verification.app !== app || verification.version !== source.version || verification.architecture !== 'arm64') throw new Error('Native package/current-build verification did not pass.');
  const executableSha256 = sha256(readFileSync(executable)), archiveSha256 = sha256(readFileSync(appPath));
  if (verification.archiveSha256 !== archiveSha256) throw new Error('Packaged archive changed during preflight.');
  return { app, executable, appPath, version: source.version, executableSha256, archiveSha256, verification };
}
export function assertNativePackageUnchanged(bundle: NativeQaPackage) {
  if (realpathSync(bundle.executable) !== bundle.executable || realpathSync(bundle.appPath) !== bundle.appPath || sha256(readFileSync(bundle.executable)) !== bundle.executableSha256 || sha256(readFileSync(bundle.appPath)) !== bundle.archiveSha256)
    throw new Error('The native package changed after preflight; refusing this run.');
}
