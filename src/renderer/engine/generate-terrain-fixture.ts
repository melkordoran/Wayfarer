/** Original procedural test textures. Generated PNG and ZIP assets are dedicated to CC0-1.0. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { zipSync, zlibSync } from 'fflate';

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, bytes: Uint8Array) {
  const out = new Uint8Array(bytes.length + 12), view = new DataView(out.buffer);
  view.setUint32(0, bytes.length); out.set(new TextEncoder().encode(type), 4); out.set(bytes, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, -4))); return out;
}
export function generateTerrainPng(index: number): Uint8Array {
  const width = 64, height = 64, data = new Uint8Array((width * 3 + 1) * height);
  const color = index === 0 ? [97, 129, 83] : index === 1 ? [161, 151, 125] : [144, 103, 78];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    const grain = ((x * 37 + y * 61 + (x * y) * 13) % 17) - 8;
    const wave = Math.sin(x / width * Math.PI * 8) * Math.cos(y / height * Math.PI * 6) * 3;
    const joint = index === 1 && (y % 32 < 2 || (x + (y < 32 ? 0 : 16)) % 32 < 2) ? -28 : 0;
    for (let c = 0; c < 3; c++) data[offset + c] = color[c] + grain + wave + joint;
  }
  const header = new Uint8Array(13), view = new DataView(header.buffer); view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 2;
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibSync(data)), chunk('IEND', new Uint8Array())];
  const output = new Uint8Array(chunks.reduce((length, bytes) => length + bytes.length, 0));
  let cursor = 0; for (const bytes of chunks) { output.set(bytes, cursor); cursor += bytes.length; }
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = fileURLToPath(new URL('../../../public/assets/textures/', import.meta.url));
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 3; index++) {
    const image = generateTerrainPng(index), filename = `terrain${index}.png`;
    if (index < 2) writeFileSync(resolve(directory, filename), image);
    else writeFileSync(resolve(directory, `terrain${index}.zip`), zipSync({ [filename]: image }));
  }
  console.log(`Generated original CC0 terrain fixtures in ${directory}`);
}
