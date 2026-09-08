// Read-only checkpoint verification; never launches or signs the target app.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';
import { verifyReleaseNotices } from './verify-release-notices.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.argv.length !== 4) throw new Error('Usage: node scripts/verify-mac-package.mjs release/VERSION/mac-arm64/Wayfarer.app VERSION');
const app = resolve(root, process.argv[2]), expected = process.argv[3];
if (!app.startsWith(join(root, 'release') + '/') || !app.endsWith('/Wayfarer.app')) throw new Error('Choose a Wayfarer.app inside this project release directory.');
const archive = join(app, 'Contents/Resources/app.asar');
const plist = join(app, 'Contents/Info.plist');
const version = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
const packed = JSON.parse(extractFile(archive, 'package.json').toString());
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if ([version, packed.version, source.version].some(value => value !== expected)) throw new Error('Source, archive or bundle version mismatch.');
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
const executable = execFileSync('/usr/bin/file', [join(app, 'Contents/MacOS/Wayfarer')], { encoding: 'utf8' }).trim();
if (!executable.includes('Mach-O 64-bit executable arm64')) throw new Error('Expected the native arm64 executable.');
const entries = listPackage(archive).map(value => value.replace(/^\//, ''));
const excluded = new Set(['node_modules', '.runtime', 'vendor', 'scripts', 'tests', 'artifacts']);
if (entries.some(value => excluded.has(value.split('/')[0]) || value.split('/')[0].startsWith('.env'))) throw new Error('A development/private root was shipped in the archive.');
const files = [];
function walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
}
walk(join(root, 'dist')); walk(join(root, 'dist-electron'));
for (const path of files) {
  const name = relative(root, path).split('\\').join('/');
  if (!readFileSync(path).equals(extractFile(archive, name))) throw new Error(`Archive differs from the current build: ${name}`);
}
const bytes = readFileSync(archive);
const notices = verifyReleaseNotices({ appPath: app, root });
console.log(JSON.stringify({ passed: true, timestamp: new Date().toISOString(), app, version, architecture: 'arm64', signature: 'verified; notarization not assessed', currentBuildFilesMatched: files.length, privateRootsExcluded: true, notices, archiveBytes: bytes.length, archiveSha256: createHash('sha256').update(bytes).digest('hex') }, null, 2));
