import { inflateSync } from "fflate";
import { validateDeflate } from "./deflate";

const BYTE_LIMIT = 30_000_000;
const ENTRY_LIMIT = 4096;

export interface BoundedZipEntry {
  name: string;
  originalSize: number;
  compressedSize: number;
  compression: number;
  crc32: number;
}

export interface BoundedZipOptions {
  maxBytes: number;
  maxEntries: number;
  filter?: (entry: BoundedZipEntry) => boolean;
}

function fail(message: string): never {
  throw new Error(`ZIP: ${message}`);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Strict, memory-only subset of ordinary single-disk ZIP. Selected files must
 * have exact DEFLATE expansion/consumption and CRC32; metadata is not evidence of
 * decoded length. Central/local records are checked even for unselected files. */
export function boundedUnzip(
  bytes: Uint8Array,
  options: BoundedZipOptions,
): Record<string, Uint8Array> {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 0 ||
    options.maxBytes > BYTE_LIMIT
  )
    fail("invalid expanded byte limit");
  if (
    !Number.isSafeInteger(options.maxEntries) ||
    options.maxEntries < 1 ||
    options.maxEntries > ENTRY_LIMIT
  )
    fail("invalid entry limit");
  if (bytes.length > BYTE_LIMIT) fail("input exceeds 30 MB limit");
  if (bytes.length < 22) fail("truncated end-of-central-directory record");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 22 - 65535);
    offset--
  ) {
    if (
      u32(offset) === 0x06054b50 &&
      offset + 22 + u16(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) fail("missing end record or trailing archive bytes");
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10))
    fail("split/multi-disk ZIP is unsupported");
  const count = u16(end + 10),
    centralSize = u32(end + 12),
    central = u32(end + 16);
  if (count === 0xffff || centralSize === 0xffffffff || central === 0xffffffff)
    fail("ZIP64 is unsupported");
  if (count > options.maxEntries)
    fail(`archive exceeds ${options.maxEntries} entries`);
  if (central + centralSize !== end || central > end)
    fail("invalid central-directory bounds");

  const extra = (start: number, length: number) => {
    const stop = start + length;
    for (let offset = start; offset < stop;) {
      if (offset + 4 > stop) fail("truncated extra-field header");
      const id = u16(offset),
        size = u16(offset + 2);
      if (id === 1) fail("ZIP64 extra fields are unsupported");
      if (id === 0x17 || id === 0x9901)
        fail("encrypted ZIP extra fields are unsupported");
      offset += 4;
      if (offset + size > stop) fail("truncated extra-field data");
      offset += size;
    }
  };
  const nameOf = (raw: Uint8Array, flags: number) => {
    if (!raw.length || raw.length > 4096) fail("Invalid path in archive");
    if (!(flags & 0x800) && raw.some((byte) => byte > 127))
      fail("non-UTF8 legacy ZIP filenames are unsupported");
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return fail("invalid UTF-8 ZIP filename");
    }
    const parts = name.split("/");
    if (
      !name ||
      name.length > 1024 ||
      /[\\:\u0000-\u001f\u007f]/.test(name) ||
      name.startsWith("/") ||
      parts.some(
        (part, index) =>
          part === "." ||
          part === ".." ||
          (!part && index !== parts.length - 1),
      )
    )
      fail("Invalid path in archive");
    return name;
  };

  type Entry = BoundedZipEntry & {
    start: number;
    end: number;
    data: number;
    selected: boolean;
  };
  const entries: Entry[] = [],
    names = new Set<string>();
  let cursor = central,
    selectedSize = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50)
      fail("truncated or invalid central-directory entry");
    const version = u16(cursor + 6),
      flags = u16(cursor + 8),
      compression = u16(cursor + 10);
    const checksum = u32(cursor + 16),
      compressedSize = u32(cursor + 20),
      originalSize = u32(cursor + 24);
    const nameSize = u16(cursor + 28),
      extraSize = u16(cursor + 30),
      commentSize = u16(cursor + 32),
      start = u32(cursor + 42);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end) fail("truncated central-directory variable fields");
    if (
      compressedSize === 0xffffffff ||
      originalSize === 0xffffffff ||
      start === 0xffffffff ||
      version >= 45
    )
      fail("ZIP64 or newer ZIP feature is unsupported");
    if (u16(cursor + 34)) fail("multi-disk ZIP entry is unsupported");
    if (flags & 0x41) fail("encrypted ZIP entries are unsupported");
    if (flags & ~0x80e) fail("unsupported ZIP flags");
    if (compression !== 0 && compression !== 8)
      fail("unsupported ZIP compression method");
    if (version > 20) fail("unsupported ZIP extraction version");
    if (compression === 0 && flags & 6)
      fail("invalid flags for stored ZIP entry");
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameSize),
      name = nameOf(rawName, flags);
    const folded = name.toLowerCase();
    if (names.has(folded)) fail("Duplicate filename in archive");
    names.add(folded);
    extra(cursor + 46 + nameSize, extraSize);

    if (start + 30 > central || u32(start) !== 0x04034b50)
      fail("invalid local-header offset or signature");
    const localNameSize = u16(start + 26),
      localExtraSize = u16(start + 28);
    const data = start + 30 + localNameSize + localExtraSize;
    if (data > central || data + compressedSize > central)
      fail("ZIP entry overlaps central directory or is truncated");
    if (
      u16(start + 4) !== version ||
      u16(start + 6) !== flags ||
      u16(start + 8) !== compression ||
      u16(start + 10) !== u16(cursor + 12) ||
      u16(start + 12) !== u16(cursor + 14)
    )
      fail("local/central header disagreement");
    const localName = bytes.subarray(start + 30, start + 30 + localNameSize);
    if (
      localName.length !== rawName.length ||
      localName.some((byte, i) => byte !== rawName[i])
    )
      fail("local/central filename disagreement");
    extra(start + 30 + localNameSize, localExtraSize);
    const localCrc = u32(start + 14),
      localCompressed = u32(start + 18),
      localOriginal = u32(start + 22);
    const descriptor = !!(flags & 8);
    const same = (local: number, advertised: number) =>
      local === advertised || (descriptor && local === 0);
    if (
      !same(localCrc, checksum) ||
      !same(localCompressed, compressedSize) ||
      !same(localOriginal, originalSize)
    )
      fail("local/central CRC or size disagreement");
    let entryEnd = data + compressedSize;
    if (descriptor) {
      const matches = (offset: number) =>
        offset + 12 <= central &&
        u32(offset) === checksum &&
        u32(offset + 4) === compressedSize &&
        u32(offset + 8) === originalSize;
      if (matches(entryEnd)) entryEnd += 12;
      else if (
        entryEnd + 16 <= central &&
        u32(entryEnd) === 0x08074b50 &&
        matches(entryEnd + 4)
      )
        entryEnd += 16;
      else fail("missing or inconsistent ZIP data descriptor");
    }
    const metadata = {
      name,
      originalSize,
      compressedSize,
      compression,
      crc32: checksum,
    };
    const selected = options.filter
      ? options.filter(Object.freeze(metadata))
      : true;
    if (selected && (selectedSize += originalSize) > options.maxBytes)
      fail("archive exceeds expanded size limit");
    entries.push({ ...metadata, start, end: entryEnd, data, selected });
    cursor = next;
  }
  if (cursor !== end) fail("central-directory size/count mismatch");
  // Refuse ambiguous self-extracting prefixes, unindexed local records, gaps and
  // overlaps, rather than interpreting the same source bytes as multiple files.
  const ordered = [...entries].sort((a, b) => a.start - b.start);
  let consumed = 0;
  for (const entry of ordered) {
    if (entry.start !== consumed)
      fail("overlapping ZIP entries or unindexed archive bytes");
    consumed = entry.end;
  }
  if (consumed !== central)
    fail("unindexed archive bytes before central directory");

  const result: Record<string, Uint8Array> = Object.create(null);
  const budget = { blocks: 0 };
  for (const entry of entries) {
    if (!entry.selected) continue;
    const compressed = bytes.subarray(
      entry.data,
      entry.data + entry.compressedSize,
    );
    let output: Uint8Array;
    if (entry.compression === 0) {
      if (entry.originalSize !== compressed.length)
        fail("stored entry length does not match declared expansion");
      output = compressed.slice();
    } else {
      validateDeflate(compressed, entry.originalSize, 0, budget);
      output = new Uint8Array(entry.originalSize);
      const decoded = inflateSync(compressed, { out: output });
      if (decoded.length !== entry.originalSize)
        fail("inflater output size mismatch");
    }
    if (crc32(output) !== entry.crc32) fail("CRC32 mismatch");
    result[entry.name] = output;
  }
  return result;
}
