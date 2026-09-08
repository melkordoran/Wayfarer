import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { auditPublicTree, PUBLIC_TREE_LIMITS } from '../scripts/audit-public-tree.mjs';

const directories: string[] = [];
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0); return result.stdout;
}
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'wayfarer-public-tree-')); directories.push(cwd);
  git(cwd, 'init', '--quiet', '--initial-branch=main'); return cwd;
}
function put(cwd: string, path: string, value: string | Buffer) {
  const full = join(cwd, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, value);
}
function rules(cwd: string, staged = false) { return auditPublicTree({ cwd, staged }).findings.map((finding: { rule: string }) => finding.rule); }
const privateIp = [192, 168, 7, 42].join('.');
const personalPath = '/Users/' + 'real-person/work';
const token = 'ghp_' + 'A'.repeat(40);
const privateKey = '-----BEGIN ' + 'PRIVATE KEY-----\nTESTONLY\n-----END ' + 'PRIVATE KEY-----';
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('read-only public publication gate', () => {
  it('accepts the explicit source/configuration allowlist and documented synthetic examples', () => {
    const cwd = repo();
    for (const name of ['README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', '.gitattributes', '.nvmrc', '.editorconfig', 'vitest.config.ts', '.github/workflows/ci.yml', 'src/app.ts', 'public/assets/models/original.rwx']) put(cwd, name, 'original\n');
    put(cwd, 'tests/example.ts', '127.0.0.1 localhost visitor@example.invalid ' + '/Users/' + 'example/profile ' + '/home/' + 'runner/work\n');
    const report = auditPublicTree({ cwd }); expect(report.passed).toBe(true); expect(report.files).toBe(14); expect(report.findings).toEqual([]);
  });
  it('uses Git visibility by default, not an unrestricted recursive directory scan', () => {
    const cwd = repo(); put(cwd, '.gitignore', '.runtime/\n.env\n'); put(cwd, 'README.md', 'safe'); put(cwd, '.runtime/private.json', privateKey); put(cwd, '.env', token);
    expect(auditPublicTree({ cwd }).passed).toBe(true);
    git(cwd, 'add', '-f', '.runtime/private.json'); expect(rules(cwd)).toContain('unexpected-root'); expect(rules(cwd, true)).toContain('unexpected-root');
  });
  it.each(['unexpected.txt', '.env.local', '.npmrc', 'docs/.env.production', 'build/signing.p12', 'public/assets/private.pem', 'tests/fixtures/user.key', 'docs/credentials.json', 'docs/WorldServer.yml', 'src/appsettings.json', 'docs/cache/data.txt', 'docs/reports/summary.json', 'docs/screenshot.png', 'src/app.js.map', 'scripts/server.process.json', 'docs/dump.db', 'docs/archive.zip'])('rejects unapproved root/private artifact %s', path => {
    const cwd = repo(); put(cwd, path, 'not a real secret'); const report = auditPublicTree({ cwd });
    expect(report.passed).toBe(false); expect(report.findings.some((finding: { rule: string }) => ['unexpected-root', 'private-artifact'].includes(finding.rule))).toBe(true);
  });
  it('rejects a symlink without following its private target in either mode', () => {
    const cwd = repo(), outside = mkdtempSync(join(tmpdir(), 'wayfarer-public-tree-private-')); directories.push(outside);
    put(outside, 'secret', token); mkdirSync(join(cwd, 'docs')); symlinkSync(join(outside, 'secret'), join(cwd, 'docs/link.txt'));
    const working = auditPublicTree({ cwd }); expect(working.findings.map((value: { rule: string }) => value.rule)).toEqual(['symlink']); expect(JSON.stringify(working)).not.toContain(outside);
    git(cwd, 'add', 'docs/link.txt'); expect(rules(cwd, true)).toEqual(['symlink']);
  });
  it('rejects oversized individual files without printing or reading their contents into the report', () => {
    const cwd = repo(); put(cwd, 'public/assets/oversized.rwx', Buffer.alloc(PUBLIC_TREE_LIMITS.fileBytes + 1, 65));
    expect(rules(cwd)).toContain('file-size-limit'); git(cwd, 'add', '.'); expect(rules(cwd, true)).toContain('file-size-limit');
  });
  it('enforces the total visible byte budget in both working and index modes', () => {
    const cwd = repo(); for (let i = 0; i < 11; i++) put(cwd, 'public/assets/large-' + i + '.rwx', Buffer.alloc(PUBLIC_TREE_LIMITS.fileBytes, 65));
    expect(rules(cwd)).toContain('total-size-limit'); git(cwd, 'add', '.'); expect(rules(cwd, true)).toContain('total-size-limit');
  });
  it('enforces a bounded count before reading file contents', () => {
    const cwd = repo(); for (let i = 0; i <= PUBLIC_TREE_LIMITS.files; i++) put(cwd, 'docs/file-' + i + '.md', 'small');
    const report = auditPublicTree({ cwd }); expect(report.files).toBe(PUBLIC_TREE_LIMITS.files + 1); expect(report.bytes).toBe(0); expect(report.findings).toEqual([{ path: '(tree)', line: 1, rule: 'file-count-limit' }]);
  });
  it('redacts secret findings and identifies line numbers, including ASCII markers inside binary files', () => {
    const cwd = repo(); put(cwd, 'src/leak.ts', 'safe\n' + token + '\n' + privateKey); put(cwd, 'build/icon.png', Buffer.from('\0' + token));
    const report = auditPublicTree({ cwd }); expect(report.passed).toBe(false);
    expect(report.findings).toContainEqual({ path: 'src/leak.ts', line: 2, rule: 'secret-token' });
    expect(report.findings).toContainEqual({ path: 'src/leak.ts', line: 3, rule: 'private-key' });
    expect(report.findings).toContainEqual({ path: 'build/icon.png', line: 1, rule: 'secret-token' });
    expect(JSON.stringify(report)).not.toContain(token); expect(JSON.stringify(report)).not.toContain('TESTONLY');
  });
  it('detects strong generic secret assignments without treating dynamic environment reads as literals', () => {
    const cwd = repo(); put(cwd, 'src/config.ts', 'access' + 'Token = "' + 'A'.repeat(36) + '";\napiKey = process.env.API_KEY;');
    expect(rules(cwd)).toEqual(['secret-literal']);
  });
  it('redacts tokens even if a rejected filename itself contains one', () => {
    const cwd = repo(); put(cwd, token + '.txt', 'private filename'); const report = auditPublicTree({ cwd });
    expect(report.passed).toBe(false); expect(JSON.stringify(report)).not.toContain(token); expect(report.findings[0].path).toContain('[redacted-token]');
  });
  it('detects LAN addresses even when adjacent to a word and real macOS/Linux/Windows home paths', () => {
    const cwd = repo(); put(cwd, 'docs/private.md', ['Universe' + privateIp + ':6670', personalPath, '/home/' + 'private-person/data', 'C:' + '\\Users\\' + 'private-person\\data', ['fd12', '3456', '', '1'].join(':')].join('\n'));
    const report = auditPublicTree({ cwd }); expect(report.findings.filter((finding: { rule: string }) => finding.rule === 'private-lan-address')).toHaveLength(2);
    expect(report.findings.filter((finding: { rule: string }) => finding.rule === 'personal-home-path')).toHaveLength(3);
    expect(JSON.stringify(report)).not.toContain(privateIp); expect(JSON.stringify(report)).not.toContain(personalPath);
  });
  it('permits only the exact documented public key block at its exact test path', () => {
    const cwd = repo(), fixture = readFileSync(resolve(import.meta.dirname, 'protocol-tls.test.ts'), 'utf8');
    put(cwd, 'tests/protocol-tls.test.ts', fixture);
    const accepted = auditPublicTree({ cwd }); expect(accepted.passed).toBe(true); expect(accepted.exceptions).toHaveLength(1); expect(accepted.exceptions[0].rule).toBe('public-localhost-tls-key');
    put(cwd, 'tests/copied-tls.test.ts', fixture); expect(rules(cwd)).toContain('private-key');
    rmSync(join(cwd, 'tests/copied-tls.test.ts'));
    put(cwd, 'tests/protocol-tls.test.ts', fixture.replace('MIIEvQ', 'MIIEvR')); expect(rules(cwd)).toContain('private-key');
  });
  it('does not allow an extra or truncated private key inside the exempt test file', () => {
    const cwd = repo(), fixture = readFileSync(resolve(import.meta.dirname, 'protocol-tls.test.ts'), 'utf8');
    put(cwd, 'tests/protocol-tls.test.ts', fixture + '\n' + privateKey); expect(rules(cwd)).toContain('private-key');
    put(cwd, 'tests/protocol-tls.test.ts', fixture + '\n-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'); expect(rules(cwd)).toContain('private-key');
  });
  it.each(['https://packages.example/private.tgz', 'https://user:secret@registry.npmjs.org/package.tgz', 'http://registry.npmjs.org/package.tgz', 'file:../private', 'git+ssh://git@packages.example/repo'])('rejects nonpublic lockfile resolution without exposing %s', resolved => {
    const cwd = repo(); put(cwd, 'package-lock.json', JSON.stringify({ packages: { 'node_modules/example': { resolved } } }, null, 2));
    const report = auditPublicTree({ cwd }); expect(report.findings[0].rule).toBe('nonpublic-package-resolver'); expect(JSON.stringify(report)).not.toContain(resolved);
  });
  it('accepts public npm tarball resolutions and rejects malformed lockfiles', () => {
    const cwd = repo(); put(cwd, 'package-lock.json', JSON.stringify({ packages: { '': { version: '1.0.0' }, 'node_modules/example': { resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz' } } }));
    expect(auditPublicTree({ cwd }).passed).toBe(true); put(cwd, 'package-lock.json', '{'); expect(rules(cwd)).toEqual(['invalid-lockfile']);
  });
  it('audits staged blob bytes, catching a staged secret after an unstaged sanitization', () => {
    const cwd = repo(); put(cwd, 'src/config.ts', token); git(cwd, 'add', 'src/config.ts'); put(cwd, 'src/config.ts', 'sanitized');
    expect(auditPublicTree({ cwd }).passed).toBe(true); expect(rules(cwd, true)).toEqual(['secret-token']);
  });
  it('ignores untracked and unstaged content in index-only mode, but default still sees them', () => {
    const cwd = repo(); put(cwd, 'src/config.ts', 'safe'); git(cwd, 'add', '.'); put(cwd, 'src/config.ts', token); put(cwd, 'docs/private.md', privateIp);
    expect(auditPublicTree({ cwd, staged: true }).passed).toBe(true); expect(rules(cwd)).toEqual(['private-lan-address', 'secret-token']);
  });
  it('runs index-only without modifying the index or working tree, and rejects unsupported CLI arguments safely', () => {
    const cwd = repo(); put(cwd, 'README.md', 'safe'); git(cwd, 'add', '.');
    const script = resolve(import.meta.dirname, '../scripts/audit-public-tree.mjs'), before = readFileSync(join(cwd, '.git/index'));
    const result = spawnSync(process.execPath, [script, '--staged'], { cwd, encoding: 'utf8' }); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).mode).toBe('index');
    expect(readFileSync(join(cwd, '.git/index')).equals(before)).toBe(true); expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('safe');
    const bad = spawnSync(process.execPath, [script, '--unknown=' + token], { cwd, encoding: 'utf8' }); expect(bad.status).toBe(2); expect(bad.stderr).not.toContain(token);
  });
});
