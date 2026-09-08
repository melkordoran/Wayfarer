/** Read-only public-source gate. Never stages, modifies files, or accesses the
 * network. Default: Git-visible working-tree files. --staged: index blobs/modes,
 * including unchanged tracked files, independent of their working-tree bytes.
 * Findings deliberately omit matching values and source excerpts.
 *
 * One documented non-secret exception: the public throwaway localhost TLS key
 * in tests/protocol-tls.test.ts. Both its exact path and decoded PEM-block SHA256
 * must match. The certificate has only 127.0.0.1 as its SAN; it is not a server
 * deployment identity. New/changed keys require explicit independent review.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PUBLIC_TREE_LIMITS = Object.freeze({ files: 2000, fileBytes: 2 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 });
const roots = new Set(['.github', 'build', 'docs', 'public', 'scripts', 'src', 'tests']);
const rootFiles = new Set([
  '.gitignore', '.gitattributes', '.prettierignore', '.nvmrc', '.editorconfig',
  'README.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE', 'NOTICE.md',
  'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES', 'THIRD_PARTY_NOTICES.md',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'index.html',
]);
const privateDirectories = new Set(['.git', '.runtime', 'node_modules', 'vendor', 'release', 'dist', 'dist-electron', 'cache', '.cache', 'artifacts', 'coverage', 'logs', 'reports', 'screenshots', 'native-profile', 'backups']);
const fixtureKeyPath = 'tests/protocol-tls.test.ts';
const fixtureKeySha256 = '0e1370ffeefdf79a250e54e7392af3fb59184b9155a615cecdd6587e64e81627';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const tokenPattern = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{15,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g;
const homePattern = /(?:\/(?:Users|home)\/|[A-Za-z]:\\+Users\\+)([^\s/\\"'`<>]+)/g;
const syntheticHomeUsers = new Set(['example', 'example-user', 'user', 'username', 'runner', 'Shared']);
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

function safePath(path) {
  return path.replace(tokenPattern, '[redacted-token]').replace(homePattern, '[redacted-home]').replace(/[\x00-\x1f\x7f]/g, '?');
}
function pathProblem(path) {
  const parts = path.split('/');
  if (!path || /[\x00-\x1f\x7f\\]/.test(path) || parts.some(part => !part || part === '.' || part === '..')) return 'unsafe-path';
  if (parts.length === 1 ? !rootFiles.has(path) : !roots.has(parts[0])) return 'unexpected-root';
  if (parts.some(part => privateDirectories.has(part))) return 'private-artifact';
  const name = basename(path);
  if (/^\.env(?:\.|$)/i.test(name) || /^(?:\.npmrc|\.netrc|\.git-credentials|credentials(?:[-_.].*)?|secrets?(?:[-_.].*)?|appsettings\.(?:json|ya?ml)|WorldServer\.ya?ml|citizens\.json|licenses\.json|seeded\.json)$/i.test(name)) return 'private-artifact';
  if (/\.(?:log(?:\.\d+)?|map|db(?:-wal|-shm)?|sqlite3?|pem|key|p8|p12|pfx|jks|keystore|crt|cer|asar|dmg|exe|dll|so|dylib|tgz|tar|gz|bak|backup|mov|mp4)$/i.test(name) || /\.(?:pid|process)\.json$/i.test(name)) return 'private-artifact';
  if (/(?:screenshot|screen-capture|native-(?:ready|startup|stopped)|primary-before|ui-verification|integration-report)/i.test(name) && /\.(?:json|html|png|jpe?g|webp)$/i.test(name)) return 'private-artifact';
  if (/\.zip$/i.test(name) && !path.startsWith('public/assets/') && !path.startsWith('tests/fixtures/')) return 'private-artifact';
  return null;
}
function git(cwd, args, input, maxBuffer = 4 * 1024 * 1024) {
  const result = spawnSync('git', args, { cwd, input, maxBuffer, timeout: 15000 });
  if (result.error || result.status !== 0) throw new Error('Read-only Git inspection failed.');
  return result.stdout;
}
function addFinding(report, path, rule, line = 1) {
  const finding = { path: safePath(path), line, rule };
  if (!report.findings.some(old => old.path === finding.path && old.line === line && old.rule === rule)) report.findings.push(finding);
}
function scanContent(report, path, bytes) {
  // Also scan ASCII-compatible markers in binary fixtures; never print bytes.
  const text = bytes.toString('utf8');
  for (const match of text.matchAll(tokenPattern)) addFinding(report, path, 'secret-token', lineAt(text, match.index));
  for (const match of text.matchAll(/\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\s*[:=]\s*["']([^"'\r\n]{24,})["']/gi)) {
    if (!match[1].includes('${')) addFinding(report, path, 'secret-literal', lineAt(text, match.index));
  }
  for (const match of text.matchAll(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----/g)) {
    const end = '-----END ' + match[1] + '-----', endIndex = text.indexOf(end, match.index + match[0].length);
    const block = endIndex < 0 ? null : text.slice(match.index, endIndex + end.length).replace(/\\r\\n|\\n|\\r/g, '\n');
    const line = lineAt(text, match.index);
    if (path === fixtureKeyPath && block !== null && sha256(block) === fixtureKeySha256) report.exceptions.push({ path, line, rule: 'public-localhost-tls-key', sha256: fixtureKeySha256 });
    else addFinding(report, path, 'private-key', line);
  }
  for (const match of text.matchAll(/(?<!\d)(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(?!\d)/g)) {
    if (match[0].split('.').every(part => Number(part) <= 255)) addFinding(report, path, 'private-lan-address', lineAt(text, match.index));
  }
  for (const match of text.matchAll(/(?<![0-9a-f:])(?:f[cd][0-9a-f]{2}|fe80)(?::[0-9a-f]{0,4}){2,7}(?![0-9a-f:])/gi)) addFinding(report, path, 'private-lan-address', lineAt(text, match.index));
  for (const match of text.matchAll(homePattern)) {
    if (!syntheticHomeUsers.has(match[1])) addFinding(report, path, 'personal-home-path', lineAt(text, match.index));
  }
  if (path === 'package-lock.json') {
    let lock;
    try { lock = JSON.parse(text); } catch { addFinding(report, path, 'invalid-lockfile'); return; }
    if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) { addFinding(report, path, 'invalid-lockfile'); return; }
    for (const value of Object.values(lock.packages)) {
      if (!value || typeof value !== 'object' || value.resolved === undefined) continue;
      let valid = false;
      try { const url = new URL(value.resolved); valid = typeof value.resolved === 'string' && url.protocol === 'https:' && url.host === 'registry.npmjs.org' && !url.username && !url.password; } catch { /* Report below, without the URL. */ }
      if (!valid) addFinding(report, path, 'nonpublic-package-resolver', lineAt(text, Math.max(0, text.indexOf(JSON.stringify(value.resolved)))));
    }
  }
}

