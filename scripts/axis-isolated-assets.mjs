/** Private copied-asset server, spawned only by axis-isolated.mjs. */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertIsolatedDirectory, validateIsolatedPorts } from './axis-isolated.mjs';

export function assetNameFromRequest(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\?#\x00-\x1f\x7f]/.test(value)) return null;
  let name; try { name = decodeURIComponent(value.slice(1)); } catch { return null; }
  return /^[a-z0-9][a-z0-9_./-]*$/i.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..') ? name : null;
}
export function loadIsolatedAssets(manifestPath) {
  const directory = assertIsolatedDirectory(resolve(manifestPath, '..'));
  if (manifestPath !== join(directory, 'manifest.json') || lstatSync(manifestPath).isSymbolicLink() || lstatSync(manifestPath).size > 128_000) throw new Error('Invalid isolated asset manifest.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); validateIsolatedPorts(manifest.ports);
  if (manifest.schema !== 1 || manifest.directory !== directory || !manifest.assets || Object.keys(manifest.assets).length > 64) throw new Error('Invalid asset manifest content.');
  const files = new Map(); let total = 0;
  for (const [name, hash] of Object.entries(manifest.assets)) {
    if (assetNameFromRequest('/' + name) !== name || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid original asset entry.');
    const path = join(directory, 'assets', name);
    if (realpathSync(path) !== path || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || lstatSync(path).size > 1_000_000) throw new Error('Fixture assets must be small regular files without symlink ancestors.');
    const bytes = readFileSync(path); total += bytes.length;
    if (total > 10_000_000 || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Copied fixture asset hash or budget mismatch.');
    files.set(name, bytes);
  }
  return { directory, port: manifest.ports.assets, files };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv[2]; if (!argument?.startsWith('--manifest=') || process.argv.length !== 3) throw new Error('A single private manifest path is required.');
  const { port, files } = loadIsolatedAssets(argument.slice('--manifest='.length));
  const mime = { '.rwx': 'text/plain', '.txt': 'text/plain', '.dat': 'text/plain', '.json': 'application/json', '.zip': 'application/zip', '.png': 'image/png', '.seq': 'application/octet-stream' };
  const server = createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const name = assetNameFromRequest(request.url), bytes = name && files.get(name);
    if (!bytes) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': mime[extname(name)] || 'application/octet-stream', 'Content-Length': bytes.length, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  server.maxConnections = 16; server.requestTimeout = 5000; server.headersTimeout = 5000;
  server.listen({ host: '127.0.0.1', port, exclusive: true }, () => console.log(`ISOLATED_ASSETS_READY 127.0.0.1:${port}`));
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
