import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertIsolatedDirectory, assertPortsFree, comparePrimarySnapshots, ISOLATED_PORTS, isolatedConfigurations, matchesOwnedProcess, startIsolatedAxis, stopIsolatedAxis, validateIsolatedPorts, type IsolatedFixture } from '../scripts/axis-isolated.mjs';
import { assetNameFromRequest, loadIsolatedAssets } from '../scripts/axis-isolated-assets.mjs';

const root = resolve(import.meta.dirname, '..'), runtime = join(root, '.runtime');
// Tiny safety fixtures are deliberately retained, never recursively deleted.
const directory = mkdtempSync(join(runtime, 'axis-isolated-'));
const write = (path: string, value: string | Buffer) => writeFileSync(path, value, { mode: 0o600, flag: 'wx' });

describe('isolated integration lifecycle safety', () => {
  it('defaults to separate immutable loopback port assignments', () => {
    expect(validateIsolatedPorts()).toEqual({ universe: 26670, world: 27000, assets: 27400 });
    expect(Object.isFrozen(ISOLATED_PORTS)).toBe(true);
  });
  it.each([16670, 17000, 17400, 80, 65536, -1, 27000.5, NaN, '26670'])('refuses primary or invalid port %s', value => {
    expect(() => validateIsolatedPorts({ ...ISOLATED_PORTS, universe: value })).toThrow();
  });
  it('rejects duplicate, missing or extraneous assignments', () => {
    for (const value of [{ ...ISOLATED_PORTS, assets: 27000 }, { universe: 26670 }, { ...ISOLATED_PORTS, host: '0.0.0.0' }, null]) expect(() => validateIsolatedPorts(value)).toThrow();
  });
  it('detects occupied ports without connecting to or stopping their owner', async () => {
    let connections = 0; const server = createServer(socket => { connections++; socket.end(); });
    await new Promise<void>(resolve => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(assertPortsFree({ universe: port, world: 28001, assets: 28002 })).rejects.toThrow();
      expect(server.listening).toBe(true); expect(connections).toBe(0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('accepts only direct real isolated directories, never primary/broad/nested/symlink targets', () => {
    expect(assertIsolatedDirectory(directory)).toBe(directory);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const value of [root, runtime, join(runtime, 'axis'), join(directory, 'child'), '/']) expect(() => assertIsolatedDirectory(value)).toThrow();
    const links = mkdtempSync(join(runtime, 'axis-isolated-'));
    symlinkSync(directory, join(links, 'axis-isolated-linked'));
    expect(() => assertIsolatedDirectory(join(links, 'axis-isolated-linked'), links)).toThrow(/symlinks/);
  });
  it('never accepts a forged or stale serialized fixture as process ownership', async () => {
    const forged = JSON.parse(JSON.stringify({ directory, universePort: 16670, pid: process.pid })) as IsolatedFixture;
    await expect(startIsolatedAxis(forged)).rejects.toThrow(/created in this process/);
    await expect(stopIsolatedAxis(forged)).rejects.toThrow(/manifests cannot authorize/);
  });
  it('rejects reused PIDs, changed commands, primary paths and invalid PIDs', () => {
    const identity = `Mon Sep 7 12:34:56 2026 dotnet /immutable/Universe.dll --working-dir=${directory}/universe`;
    const record = { pid: 1234, directory, executable: '/immutable/Universe.dll', birthAndCommand: identity };
    expect(matchesOwnedProcess(record, identity)).toBe(true);
    expect(matchesOwnedProcess(record, identity.replace('12:34:56', '12:34:57'))).toBe(false);
    expect(matchesOwnedProcess(record, identity.replace(directory, join(runtime, 'axis')))).toBe(false);
    expect(matchesOwnedProcess({ ...record, directory: join(runtime, 'axis') }, identity)).toBe(false);
    expect(matchesOwnedProcess({ ...record, pid: 1 }, identity)).toBe(false);
    expect(matchesOwnedProcess(record, null)).toBe(false);
  });
  it('generates isolated configs with no primary port/path, remote host or inherited config', () => {
    const config = isolatedConfigurations(directory, ISOLATED_PORTS, 'cHJpdmF0ZQ==', 'a'.repeat(64), 'b'.repeat(48));
    expect(config.universe).toContain(`Port: 26670`); expect(config.world).toContain('Port: 27000');
    expect(config.world).toContain('DefaultObjectPath: http://127.0.0.1:27400/');
    expect(config.universe).toContain(join(directory, 'universe/universe.db'));
    expect(config.world).toContain(join(directory, 'world/data'));
    expect(config.attributes).toContain('allow_tourists: true');
    for (const text of Object.values(config)) {
      expect(text).not.toContain(join(runtime, 'axis/')); expect(text).not.toContain('0.0.0.0');
      expect(text).not.toMatch(/\b(?:16670|17000|17400)\b/);
    }
    write(join(directory, 'generated-universe.yml'), config.universe); write(join(directory, 'generated-world.yml'), config.world);
    expect(statSync(join(directory, 'generated-universe.yml')).mode & 0o777).toBe(0o600);
  });
  it('rejects malformed secret material before interpolating YAML', () => {
    expect(() => isolatedConfigurations(directory, ISOLATED_PORTS, "key'\nListen:\n Address: 0.0.0.0", 'a'.repeat(64), 'b'.repeat(48))).toThrow();
  });
  it('reports primary drift without attributing causation or attempting restoration', () => {
    const before = { files: { config: { sha256: 'a' }, database: { sha256: 'b' } }, processes: { universe: { pid: 7, identity: 'a' } } };
    expect(comparePrimarySnapshots(before, before).unchanged).toBe(true);
    const changed = comparePrimarySnapshots(before, { files: { config: { sha256: 'a' }, database: { sha256: 'c' } }, processes: { universe: { pid: 8, identity: 'b' } } });
    expect(changed.changedFiles).toEqual(['database']); expect(changed.changedProcesses).toEqual(['universe']);
    expect(changed.note).toContain('not its cause'); expect(changed.note).toContain('No primary data was restored');
  });
});

describe('isolated copied assets', () => {
  it.each(['/../universe/appsettings.yml', '/%2e%2e/universe/appsettings.yml', '//elsewhere/a.rwx', 'https://elsewhere/a.rwx', '/models/a.rwx?token=x', '/models/a.rwx#fragment', '/models%2fa%2f..%2fb', '/models\\a.rwx', '/%zz', '/models/%00.rwx'])('rejects non-allowlist request shape %s', path => {
    expect(assetNameFromRequest(path)).toBeNull();
  });
  it('decodes only safe basenames and directory members', () => {
    expect(assetNameFromRequest('/avatars/avatars.dat')).toBe('avatars/avatars.dat');
    expect(assetNameFromRequest('/models/%61rch.rwx')).toBe('models/arch.rwx');
  });
  it('loads only hash-matching manifest files into a bounded in-memory map', () => {
    const assetDirectory = mkdtempSync(join(runtime, 'axis-isolated-'));
    mkdirSync(join(assetDirectory, 'assets/models'), { recursive: true, mode: 0o700 });
    const body = Buffer.from('# Original isolated test\nModelBegin\nModelEnd\n');
    write(join(assetDirectory, 'assets/models/fixture.rwx'), body);
    write(join(assetDirectory, 'manifest.json'), JSON.stringify({ schema: 1, directory: assetDirectory, ports: ISOLATED_PORTS, assets: { 'models/fixture.rwx': createHash('sha256').update(body).digest('hex') } }));
    const loaded = loadIsolatedAssets(join(assetDirectory, 'manifest.json'));
    expect(loaded.port).toBe(27400); expect([...loaded.files.keys()]).toEqual(['models/fixture.rwx']); expect(loaded.files.get('models/fixture.rwx')).toEqual(body);
  });
  it('refuses a manifest that attempts to read primary data through a symlink', () => {
    const assetDirectory = mkdtempSync(join(runtime, 'axis-isolated-'));
    mkdirSync(join(assetDirectory, 'assets'), { mode: 0o700 });
    symlinkSync(join(directory), join(assetDirectory, 'assets/models'));
    write(join(assetDirectory, 'manifest.json'), JSON.stringify({ schema: 1, directory: assetDirectory, ports: ISOLATED_PORTS, assets: { 'models/generated-universe.yml': 'a'.repeat(64) } }));
    expect(() => loadIsolatedAssets(join(assetDirectory, 'manifest.json'))).toThrow(/symlink/);
  });
  it('refuses incorrect hashes rather than serving modified fixtures', () => {
    const assetDirectory = mkdtempSync(join(runtime, 'axis-isolated-'));
    mkdirSync(join(assetDirectory, 'assets'), { mode: 0o700 }); write(join(assetDirectory, 'assets/fixture.rwx'), 'changed');
    write(join(assetDirectory, 'manifest.json'), JSON.stringify({ schema: 1, directory: assetDirectory, ports: ISOLATED_PORTS, assets: { 'fixture.rwx': 'a'.repeat(64) } }));
    expect(() => loadIsolatedAssets(join(assetDirectory, 'manifest.json'))).toThrow(/hash or budget/);
  });
});