export function auditPublicTree({ cwd = process.cwd(), staged = false } = {}) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  const report = { passed: false, mode: staged ? 'index' : 'working-tree', files: 0, bytes: 0, findings: [], exceptions: [] };
  const indexed = new Map();
  for (const entry of git(root, ['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]{40,64}) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Unexpected Git index metadata.');
    const [, mode, oid, stage, path] = match;
    if (stage !== '0') addFinding(report, path, 'unmerged-index');
    if (!['100644', '100755'].includes(mode)) addFinding(report, path, mode === '120000' ? 'symlink' : 'nonregular-index-entry');
    indexed.set(path, { path, mode, oid });
  }
  const paths = staged ? [...indexed.keys()] : [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean))];
  paths.sort(); report.files = paths.length;
  if (paths.length > PUBLIC_TREE_LIMITS.files) { addFinding(report, '(tree)', 'file-count-limit'); return report; }
  const eligible = [];
  for (const path of paths) {
    const problem = pathProblem(path);
    if (problem) { addFinding(report, path, problem); continue; }
    if (staged) { const entry = indexed.get(path); if (['100644', '100755'].includes(entry.mode)) eligible.push(entry); continue; }
    let stat;
    try {
      let current = root;
      for (const part of path.split('/')) { current = join(current, part); stat = lstatSync(current); if (stat.isSymbolicLink()) break; }
      if (stat.isSymbolicLink()) { addFinding(report, path, 'symlink'); continue; }
      if (!stat.isFile()) { addFinding(report, path, 'nonregular-file'); continue; }
      report.bytes += stat.size;
      if (stat.size > PUBLIC_TREE_LIMITS.fileBytes) { addFinding(report, path, 'file-size-limit'); continue; }
      if (report.bytes > PUBLIC_TREE_LIMITS.totalBytes) { addFinding(report, '(tree)', 'total-size-limit'); break; }
      scanContent(report, path, readFileSync(join(root, path)));
    } catch { addFinding(report, path, 'unreadable-file'); }
  }
  if (staged && eligible.length) {
    const metadata = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], eligible.map(entry => entry.oid).join('\n') + '\n').toString('utf8').trim().split('\n');
    if (metadata.length !== eligible.length) throw new Error('Incomplete Git object metadata.');
    const selected = [];
    for (let i = 0; i < eligible.length; i++) {
      const entry = eligible[i], match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(metadata[i]);
      if (!match || match[1] !== entry.oid || !Number.isSafeInteger(Number(match[2]))) throw new Error('Unexpected Git object metadata.');
      const size = Number(match[2]); report.bytes += size;
      if (size > PUBLIC_TREE_LIMITS.fileBytes) { addFinding(report, entry.path, 'file-size-limit'); continue; }
      if (report.bytes > PUBLIC_TREE_LIMITS.totalBytes) { addFinding(report, '(tree)', 'total-size-limit'); break; }
      selected.push({ ...entry, size });
    }
    if (selected.length) {
      const output = git(root, ['cat-file', '--batch'], selected.map(entry => entry.oid).join('\n') + '\n', PUBLIC_TREE_LIMITS.totalBytes + 1024 * 1024);
      let offset = 0;
      for (const entry of selected) {
        const end = output.indexOf(10, offset), expected = entry.oid + ' blob ' + entry.size;
        if (end < 0 || output.subarray(offset, end).toString() !== expected || output[end + 1 + entry.size] !== 10) throw new Error('Unexpected Git object data.');
        scanContent(report, entry.path, output.subarray(end + 1, end + 1 + entry.size)); offset = end + 2 + entry.size;
      }
      if (offset !== output.length) throw new Error('Trailing Git object data.');
    }
  }
  report.passed = report.findings.length === 0;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some(argument => argument !== '--staged') || process.argv.slice(2).length > 1) throw new Error('Usage: node scripts/audit-public-tree.mjs [--staged]');
    const report = auditPublicTree({ staged: process.argv.includes('--staged') });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write((error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'Public-tree audit failed; no source values were printed.') + '\n'); process.exitCode = 2;
  }
}
