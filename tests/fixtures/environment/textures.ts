import { zlibSync } from 'fflate';

/** Original 2x2 RGBA test pixels, CC0 1.0. An actual deterministic PNG, not
 * arbitrary bytes passed off as image evidence. No filesystem/network writes. */
export function originalEnvironmentPng(mask = false): Uint8Array {
  const concat = (...parts: Uint8Array[]) => {
    const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
  };
  const u32 = (value: number) => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value); return bytes; };
  const crc = (bytes: Uint8Array) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind: string, data: Uint8Array) => {
    const content = concat(new TextEncoder().encode(kind), data);
    return concat(u32(data.length), content, u32(crc(content)));
  };
  const header = concat(u32(2), u32(2), Uint8Array.from([8, 6, 0, 0, 0]));
  const rows = mask
    ? [0, 255, 255, 255, 255, 128, 128, 128, 255, 0, 128, 128, 128, 255, 255, 255, 255, 255]
    : [0, 216, 166, 96, 255, 91, 155, 159, 255, 0, 114, 151, 109, 255, 169, 115, 151, 255];
  return concat(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlibSync(Uint8Array.from(rows))), chunk('IEND', new Uint8Array()));
}
