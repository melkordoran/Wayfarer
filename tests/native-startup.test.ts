import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNativeCommandTarget, assertNativeWorldTarget, configureNativeProfile, nativeQaAssetTarget, nativeStartupOptions, NATIVE_QA_SCHEMA, writeNativeQaReceipt, type NativeQaMode, type NativeQaReceipt } from '../src/main/native-startup';
import { createScopedAssetFetcher } from '../src/main/scoped-assets';
import type { ClientCommand } from '../src/shared/types';

const qa: NativeQaMode = { mode: 'fixture', universePort: 26670, worldPort: 27000, assetPort: 27400 };
const runtime = resolve('.runtime'); mkdirSync(runtime, { recursive: true });
function directory() { return mkdtempSync(join(runtime, 'native-profile-test-')); }
function application() { return { isReady: vi.fn(() => false), setPath: vi.fn() }; }
function connect(host = '127.0.0.1', port = 26670, tls = false): ClientCommand { return { type: 'connect', options: { host, port, tls, username: 'Fixture', password: '', world: 'Haven' } }; }
afterEach(() => vi.unstubAllGlobals());

describe('explicit native startup options', () => {
  it('does not change ordinary startup', () => expect(nativeStartupOptions(['Wayfarer', '--other-switch'])).toEqual({}));
  it('supports an explicit ordinary profile without imposing test network rules', () => expect(nativeStartupOptions(['--profile-dir=' + runtime])).toEqual({ profileDir: runtime }));
  it('supports either contained fixture or fully offline QA', () => {
    expect(nativeStartupOptions(['--profile-dir=' + runtime, '--qa-network=26670,27000,27400'])).toEqual({ profileDir: runtime, qa });
    expect(nativeStartupOptions(['--qa-offline', '--profile-dir=' + runtime])).toEqual({ profileDir: runtime, qa: { mode: 'offline' } });
  });
  it.each(['--profile-dir', '--profile-dir=', '--profile-dir=relative', '--profile-directory=/tmp/elsewhere', '--profile-dir=/bad\npath', '--profile-dir=/', '--profile-dir=' + homedir(), '--qa-offline', '--qa-network=26670,27000,27400'])('refuses malformed/incomplete option %s', option => expect(() => nativeStartupOptions([option])).toThrow());
  it.each(['16670,27000,27400', '26670,17000,27400', '26670,27000,17400', '26670,26670,27400', '26670,27000', '26670,27000,27400,28000', '1,27000,27400', '65536,27000,27400', 'abc,27000,27400', '26670,27000,5174', '26670,27000,4173'])('rejects unsafe fixture ports %s', ports => expect(() => nativeStartupOptions(['--profile-dir=' + runtime, '--qa-network=' + ports])).toThrow());
  it('refuses duplicate/conflicting flags without fallback', () => {
    expect(() => nativeStartupOptions(['--profile-dir=' + runtime, '--profile-dir=' + runtime])).toThrow();
    expect(() => nativeStartupOptions(['--profile-dir=' + runtime, '--qa-offline', '--qa-network=26670,27000,27400'])).toThrow();
    expect(() => nativeStartupOptions(['--profile-dir=' + runtime, '--qa-offline=true'])).toThrow();
  });
});

