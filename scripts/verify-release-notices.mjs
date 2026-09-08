/** Import-pure, read-only macOS release notice verification. This checks notice
 * inclusion and locked-package consistency, not ownership or legal clearance. */
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, statFile, uncache } from '@electron/asar';

export const RENDERER_NOTICE_PACKAGES = Object.freeze(['fflate', 'lucide-react', 'react', 'react-dom', 'scheduler', 'three']);
export const FRAMEWORK_NOTICE_ELECTRON_VERSION = '44.2.0';
export const FRAMEWORK_NOTICES = Object.freeze([
  Object.freeze({ name: 'Mantle', file: 'LICENSE.Mantle.txt', revision: '2a8e2123a3931038179ee06105c9e6ec336b12ea',
    sourceUrl: 'https://raw.githubusercontent.com/Mantle/Mantle/2a8e2123a3931038179ee06105c9e6ec336b12ea/LICENSE.md',
    bytes: 2445, sha256: '285eede6f638adc9c352be7d66134611e5ea95044095a84de9867fb864e66eab' }),
  Object.freeze({ name: 'ReactiveObjC', file: 'LICENSE.ReactiveObjC.txt', revision: '74ab5baccc6f7202c8ac69a8d1e152c29dc1ea76',
    sourceUrl: 'https://raw.githubusercontent.com/ReactiveCocoa/ReactiveObjC/74ab5baccc6f7202c8ac69a8d1e152c29dc1ea76/LICENSE.md',
    bytes: 1093, sha256: '095fec1a3d6ad029fe0661fa6092a272d50af016b1771992e0bba9b2a73e7763' }),
]);
export const SQUIRREL_OMNIBUS_NOTICE = Object.freeze({ name: 'Squirrel', revision: '8d808803bc89ec0e2aa1450474856dfee3b00c6b',
  sourceUrl: 'https://raw.githubusercontent.com/Squirrel/Squirrel.Mac/8d808803bc89ec0e2aa1450474856dfee3b00c6b/LICENSE',
  normalizedSha256: 'c72401a39a3e930223e33f2ffe78cc38c51df3dcba6a77d2b45c1b0bf841d345' });
const DIRECT_PACKAGES = Object.freeze(['fflate', 'lucide-react', 'react', 'react-dom', 'three', 'ws']);
const LICENSE_LIMIT = 4 * 1024 * 1024;
const CHROMIUM_LIMIT = 32 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizedText = bytes => bytes.toString('utf8').replace(/\r\n/g, '\n').trim();
function fail(message) { throw new Error(`Release notices: ${message}`); }
function inside(root, path) {
  const name = relative(root, path);
  if (!name || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) fail('path must be strictly inside its expected root');
  return name;
}
function regularFile(root, path, limit) {
  const name = inside(root, path), segments = name.split(sep);
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]);
    let stat;
    try { stat = lstatSync(current); } catch { fail(`missing required file or parent: ${name}`); }
    if (stat.isSymbolicLink()) fail(`linked notice paths are not supported: ${name}`);
    if (i < segments.length - 1) { if (!stat.isDirectory()) fail(`invalid notice parent: ${name}`); }
    else {
      if (!stat.isFile() || stat.size < 1 || stat.size > limit) fail(`invalid or oversized required file: ${name}`);
      return stat;
    }
  }
}
function read(root, name, limit = LICENSE_LIMIT) {
  const path = join(root, name); regularFile(root, path, limit); return readFileSync(path);
}
function json(root, name) {
  try { return JSON.parse(read(root, name).toString('utf8')); }
  catch (error) { fail(`cannot read JSON ${name}: ${error instanceof Error ? error.message : 'invalid data'}`); }
}
function archiveReader(root, app) {
  const archive = join(app, 'Contents', 'Resources', 'app.asar');
  const size = regularFile(root, archive, 512 * 1024 * 1024).size;
  const prefix = Buffer.alloc(8), fd = openSync(archive, 'r');
  try { if (readSync(fd, prefix, 0, 8, 0) !== 8) fail('truncated ASAR header'); }
  finally { closeSync(fd); }
  const headerSize = prefix.readUInt32LE(4);
  if (prefix.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > 4 * 1024 * 1024 || headerSize + 8 > size) fail('invalid or oversized ASAR header');
  // The library caches headers. Repeated verification must inspect the current
  // file, not an earlier artifact that occupied the same path.
  uncache(archive);
  return name => {
    try {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = statFile(archive, parts.slice(0, i).join('/'), false);
        if (parent.link || parent.unpacked || !parent.files) fail(`linked or unpacked ASAR notice parent: ${name}`);
      }
      const info = statFile(archive, name, false);
      if (info.link || info.files || info.unpacked || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > LICENSE_LIMIT
        || !/^\d+$/.test(info.offset ?? '') || !Number.isSafeInteger(Number(info.offset)) || Number(info.offset) + info.size + headerSize + 8 > size)
        fail(`invalid, linked, unpacked or oversized ASAR notice: ${name}`);
      const bytes = extractFile(archive, name, false);
      if (bytes.length !== info.size) fail(`truncated ASAR notice: ${name}`);
      return bytes;
    } catch (error) { fail(`cannot verify packaged ${name}: ${error instanceof Error ? error.message : 'missing or invalid file'}`); }
  };
}

