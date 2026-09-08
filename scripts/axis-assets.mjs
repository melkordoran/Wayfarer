import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { root } from './axis-common.mjs';

const assetRoot = join(root, 'public', 'assets');
const mime = { '.rwx': 'text/plain', '.txt': 'text/plain', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.zip': 'application/zip', '.seq': 'application/octet-stream' };
createServer((req, res) => {
  let path;
  try { path = resolve(assetRoot, '.' + decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)); }
  catch { res.writeHead(400).end(); return; }
  if ((path !== assetRoot && !path.startsWith(assetRoot + sep)) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404).end('Not found'); return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Content-Length', statSync(path).size);
  res.writeHead(200);
  if (req.method === 'HEAD') res.end(); else createReadStream(path).pipe(res);
}).listen(17400, '127.0.0.1', () => console.log(`Original Wayfarer assets at http://127.0.0.1:17400/ (${assetRoot})`));
