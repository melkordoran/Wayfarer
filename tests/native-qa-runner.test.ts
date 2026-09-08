import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchesNativeQaProcess, nativeLaunchArguments, nativeQaArguments, nativeQaMode, readNativeQaReceipt, validateNativePackageMetadata, validateNativeQaReceipt, type NativeQaExpected } from '../scripts/native-qa-helpers';

const app = '/project/release/0.7.0/mac-arm64/Wayfarer.app', appPath = app + '/Contents/Resources/app.asar';
const profileDir = '/project/.runtime/axis-isolated-AbC123/native-profile';
const qa = { mode: 'fixture' as const, universePort: 26670, worldPort: 27000, assetPort: 27400 };
const expected: NativeQaExpected = { pid: 1234, version: '0.7.0', profileDir, appPath, qa };
const receipt = (overrides: Record<string, unknown> = {}) => ({ schema: 'wayfarer.native-qa/v1', pid: 1234, version: '0.7.0', profileDir, userData: profileDir, sessionData: profileDir, qa, appPath, isPackaged: true, ...overrides });

describe('explicit native runner arguments and prelaunch capability', () => {
  it('requires an explicit package path and never defaults to an installed app', () => {
    expect(() => nativeQaArguments([])).toThrow();
    expect(nativeQaArguments(['release/0.7.0/mac-arm64/Wayfarer.app'])).toEqual({ app: 'release/0.7.0/mac-arm64/Wayfarer.app', offline: false, restrictMovement: false });
  });
  it('accepts separate offline or restricted connected profiles', () => {
    expect(nativeQaArguments([app, '--offline']).offline).toBe(true);
    expect(nativeQaArguments([app, '--restricted']).restrictMovement).toBe(true);
  });
  it.each([[app, '--offline', '--restricted'], [app, '--offline', '--offline'], [app, '--dev'], [app, '--profile-dir=/normal'], [app, app], ['--offline']].map(args => ({ args })))('refuses ambiguous/extra arguments $args', ({ args }) => {
    expect(() => nativeQaArguments(args)).toThrow();
  });
  it('builds only the agreed explicit profile and QA policy flags', () => {
    expect(nativeLaunchArguments(profileDir, qa)).toEqual([`--profile-dir=${profileDir}`, '--qa-network=26670,27000,27400']);
    expect(nativeLaunchArguments('/project/.runtime/native-qa-AbC123/native-profile', { mode: 'offline' })).toEqual(['--profile-dir=/project/.runtime/native-qa-AbC123/native-profile', '--qa-offline']);
  });
  it.each(['relative/profile', '/', '/project', '/Users/example/Library/Application Support/Wayfarer', '/project/.runtime/axis/native-profile'])('refuses non-isolated profile paths %s', profile => {
    expect(() => nativeLaunchArguments(profile, { mode: 'offline' })).toThrow();
  });
  it('refuses missing, incorrect or old package capability metadata', () => {
    for (const metadata of [null, {}, { version: '0.7.0', main: 'dist-electron/main.cjs' }, { version: '0.6.0', wayfarerNativeQa: 1, main: 'dist-electron/main.cjs' }, { version: '0.7.0', wayfarerNativeQa: '1', main: 'dist-electron/main.cjs' }, { version: '0.7.0', wayfarerNativeQa: 1, main: 'other.js' }])
      expect(() => validateNativePackageMetadata(metadata, '0.7.0')).toThrow();
    expect(() => validateNativePackageMetadata({ version: '0.7.0', wayfarerNativeQa: 1, main: 'dist-electron/main.cjs' }, '0.7.0')).not.toThrow();
  });
  it('rejects primary, mixed or extra native endpoint policy fields', () => {
    for (const value of [{ ...qa, universePort: 16670 }, { ...qa, worldPort: 17000 }, { ...qa, assetPort: 17400 }, { ...qa, worldPort: 26670 }, { ...qa, host: 'elsewhere' }, { mode: 'offline', universePort: 26670 }]) expect(() => nativeQaMode(value)).toThrow();
  });
});