export function verifyReleaseNotices({ appPath, root: inputRoot }) {
  if (typeof inputRoot !== 'string' || typeof appPath !== 'string') fail('root and appPath are required');
  const requestedRoot = resolve(inputRoot), root = realpathSync(requestedRoot);
  const requestedApp = resolve(requestedRoot, appPath);
  const app = join(root, inside(requestedRoot, requestedApp));
  inside(join(root, 'release'), app);
  if (!app.endsWith(`${sep}Wayfarer.app`)) fail('choose a Wayfarer.app inside this project release directory');
  const packedFile = archiveReader(root, app);
  const sourcePackage = json(root, 'package.json'), lock = json(root, 'package-lock.json');
  const packedPackage = JSON.parse(packedFile('package.json').toString('utf8'));
  if (!sourcePackage.version || sourcePackage.version !== packedPackage.version) fail('source and packaged application versions differ');
  const direct = Object.keys(sourcePackage.dependencies ?? {}).sort();
  if (JSON.stringify(direct) !== JSON.stringify([...DIRECT_PACKAGES].sort())) fail('runtime dependency set changed; review and update the notice coverage policy');
  const checks = [];
  function matched(sourceName, packagedName, actual) {
    const expected = read(root, sourceName, sourceName.endsWith('LICENSES.chromium.html') ? CHROMIUM_LIMIT : LICENSE_LIMIT);
    if (!actual.equals(expected)) fail(`packaged notice differs from source: ${packagedName}`);
    if (!normalizedText(expected)) fail(`required notice is empty: ${sourceName}`);
    checks.push({ source: sourceName, packaged: packagedName, bytes: expected.length, sha256: sha256(expected) });
    return expected;
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) matched(name, name, packedFile(name));
  const renderer = matched('dist/third-party-licenses.txt', 'dist/third-party-licenses.txt', packedFile('dist/third-party-licenses.txt'));
  const rendererText = normalizedText(renderer);
  const headings = [...rendererText.matchAll(/^## (.+) - (\S+) \((.+)\)$/gm)].map(match => ({ name: match[1], version: match[2], license: match[3] }));
  if (JSON.stringify(headings.map(item => item.name).sort()) !== JSON.stringify([...RENDERER_NOTICE_PACKAGES].sort())) fail('generated renderer notices are missing, duplicated or include unreviewed bundled dependencies');
  const dependencies = [];
  for (const name of [...RENDERER_NOTICE_PACKAGES, 'electron']) {
    const installed = json(root, `node_modules/${name}/package.json`), locked = lock.packages?.[`node_modules/${name}`];
    if (installed.name !== name || !installed.version || !locked || installed.version !== locked.version || installed.license !== locked.license)
      fail(`installed/locked dependency metadata differs: ${name}`);
    dependencies.push({ name, version: installed.version, license: installed.license });
    if (name === 'electron') {
      if (read(root, 'node_modules/electron/dist/version').toString('utf8').trim() !== installed.version) fail('installed Electron distribution version differs from its package');
      if (installed.version !== FRAMEWORK_NOTICE_ELECTRON_VERSION) fail('Electron version changed; re-audit pinned macOS framework licenses before publication');
      continue;
    }
    const heading = headings.find(item => item.name === name);
    if (heading.version !== installed.version || heading.license !== installed.license) fail(`generated renderer dependency heading differs: ${name}`);
    const license = normalizedText(read(root, `node_modules/${name}/LICENSE`));
    if (!license || !rendererText.includes(license)) fail(`full installed license is absent from renderer notices: ${name}`);
  }
  for (const [source, destination] of [['LICENSE', 'LICENSE.electron.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
    const packaged = join('Contents', 'Resources', 'licenses', destination);
    const bytes = matched(`node_modules/electron/dist/${source}`, packaged, read(root, relative(root, join(app, packaged)), source === 'LICENSE' ? LICENSE_LIMIT : CHROMIUM_LIMIT));
    if (source === 'LICENSES.chromium.html') {
      const text = bytes.toString('utf8'), title = '<span class="title">Squirrel</span>', start = text.indexOf(title);
      if (start < 0 || text.indexOf(title, start + title.length) !== -1) fail('Squirrel license entry is absent or duplicated in the Chromium omnibus');
      const section = text.slice(start, text.indexOf('<div class="product">', start) < 0 ? undefined : text.indexOf('<div class="product">', start));
      const encoded = /<pre>([\s\S]*?)<\/pre>/.exec(section)?.[1];
      const decoded = encoded?.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      if (!decoded || sha256(normalizedText(Buffer.from(decoded))) !== SQUIRREL_OMNIBUS_NOTICE.normalizedSha256)
        fail('full pinned Squirrel license differs in the Chromium omnibus');
    }
  }
  for (const framework of FRAMEWORK_NOTICES) {
    const source = `build/licenses/${framework.file}`, packaged = join('Contents', 'Resources', 'licenses', framework.file);
    const bytes = matched(source, packaged, read(root, relative(root, join(app, packaged))));
    if (bytes.length !== framework.bytes || sha256(bytes) !== framework.sha256) fail(`pinned upstream framework license hash differs: ${framework.name}`);
  }
  // CC0 notices accompanying fixture files are not replaced by the project code
  // license. Preserve exact copies when Vite publishes those public assets.
  for (const name of ['assets/LICENSE.txt', 'assets/avatars/LICENSE.txt', 'assets/textures/LICENSE.txt']) {
    matched(`public/${name}`, `dist/${name}`, packedFile(`dist/${name}`));
  }
  return { passed: true, app, version: sourcePackage.version, dependencies, frameworkNotices: FRAMEWORK_NOTICES, omnibusNotices: [SQUIRREL_OMNIBUS_NOTICE], matchedNotices: checks,
    coverage: 'Six renderer dependencies, Electron distribution notices, pinned Mantle/ReactiveObjC framework notices, project notices and original public-asset notices. ws is development preview-only.',
    limits: 'Notice/locked-package verification only; does not attest Electron binary identity, copyright ownership, legal clearance, signing or notarization.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) fail('Usage: node scripts/verify-release-notices.mjs release/VERSION/mac-arm64/Wayfarer.app');
    console.log(JSON.stringify(verifyReleaseNotices({ appPath: process.argv[2], root: dirname(dirname(fileURLToPath(import.meta.url))) }), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
