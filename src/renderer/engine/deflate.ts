const WINDOW = 32_768;
const MAX_DEFLATE_BLOCKS = 65_536;

function fail(message: string): never {
  throw new Error(`DEFLATE: ${message}`);
}

class Bits {
  position = 0;
  constructor(readonly source: Uint8Array) {}
  read(count: number): number {
    if (this.position + count > this.source.length * 8)
      fail("truncated DEFLATE stream");
    let value = 0;
    for (let i = 0; i < count; i++, this.position++) {
      value |=
        ((this.source[this.position >>> 3] >>> (this.position & 7)) & 1) << i;
    }
    return value;
  }
  align(): void {
    this.position = Math.ceil(this.position / 8) * 8;
  }
}

type Tree = { codes: Map<number, number>[]; maximum: number };

/** Canonical RFC 1951 trees; do not allocate a table indexed by attacker codes. */
function tree(
  lengths: readonly number[],
  kind: "lengths" | "literals" | "distances",
): Tree {
  const counts = new Uint16Array(16);
  let maximum = 0;
  for (const length of lengths) {
    if (length > 15 || length < 0) fail("invalid Huffman code length");
    if (length) {
      counts[length]++;
      maximum = Math.max(maximum, length);
    }
  }
  let unused = 1;
  for (let bits = 1; bits <= 15; bits++) {
    unused = unused * 2 - counts[bits];
    if (unused < 0) fail("oversubscribed Huffman tree");
  }
  // RFC 1951 permits an unused distance alphabet and single one-bit symbols.
  if (!maximum && kind !== "distances") fail("empty Huffman tree");
  if (maximum && unused && (kind === "lengths" || maximum !== 1))
    fail("incomplete Huffman tree");
  const next = new Uint16Array(16);
  let code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + counts[bits - 1]) * 2;
    next[bits] = code;
  }
  const codes = Array.from(
    { length: maximum + 1 },
    () => new Map<number, number>(),
  );
  lengths.forEach((length, symbol) => {
    if (length) codes[length].set(next[length]++, symbol);
  });
  return { codes, maximum };
}

function symbol(bits: Bits, alphabet: Tree): number {
  let code = 0;
  for (let length = 1; length <= alphabet.maximum; length++) {
    // Huffman codes, unlike other DEFLATE fields, travel most-significant bit first.
    code = code * 2 + bits.read(1);
    const value = alphabet.codes[length].get(code);
    if (value !== undefined) return value;
  }
  return fail("invalid Huffman symbol");
}

const FIXED_LITERALS = tree(
  Array.from({ length: 288 }, (_, n) =>
    n < 144 ? 8 : n < 256 ? 9 : n < 280 ? 7 : 8,
  ),
  "literals",
);
const FIXED_DISTANCES = tree(Array<number>(32).fill(5), "distances");
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];
// Kept explicit in wire order (RFC 1951 section 3.2.7).
const DYNAMIC_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

function dynamicTrees(bits: Bits): [Tree, Tree] {
  const literals = bits.read(5) + 257,
    distances = bits.read(5) + 1,
    codeCount = bits.read(4) + 4;
  if (literals > 286) fail("reserved literal alphabet size");
  const codeLengths = Array<number>(19).fill(0);
  for (let i = 0; i < codeCount; i++)
    codeLengths[DYNAMIC_ORDER[i]] = bits.read(3);
  const alphabet = tree(codeLengths, "lengths");
  const lengths: number[] = [];
  const total = literals + distances;
  while (lengths.length < total) {
    const value = symbol(bits, alphabet);
    if (value < 16) {
      lengths.push(value);
      continue;
    }
    let repeat: number,
      length = 0;
    if (value === 16) {
      if (!lengths.length) fail("repeat code has no previous length");
      repeat = bits.read(2) + 3;
      length = lengths[lengths.length - 1];
    } else if (value === 17) repeat = bits.read(3) + 3;
    else repeat = bits.read(7) + 11;
    if (lengths.length + repeat > total)
      fail("Huffman repeat exceeds alphabet");
    for (let i = 0; i < repeat; i++) lengths.push(length);
  }
  if (!lengths[256]) fail("missing DEFLATE end-of-block code");
  return [
    tree(lengths.slice(0, literals), "literals"),
    tree(lengths.slice(literals), "distances"),
  ];
}

/** Validate before fflate: its fixed output buffer silently truncates overflow and
 * its public API does not expose stream consumption or validate stored NLEN. */
export function validateDeflate(
  source: Uint8Array,
  expected: number,
  history: number,
  budget: { blocks: number },
): void {
  const bits = new Bits(source);
  let produced = 0,
    final = 0;
  const add = (count: number) => {
    produced += count;
    if (produced > expected)
      fail("DEFLATE expansion exceeds declared chunk size");
  };
  do {
    if (++budget.blocks > MAX_DEFLATE_BLOCKS)
      fail("DEFLATE block count exceeds limit");
    final = bits.read(1);
    const kind = bits.read(2);
    if (kind === 0) {
      bits.align();
      const length = bits.read(16),
        complement = bits.read(16);
      if ((length ^ complement) !== 0xffff)
        fail("invalid stored-block LEN/NLEN");
      if (bits.position + length * 8 > source.length * 8)
        fail("truncated stored DEFLATE block");
      add(length);
      bits.position += length * 8;
      continue;
    }
    if (kind === 3) fail("reserved DEFLATE block type");
    const [literals, distances] =
      kind === 1 ? [FIXED_LITERALS, FIXED_DISTANCES] : dynamicTrees(bits);
    while (true) {
      const literal = symbol(bits, literals);
      if (literal < 256) {
        add(1);
        continue;
      }
      if (literal === 256) break;
      if (literal > 285) fail("reserved DEFLATE length code");
      const index = literal - 257;
      const count = LENGTH_BASE[index] + bits.read(LENGTH_EXTRA[index]);
      const distanceCode = symbol(bits, distances);
      if (distanceCode > 29) fail("reserved DEFLATE distance code");
      const distance =
        DISTANCE_BASE[distanceCode] + bits.read(DISTANCE_EXTRA[distanceCode]);
      if (distance > Math.min(WINDOW, history + produced))
        fail("DEFLATE distance exceeds available 32 KiB history");
      add(count);
    }
  } while (!final);
  if (produced !== expected)
    fail("DEFLATE output does not match declared chunk size");
  // A final partial byte may contain arbitrary padding, but not another byte or stream.
  if (Math.ceil(bits.position / 8) !== source.length)
    fail("trailing bytes after DEFLATE stream");
}