describe('native startup/ready receipts confirm actual profile and policy', () => {
  it('accepts the exact packaged identity and both independently scoped modes', () => {
    expect(validateNativeQaReceipt(receipt(), expected).pid).toBe(1234);
    expect(validateNativeQaReceipt(receipt({ qa: { mode: 'offline' } }), { ...expected, qa: { mode: 'offline' } }).qa).toEqual({ mode: 'offline' });
  });
  it.each([
    { schema: 'unknown' }, { pid: 1 }, { pid: 1235 }, { version: '0.6.0' }, { isPackaged: false },
    { profileDir: '/normal/profile' }, { userData: '/normal/profile' }, { sessionData: '/normal/profile' },
    { appPath: '/another/app.asar' }, { qa: { mode: 'offline' } }, { qa: { ...qa, worldPort: 17000 } },
  ])('rejects mismatched receipt identity or endpoint scope %s', override => {
    expect(() => validateNativeQaReceipt(receipt(override), expected)).toThrow();
  });
  it('requires the ready receipt to prove visibility, bounds and the packaged entry', () => {
    const ready = receipt({ nativeWindowVisible: true, size: [1480, 960], url: pathToFileURL(join(appPath, 'dist/index.html')).href });
    expect(() => validateNativeQaReceipt(ready, expected, true)).not.toThrow();
    for (const override of [{ nativeWindowVisible: false }, { size: [0, 960] }, { size: [NaN, 960] }, { size: [1480] }, { size: [1480, 960, 1] }, { url: 'http://127.0.0.1:5173/' }]) expect(() => validateNativeQaReceipt({ ...ready, ...override }, expected, true)).toThrow();
    expect(() => validateNativeQaReceipt(receipt(), expected, true)).toThrow();
  });
});

describe('native process shutdown identity', () => {
  const executable = app + '/Contents/MacOS/Wayfarer';
  const command = `Mon Sep 7 12:00:00 2026 ${executable} --profile-dir=${profileDir} --qa-network=26670,27000,27400`;
  const record = { pid: 1234, executable, profileDir, birthAndCommand: command };
  it('accepts only the matching child birth, full command and exact profile argument', () => {
    expect(matchesNativeQaProcess(record, command)).toBe(true);
    expect(matchesNativeQaProcess(record, command.replace('12:00:00', '12:00:01'))).toBe(false);
    expect(matchesNativeQaProcess(record, command.replace(profileDir, '/normal/profile'))).toBe(false);
    expect(matchesNativeQaProcess({ ...record, pid: 1 }, command)).toBe(false);
    expect(matchesNativeQaProcess({ ...record, executable: '/Applications/Wayfarer.app/Contents/MacOS/Wayfarer' }, command)).toBe(false);
    expect(matchesNativeQaProcess(record, null)).toBe(false);
  });
  it('rejects a longer profile with a matching prefix', () => {
    const longer = command.replace(profileDir, profileDir + '-other');
    expect(matchesNativeQaProcess({ ...record, birthAndCommand: longer }, longer)).toBe(false);
  });
});

describe('private receipt file validation without any application launch', () => {
  function files() {
    // Small audit fixtures are retained; no recursive deletion or primary access.
    const directory = mkdtempSync(join(resolve(import.meta.dirname, '..'), '.runtime/native-qa-'));
    const profile = join(directory, 'native-profile'); mkdirSync(profile, { mode: 0o700 });
    return { directory, profile, expected: { ...expected, profileDir: profile }, receipt: receipt({ profileDir: profile, userData: profile, sessionData: profile }) };
  }
  it('reads a matching small 0600 startup receipt only from the exact expected file', () => {
    const test = files(), path = join(test.profile, 'native-startup.json'); writeFileSync(path, JSON.stringify(test.receipt), { mode: 0o600, flag: 'wx' });
    expect(readNativeQaReceipt(path, test.expected).pid).toBe(1234);
    expect(() => readNativeQaReceipt(join(test.profile, 'other.json'), test.expected)).toThrow(/Unexpected/);
  });
  it('refuses group-readable receipts, oversized data and symlinked receipts', () => {
    const readable = files(), path = join(readable.profile, 'native-startup.json'); writeFileSync(path, JSON.stringify(readable.receipt), { mode: 0o644, flag: 'wx' }); chmodSync(path, 0o644);
    expect(() => readNativeQaReceipt(path, readable.expected)).toThrow(/privately owned/);
    const large = files(), largePath = join(large.profile, 'native-startup.json'); writeFileSync(largePath, ' '.repeat(64001), { mode: 0o600, flag: 'wx' });
    expect(() => readNativeQaReceipt(largePath, large.expected)).toThrow(/small/);
    const link = files(), linkPath = join(link.profile, 'native-startup.json'); symlinkSync(path, linkPath);
    expect(() => readNativeQaReceipt(linkPath, link.expected)).toThrow(/symlink/);
  });
});