describe('profile isolation before Electron readiness', () => {
  it('does no work when an override is absent', () => { const app = application(); expect(configureNativeProfile(app, {})).toBeUndefined(); expect(app.setPath).not.toHaveBeenCalled(); });
  it('redirects user/session data, logs and crash dumps under the fresh profile', () => {
    const profileDir = directory(), app = application();
    expect(configureNativeProfile(app, { profileDir, qa })).toBe(profileDir);
    expect(app.setPath.mock.calls).toEqual([['userData', profileDir], ['sessionData', profileDir], ['logs', join(profileDir, 'logs')], ['crashDumps', join(profileDir, 'crash-dumps')]]);
    expect(readdirSync(profileDir).sort()).toEqual(['crash-dumps', 'logs']);
  });
  it('refuses late profile configuration', () => { const app = application(); app.isReady.mockReturnValue(true); expect(() => configureNativeProfile(app, { profileDir: directory(), qa })).toThrow(/before Electron/); expect(app.setPath).not.toHaveBeenCalled(); });
  it('refuses non-empty QA profiles without modifying saved bytes', () => {
    const profileDir = directory(), app = application(); writeFileSync(join(profileDir, 'saved.json'), 'preserve');
    expect(() => configureNativeProfile(app, { profileDir, qa })).toThrow(/non-empty/);
    expect(app.setPath).not.toHaveBeenCalled(); expect(readFileSync(join(profileDir, 'saved.json'), 'utf8')).toBe('preserve'); expect(readdirSync(profileDir)).toEqual(['saved.json']);
  });
  it('ordinary explicit profiles retain existing files', () => {
    const profileDir = directory(); writeFileSync(join(profileDir, 'saved.json'), 'preserve');
    configureNativeProfile(application(), { profileDir }); expect(readFileSync(join(profileDir, 'saved.json'), 'utf8')).toBe('preserve');
  });
  it('refuses absent, file and symlink targets', () => {
    const parent = directory(), target = directory(), file = join(parent, 'file'), link = join(parent, 'link'); writeFileSync(file, 'preserve'); symlinkSync(target, link);
    for (const profileDir of [join(parent, 'absent'), file, link]) { const app = application(); expect(() => configureNativeProfile(app, { profileDir, qa })).toThrow(); expect(app.setPath).not.toHaveBeenCalled(); }
  });
  it('does not follow pre-existing log subdirectory symlinks in ordinary profiles', () => {
    const profileDir = directory(), elsewhere = directory(), app = application(); symlinkSync(elsewhere, join(profileDir, 'logs'));
    expect(() => configureNativeProfile(app, { profileDir })).toThrow(/symlinks/); expect(app.setPath).not.toHaveBeenCalled(); expect(readdirSync(elsewhere)).toEqual([]);
  });
  it('writes one-shot private receipts and never overwrites an existing one', () => {
    const profileDir = directory(); const receipt: NativeQaReceipt = { schema: NATIVE_QA_SCHEMA, pid: 123, version: 'fixture', profileDir, userData: profileDir, sessionData: profileDir, appPath: '/fixture/app.asar', isPackaged: true, qa, timestamp: 'test' };
    writeNativeQaReceipt(profileDir, 'native-startup.json', receipt);
    expect(JSON.parse(readFileSync(join(profileDir, 'native-startup.json'), 'utf8'))).toEqual(receipt);
    expect(statSync(join(profileDir, 'native-startup.json')).mode & 0o777).toBe(0o600);
    expect(() => writeNativeQaReceipt(profileDir, 'native-startup.json', { ...receipt, pid: 999 })).toThrow();
    expect(JSON.parse(readFileSync(join(profileDir, 'native-startup.json'), 'utf8')).pid).toBe(123);
  });
});

describe('native QA endpoint policy', () => {
  it('retains ordinary app network behavior when QA is absent', () => { expect(() => assertNativeCommandTarget(connect('outside.example', 16670, true))).not.toThrow(); expect(() => assertNativeWorldTarget({ host: 'outside.example', port: 17000, tls: true })).not.toThrow(); });
  it('allows only the exact owned Universe and World', () => { expect(() => assertNativeCommandTarget(connect(), qa)).not.toThrow(); expect(() => assertNativeWorldTarget({ host: '127.0.0.1', port: 27000, tls: false }, qa)).not.toThrow(); });
  it.each([['127.0.0.1', 16670, false], ['localhost', 26670, false], ['outside.example', 26670, false], ['127.0.0.1', 26670, true]] as const)('refuses Universe %s:%s tls=%s', (host, port, tls) => expect(() => assertNativeCommandTarget(connect(host, port, tls), qa)).toThrow());
  it.each([['127.0.0.1', 17000, false], ['localhost', 27000, false], ['outside.example', 27000, false], ['127.0.0.1', 27000, true]] as const)('refuses advertised World %s:%s tls=%s', (host, port, tls) => expect(() => assertNativeWorldTarget({ host, port, tls }, qa)).toThrow());
  it('offline QA allows disconnect only and never starts an asset request', async () => {
    const offline: NativeQaMode = { mode: 'offline' }, fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(() => assertNativeCommandTarget({ type: 'disconnect' }, offline)).not.toThrow();
    for (const command of [connect(), { type: 'enter', world: 'Haven' }, { type: 'query', x: 0, z: 0 }] as ClientCommand[]) expect(() => assertNativeCommandTarget(command, offline)).toThrow(/offline/);
    await expect(createScopedAssetFetcher(input => nativeQaAssetTarget(input, offline))('http://127.0.0.1:27400/model')).rejects.toThrow(/offline/); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['http://127.0.0.1:17400/model', 'https://127.0.0.1:27400/model', 'http://localhost:27400/model', 'http://outside.example:27400/model', 'http://user:secret@127.0.0.1:27400/model', 'http://127.0.0.1:27400/model?token=x', 'http://127.0.0.1:27400/model#fragment', 'file:///tmp/model'])('rejects asset target without fetching %s', async url => { const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await expect(createScopedAssetFetcher(input => nativeQaAssetTarget(input, qa))(url)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled(); });
  it('uses bounded redirect-refusing fetch for allowed assets', async () => {
    const fetch = vi.fn(async () => new Response('original-rwx', { headers: { 'Content-Type': 'text/plain' } })); vi.stubGlobal('fetch', fetch);
    const result = await createScopedAssetFetcher(input => nativeQaAssetTarget(input, qa))('http://127.0.0.1:27400/models/arch.rwx');
    expect(new TextDecoder().decode(result.bytes)).toBe('original-rwx'); expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:27400/models/arch.rwx', expect.objectContaining({ redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal) }));
  });
});
