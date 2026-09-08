import { deflateSync, inflateSync } from 'node:zlib';
import { P } from './constants';

/** Axis packet format facts, independently implemented from the public Platform
 * PacketReader/PacketBuilder contract. Strings include NUL; numbers are LE;
 * v4 sizes encode the low 16-bit word first, each word in BE. */
export interface Field { id: number; type: number; data: Buffer }
export interface Packet { type: number; version: number; flags: number; fields: Field[] }
export const MAX_FRAME = 1024 * 1024;
export const MAX_INFLATED = 4 * 1024 * 1024;
export function i32(id: number, value: number): Field {
  if (!Number.isFinite(value)) throw new Error('Non-finite protocol integer');
  const data = Buffer.alloc(4); data.writeUInt32LE(Math.round(value) >>> 0);
  return { id, type: 2, data };
}
export function byte(id: number, value: number): Field { return { id, type: 1, data: Buffer.from([value]) }; }
export function str(id: number, value: string): Field {
  if (value.includes('\0')) throw new Error('Protocol text cannot contain NUL');
  return { id, type: 4, data: Buffer.from(value + '\0', 'utf8') };
}
export function blob(id: number, data: Uint8Array): Field { return { id, type: 5, data: Buffer.from(data) }; }
export function field(p: Packet, id: number): Field | undefined { return p.fields.find(f => f.id === id); }
export function num(p: Packet, id: number, fallback = 0): number {
  const f = field(p, id);
  if (!f) return fallback;
  if (f.type === 1 && f.data.length === 1) return f.data[0];
  if (f.type === 2 && f.data.length === 4) return f.data.readInt32LE();
  if (f.type === 3 && f.data.length === 4) return f.data.readFloatLE();
  return fallback;
}
export function string(p: Packet, id: number, fallback = ''): string {
  const f = field(p, id); return f ? f.data.toString('utf8').replace(/\0+$/, '') : fallback;
}
export function bytes(p: Packet, id: number): Buffer { return field(p, id)?.data ?? Buffer.alloc(0); }
function readSize(b: Buffer, at: number): number { return b.readUInt16BE(at) + b.readUInt16BE(at + 2) * 65536; }
function writeSize(b: Buffer, at: number, value: number): void {
  b.writeUInt16BE(value & 65535, at); b.writeUInt16BE(value >>> 16, at + 2);
}
export function frameLength(b: Buffer): number | undefined {
  if (b.length < 2) return;
  const initial = b.readUInt16BE(0), header = initial === 16 ? 16 : 10;
  if (b.length < header) return;
  const length = initial === 16 ? readSize(b, 12) : initial;
  if (length < header || length > MAX_FRAME) throw new Error(`Invalid Axis frame size: ${length}`);
  return length;
}
export function encode(type: number, fields: Field[] = [], version = 3, flags = 2): Buffer {
  if ([P.PublicKeyResponse, P.StreamKeyResponse, P.Attributes, P.Login].includes(type as never)) { version = 1; flags = 0; }
  if (fields.length > 1024) throw new Error('Too many packet fields');
  const h = version === 4 ? 16 : 10, vh = version === 4 ? 12 : 4;
  const body = fields.map(f => {
    if (f.id < 0 || f.id > 65535 || f.type < 1 || f.type > 5) throw new Error('Invalid field');
    if (version !== 4 && f.data.length > 4095) throw new Error('Field exceeds legacy packet limit');
    const out = Buffer.alloc(vh + f.data.length);
    if (version === 4) {
      out.writeUInt16BE(12); out.writeUInt16BE(f.type, 2); out.writeUInt16BE(f.id, 4);
      out.writeUInt16BE(65535, 6); writeSize(out, 8, f.data.length);
    } else { out.writeUInt16BE(f.id); out.writeUInt16BE((f.type << 12) | f.data.length, 2); }
    f.data.copy(out, vh); return out;
  });
  const data = Buffer.concat(body); return wrap(type, data, fields.length, version, flags, h);
}
function wrap(type: number, data: Buffer, count: number, version: number, flags: number, h = version === 4 ? 16 : 10): Buffer {
  const length = h + data.length;
  if (length > (version === 4 ? 393210 : 32767)) throw new Error('Axis packet exceeds send limit');
  if (version !== 4 && length === 16) throw new Error('Legacy 16-byte frame is ambiguous with the v4 marker');
  const out = Buffer.alloc(length);
  out.writeUInt16BE(version === 4 ? 16 : length); out.writeUInt16BE(version === 4 ? version : flags, 2);
  out.writeInt16BE(type, 4); out.writeUInt16BE(version === 4 ? flags : version, 6); out.writeUInt16BE(count, 8);
  if (version === 4) { out.writeUInt16BE(65535, 10); writeSize(out, 12, length); }
  data.copy(out, h); return out;
}
export function compressed(packets: Buffer[], version = 3): Buffer {
  return wrap(P.Compressed, deflateSync(Buffer.concat(packets)), 0, version, 0);
}
export function decode(frame: Buffer, depth = 0, budget = { remaining: MAX_INFLATED }): Packet[] {
  if (depth > 3) throw new Error('Excessive compressed packet nesting');
  const length = frameLength(frame);
  if (!length || length !== frame.length) throw new Error('Incomplete Axis frame');
  const v4 = frame.readUInt16BE(0) === 16, h = v4 ? 16 : 10;
  const p: Packet = { type: frame.readInt16BE(4), version: frame.readUInt16BE(v4 ? 2 : 6), flags: frame.readUInt16BE(v4 ? 6 : 2), fields: [] };
  if (p.type === P.Compressed) {
    if (budget.remaining <= 0) throw new Error('Compressed packet expansion budget exceeded');
    const body = inflateSync(frame.subarray(h), { maxOutputLength: budget.remaining }), packets: Packet[] = [];
    budget.remaining -= body.length;
    let pos = 0;
    while (pos < body.length) {
      const size = frameLength(body.subarray(pos));
      if (!size || size > body.length - pos) throw new Error('Truncated compressed subframe');
      packets.push(...decode(body.subarray(pos, pos + size), depth + 1, budget)); pos += size;
      if (packets.length > 8192) throw new Error('Excessive compressed packet count');
    }
    return packets;
  }
  const count = frame.readUInt16BE(8); if (count > 1024) throw new Error('Too many packet fields');
  let pos = h;
  for (let index = 0; index < count; index++) {
    const fh = v4 ? 12 : 4;
    if (frame.length - pos < fh) throw new Error('Truncated field header');
    const id = frame.readUInt16BE(pos + (v4 ? 4 : 0));
    const descriptor = frame.readUInt16BE(pos + 2), type = v4 ? descriptor : descriptor >>> 12;
    const size = v4 ? readSize(frame, pos + 8) : descriptor & 4095;
    if (v4 && frame.readUInt16BE(pos) !== 12) throw new Error('Invalid v4 field header');
    pos += fh;
    if (size > frame.length - pos) throw new Error('Truncated field payload');
    if ((type === 1 && size !== 1) || ((type === 2 || type === 3) && size !== 4)) throw new Error('Invalid numeric field length');
    if (type < 1 || type > 5) throw new Error('Unknown field type');
    p.fields.push({ id, type, data: Buffer.from(frame.subarray(pos, pos + size)) }); pos += size;
  }
  if (pos !== frame.length) throw new Error('Trailing packet bytes');
  return [p];
}
