import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
let Resvg;
try { ({ Resvg } = require('@resvg/resvg-js')); }
catch {
  // The initial packaging pass installs its helper in an isolated development folder.
  try { ({ Resvg } = require(join(root, '.runtime', 'icon-tools', 'node_modules', '@resvg', 'resvg-js'))); }
  catch { throw new Error('Install the icon build dependency with npm install --save-dev @resvg/resvg-js'); }
}
const build = join(root, 'build');
const iconset = join(root, '.runtime', 'icon-tools', 'Wayfarer.iconset');
await mkdir(iconset, { recursive: true });
const svg = await readFile(join(build, 'icon.svg'), 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const pngs = new Map();
for (const size of sizes) {
  const renderer = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  pngs.set(size, Buffer.from(renderer.render().asPng()));
}
await writeFile(join(build, 'icon.png'), pngs.get(1024));
const appleSizes = [16, 32, 128, 256, 512];
for (const size of appleSizes) {
  await writeFile(join(iconset, `icon_${size}x${size}.png`), pngs.get(size));
  await writeFile(join(iconset, `icon_${size}x${size}@2x.png`), pngs.get(size * 2));
}

// Windows Vista and later support PNG-compressed image entries in standard ICO files.
// Keep each entry separately sized for crisp Explorer, taskbar and installer rendering.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6 + icoSizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);
let offset = header.length;
const entries = icoSizes.map((size, index) => {
  const data = pngs.get(size), entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(data.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += data.length;
  return data;
});
await writeFile(join(build, 'icon.ico'), Buffer.concat([header, ...entries]));

if (process.platform === 'darwin') {
  const result = spawnSync('/usr/bin/iconutil', ['--convert', 'icns', '--output', join(build, 'icon.icns'), iconset], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('macOS iconutil failed');
  console.log('Built build/icon.png, build/icon.ico and build/icon.icns from original build/icon.svg.');
} else {
  console.log('Built build/icon.png and build/icon.ico. Rebuild build/icon.icns on macOS with iconutil.');
}
