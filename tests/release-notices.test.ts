import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import { createPackage, createPackageWithOptions } from '@electron/asar';
import { describe, expect, it } from 'vitest';
import { FRAMEWORK_NOTICES, FRAMEWORK_NOTICE_ELECTRON_VERSION, RENDERER_NOTICE_PACKAGES, SQUIRREL_OMNIBUS_NOTICE, verifyReleaseNotices } from '../scripts/verify-release-notices.mjs';

// Complete MIT notice from Squirrel.Mac at the revision documented by the
// verifier. A tiny independent HTML fixture avoids copying a 20MB distribution
// into every test and does not require an installed Electron binary download.
const squirrelLicense = `The MIT License (MIT)

Copyright (c) 2013 GitHub

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`;

// Tiny original licensing-shaped records test the verifier, not any legal grant.
// Every filesystem mutation is confined to a new temporary fixture, retained.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wayfarer-notice-test-'));
  const appPath = join(root, 'release', 'test', 'mac-arm64', 'Wayfarer.app');
  const archiveSource = join(root, 'archive-source'), archive = join(appPath, 'Contents', 'Resources', 'app.asar');
  function write(path: string, data: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); }
  function source(name: string, data: string | Buffer) { write(join(root, name), data); }
  function packed(name: string, data: string | Buffer) { write(join(archiveSource, name), data); }
  const version = '0.0.0-test';
  const dependencies = Object.fromEntries(['fflate', 'lucide-react', 'react', 'react-dom', 'three', 'ws'].map(name => [name, '1.2.3']));
  const pkg = { name: 'wayfarer-client', version, dependencies };
  source('package.json', JSON.stringify(pkg)); packed('package.json', JSON.stringify(pkg));
  const packages: Record<string, { version: string; license: string }> = {};
  const sections: string[] = [];
  for (const name of [...RENDERER_NOTICE_PACKAGES, 'electron']) {
    const license = name === 'lucide-react' ? 'ISC' : 'MIT', version = name === 'electron' ? FRAMEWORK_NOTICE_ELECTRON_VERSION : '1.2.3';
    packages[`node_modules/${name}`] = { version, license };
    source(`node_modules/${name}/package.json`, JSON.stringify({ name, version, license }));
    const text = `Original ${name} complete license fixture.\nKeep this attribution and permission test text.\n${name === 'lucide-react' ? 'Original Feather MIT attribution fixture.\n' : ''}`;
    source(`node_modules/${name}/LICENSE`, text);
    if (name !== 'electron') sections.push(`## ${name} - ${version} (${license})\n\n${text}`);
  }
  source('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages }));
  const renderer = sections.join('\n');
  source('dist/third-party-licenses.txt', renderer); packed('dist/third-party-licenses.txt', renderer);
  for (const [name, text] of [['LICENSE', 'Original project-license test text.\n'], ['THIRD_PARTY_NOTICES.md', 'Original third-party notice index test text.\n']]) {
    source(name, text); packed(name, text);
  }
  for (const name of ['assets/LICENSE.txt', 'assets/avatars/LICENSE.txt', 'assets/textures/LICENSE.txt']) {
    const text = `Original CC0 fixture notice for ${name}.\n`;
    source(`public/${name}`, text); packed(`dist/${name}`, text);
  }
  source('node_modules/electron/dist/version', FRAMEWORK_NOTICE_ELECTRON_VERSION + '\n');
  for (const [name, destination] of [['LICENSE', 'LICENSE.electron.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
    const text = name === 'LICENSES.chromium.html' ? `<div class="product"><span class="title">Squirrel</span><pre>${squirrelLicense.replace(/"/g, '&quot;')}</pre></div>`
      : `Original complete ${name} Electron-distribution notice fixture.\n`;
    source(`node_modules/electron/dist/${name}`, text);
    write(join(appPath, 'Contents', 'Resources', 'licenses', destination), text);
  }
  for (const framework of FRAMEWORK_NOTICES) {
    const bytes = readFileSync(join(import.meta.dirname, '..', 'build', 'licenses', framework.file));
    source(`build/licenses/${framework.file}`, bytes);
    write(join(appPath, 'Contents', 'Resources', 'licenses', framework.file), bytes);
  }
  const pack = async () => { await finished(await createPackage(archiveSource, archive)); };
  await pack();
  const verify = () => verifyReleaseNotices({ root, appPath });
  const rewriteRenderer = async (text: string) => { source('dist/third-party-licenses.txt', text); packed('dist/third-party-licenses.txt', text); await pack(); };
  return { root, appPath, archive, archiveSource, pkg, packages, renderer, source, packed, pack, verify, write, rewriteRenderer };
}

describe('read-only release notice verification', () => {
  it('matches all ten notice files, locked versions and full dependency texts without changing bytes', async () => {
    const f = await fixture();
    const before = readFileSync(f.archive), report = f.verify();
    expect(report.passed).toBe(true); expect(report.matchedNotices).toHaveLength(10); expect(report.dependencies).toHaveLength(7);
    expect(report.frameworkNotices).toEqual(FRAMEWORK_NOTICES);
    expect(report.omnibusNotices).toEqual([SQUIRREL_OMNIBUS_NOTICE]);
    expect(report.version).toBe('0.0.0-test'); expect(report.coverage).toContain('ws is development preview-only');
    expect(report.limits).toContain('not attest Electron binary identity'); expect(readFileSync(f.archive)).toEqual(before);
    const rootLicense = report.matchedNotices.find(item => item.packaged === 'LICENSE')!;
    expect(rootLicense.sha256).toBe(createHash('sha256').update(readFileSync(join(f.root, 'LICENSE'))).digest('hex'));
  });
  it.each(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist/third-party-licenses.txt', 'dist/assets/LICENSE.txt', 'dist/assets/avatars/LICENSE.txt', 'dist/assets/textures/LICENSE.txt'])('rejects missing ASAR %s', async name => {
    const f = await fixture(); unlinkSync(join(f.archiveSource, name)); await f.pack();
    expect(f.verify).toThrow(/cannot verify packaged/);
  });
  it.each(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist/third-party-licenses.txt', 'dist/assets/avatars/LICENSE.txt'])('rejects tampered ASAR %s, including after a cached successful read', async name => {
    const f = await fixture(); expect(f.verify().passed).toBe(true); f.packed(name, 'Changed notice bytes.\n'); await f.pack();
    expect(f.verify).toThrow(/differs from source/);
  });
  it.each(['LICENSE.electron.txt', 'LICENSES.chromium.html'])('rejects missing and altered Electron resource %s', async name => {
    const f = await fixture(), path = join(f.appPath, 'Contents', 'Resources', 'licenses', name);
    const original = readFileSync(path); unlinkSync(path); expect(f.verify).toThrow(/missing required file/);
    f.write(path, Buffer.concat([original, Buffer.from('altered')])); expect(f.verify).toThrow(/differs from source/);
  });
  it('does not accept a symlink in place of a matching resource', async () => {
    const f = await fixture(), path = join(f.appPath, 'Contents', 'Resources', 'licenses', 'LICENSE.electron.txt');
    unlinkSync(path); symlinkSync(join(f.root, 'node_modules/electron/dist/LICENSE'), path);
    expect(f.verify).toThrow(/linked notice paths/);
  });
  it.each(FRAMEWORK_NOTICES)('rejects missing and altered $name framework resources', async framework => {
    const f = await fixture(), path = join(f.appPath, 'Contents', 'Resources', 'licenses', framework.file);
    const original = readFileSync(path); unlinkSync(path); expect(f.verify).toThrow(/missing required file/);
    f.write(path, Buffer.concat([original, Buffer.from('altered')])); expect(f.verify).toThrow(/differs from source/);
  });
  it.each(FRAMEWORK_NOTICES)('rejects identically tampered source and package $name notices against the upstream hash', async framework => {
    const f = await fixture(), altered = 'Altered complete-looking license.\n';
    f.source(`build/licenses/${framework.file}`, altered);
    f.write(join(f.appPath, 'Contents', 'Resources', 'licenses', framework.file), altered);
    expect(f.verify).toThrow(/pinned upstream framework license hash differs/);
  });
  it('ties framework notices to Electron44.2.0 even when a newer installed distribution and lock agree', async () => {
    const f = await fixture(), version = '44.2.1';
    f.source('node_modules/electron/package.json', JSON.stringify({ name: 'electron', version, license: 'MIT' }));
    f.source('node_modules/electron/dist/version', version + '\n');
    f.source('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { ...f.packages, 'node_modules/electron': { version, license: 'MIT' } } }));
    expect(f.verify).toThrow(/Electron version changed; re-audit/);
  });
  it.each(['missing', 'changed'])('rejects %s Squirrel text even when the installed and packaged omnibus bytes agree', async kind => {
    const f = await fixture(), path = join(f.appPath, 'Contents', 'Resources', 'licenses', 'LICENSES.chromium.html');
    const original = readFileSync(path, 'utf8');
    const altered = kind === 'missing' ? '<html>No Squirrel license entry.</html>' : original.replace('Copyright (c) 2013 GitHub', 'Incomplete copyright notice');
    f.source('node_modules/electron/dist/LICENSES.chromium.html', altered); f.write(path, altered);
    expect(f.verify).toThrow(/Squirrel license entry is absent|full pinned Squirrel license differs/);
  });
  it('rejects unpacked root notices rather than following ASAR sidecar paths', async () => {
    const f = await fixture(); await finished(await createPackageWithOptions(f.archiveSource, f.archive, { unpack: 'LICENSE' }));
    expect(f.verify).toThrow(/unpacked/);
  });
  it('requires the full Lucide notice, including the Feather portion, even when build and archive agree', async () => {
    const f = await fixture(); await f.rewriteRenderer(f.renderer.replace('Original Feather MIT attribution fixture.\n', ''));
    expect(f.verify).toThrow(/full installed license.*lucide-react/);
  });
  it.each(['missing', 'duplicated', 'unknown'])('rejects %s renderer package coverage', async kind => {
    const f = await fixture();
    const next = kind === 'missing' ? f.renderer.replace(/^## three[^]*$/m, '')
      : f.renderer + (kind === 'duplicated' ? '\n## three - 1.2.3 (MIT)\n' : '\n## unreviewed - 1.2.3 (MIT)\n');
    await f.rewriteRenderer(next); expect(f.verify).toThrow(/missing, duplicated or include unreviewed/);
  });
  it('rejects stale renderer heading versions', async () => {
    const f = await fixture(); await f.rewriteRenderer(f.renderer.replace('## fflate - 1.2.3', '## fflate - 1.2.2'));
    expect(f.verify).toThrow(/heading differs: fflate/);
  });
  it('rejects incomplete installed/locked version or license metadata', async () => {
    const f = await fixture(); f.source('node_modules/react/package.json', JSON.stringify({ name: 'react', version: '1.2.4', license: 'MIT' }));
    expect(f.verify).toThrow(/installed\/locked dependency metadata differs: react/);
    f.source('node_modules/react/package.json', JSON.stringify({ name: 'react', version: '1.2.3', license: 'Different' }));
    expect(f.verify).toThrow(/metadata differs: react/);
  });
  it('rejects mismatched Electron distribution versions', async () => {
    const f = await fixture(); f.source('node_modules/electron/dist/version', '1.2.2\n');
    expect(f.verify).toThrow(/Electron distribution version differs/);
  });
  it('requires review when the declared dependency set grows', async () => {
    const f = await fixture(); f.source('package.json', JSON.stringify({ ...f.pkg, dependencies: { ...f.pkg.dependencies, unreviewed: '1.2.3' } }));
    expect(f.verify).toThrow(/runtime dependency set changed/);
  });
  it('rejects a source/package version mismatch', async () => {
    const f = await fixture(); f.packed('package.json', JSON.stringify({ ...f.pkg, version: '0.0.0-older' })); await f.pack();
    expect(f.verify).toThrow(/application versions differ/);
  });
  it('refuses non-release or external targets before reading their app contents', async () => {
    const f = await fixture();
    expect(() => verifyReleaseNotices({ root: f.root, appPath: join(f.root, 'development', 'Wayfarer.app') })).toThrow(/inside/);
    expect(() => verifyReleaseNotices({ root: f.root, appPath: '/Applications/Wayfarer.app' })).toThrow(/inside/);
  });
  it('bounds corrupt ASAR header lengths before the ASAR library allocates a header', async () => {
    const f = await fixture(), prefix = Buffer.alloc(8); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(0xffffffff, 4);
    f.write(f.archive, prefix); expect(f.verify).toThrow(/oversized ASAR header/);
  });
});
