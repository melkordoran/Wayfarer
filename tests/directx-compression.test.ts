import { constants, deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decompressDirectX } from "../src/renderer/engine/directx-compression";
import { parseDirectX } from "../src/renderer/engine/directx";
import { directXFixtureAssets } from "../scripts/directx-fixture-assets.mjs";

const utf8 = (text: string) => new TextEncoder().encode(text);
const concat = (...parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};
const word = (value: number) => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
};
const dword = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};
const chunk = (expanded: number, raw: Uint8Array) =>
  concat(word(expanded), word(raw.length + 2), utf8("CK"), raw);
const file = (
  bodySize: number,
  chunks: Uint8Array[],
  mode = "tzip",
  bits = 32,
  version = "0303",
) =>
  concat(
    utf8(`xof ${version}${mode}00${bits}`),
    dword(bodySize + 16),
    ...chunks,
  );

/** Original test envelope writer; node:zlib encodes RFC 1951 independently from
 * the production fflate decoder. No third-party X geometry is distributed. */
function compress(
  input: Uint8Array,
  options: {
    level?: number;
    strategy?: number;
    chunkSize?: number;
    history?: boolean;
  } = {},
) {
  const body = input.subarray(16),
    chunks: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < body.length;
    offset += options.chunkSize ?? 32768
  ) {
    const data = body.subarray(offset, offset + (options.chunkSize ?? 32768));
    const raw = deflateRawSync(data, {
      level: options.level ?? 6,
      strategy: options.strategy,
      dictionary:
        options.history === false
          ? undefined
          : body.subarray(Math.max(0, offset - 32768), offset),
    });
    chunks.push(chunk(data.length, raw));
  }
  const original = new TextDecoder().decode(input.subarray(0, 16));
  return file(
    body.length,
    chunks,
    original.slice(8, 12) === "txt " ? "tzip" : "bzip",
    Number(original.slice(12)),
    original.slice(4, 8),
  );
}

class Writer {
  bytes: number[] = [];
  position = 0;
  write(value: number, count: number) {
    for (let i = 0; i < count; i++, this.position++) {
      const index = this.position >>> 3;
      this.bytes[index] =
        (this.bytes[index] ?? 0) | (((value >>> i) & 1) << (this.position & 7));
    }
    return this;
  }
  code(value: number, count: number) {
    for (let i = count - 1; i >= 0; i--) this.write((value >>> i) & 1, 1);
    return this;
  }
  fixed(value: number) {
    return value <= 143
      ? this.code(48 + value, 8)
      : value <= 255
        ? this.code(400 + value - 144, 9)
        : value <= 279
          ? this.code(value - 256, 7)
          : this.code(192 + value - 280, 8);
  }
  finish() {
    return Uint8Array.from(this.bytes);
  }
}

// Dynamic tree fixture alphabet: code lengths 0 -> 0, 1 -> 10, 18 -> 11.
function dynamicPrefix() {
  const writer = new Writer()
    .write(1, 1)
    .write(2, 2)
    .write(0, 5)
    .write(0, 5)
    .write(14, 4);
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1];
  for (const value of order)
    writer.write(value === 0 ? 1 : value === 1 || value === 18 ? 2 : 0, 3);
  return writer;
}

function dynamicLiteralLengths(active: number[], distance = false) {
  const writer = dynamicPrefix();
  for (let value = 0; value < 258; value++) {
    if (active.includes(value) || (value === 257 && distance))
      writer.code(2, 2);
    else writer.write(0, 1);
  }
  return writer;
}

const triangle = utf8(
  "xof 0303txt 0032\nMesh Original {3;0;0;0;,1;0;0;,0;1;0;;1;3;0,1,2;;}",
);

describe("bounded DirectX internal MSZIP envelopes", () => {
  it("returns uncompressed bytes by identity and does not mutate compressed views", () => {
    expect(decompressDirectX(triangle)).toBe(triangle);
    const unrelated = utf8("ModelBegin");
    expect(decompressDirectX(unrelated)).toBe(unrelated);
    const packed = compress(triangle),
      padded = concat(new Uint8Array(7), packed, new Uint8Array(11));
    const before = padded.slice();
    expect(decompressDirectX(padded.subarray(7, -11))).toEqual(triangle);
    expect(padded).toEqual(before);
  });

  it.each([0, 1, 6, 9])(
    "decodes independently compressed text at zlib level %i",
    (level) => {
      expect(decompressDirectX(compress(triangle, { level }))).toEqual(
        triangle,
      );
    },
  );

  it.each(["0302", "0303"])(
    "preserves %s and both float-width headers",
    (version) => {
      for (const bits of [32, 64]) {
        const input = utf8(
          `xof ${version}txt 00${bits}\nMesh Original {3;0;0;0;,1;0;0;,0;1;0;;1;3;0,1,2;;}`,
        );
        expect(decompressDirectX(compress(input))).toEqual(input);
      }
    },
  );

  it("preserves original binary32/64 geometry and raw parser results", () => {
    for (const bits of [32, 64]) {
      const original = directXFixtureAssets().get(
        `avatars/wf-x-voyager-binary${bits}.x`,
      )!;
      const reconstructed = decompressDirectX(compress(original));
      expect(reconstructed).toEqual(original);
      expect(parseDirectX(reconstructed)).toEqual(parseDirectX(original));
    }
  });

  it("handles dynamic Huffman blocks and multiple MSZIP history windows", () => {
    const body = utf8(
      "The original Wayfarer marker says welcome, explorer. abcdefghi 0123456789\n".repeat(
        1400,
      ),
    );
    const raw = deflateRawSync(body.subarray(0, 32768));
    expect((raw[0] >>> 1) & 3).toBe(2);
    const original = concat(utf8("xof 0303txt 0032"), body);
    expect(decompressDirectX(compress(original))).toEqual(original);
  });

  it("retains cumulative history across short chunks, excluding the X header", () => {
    let seed = 731;
    const first = Uint8Array.from({ length: 32768 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 24;
    });
    const second = utf8("A second small block.");
    const third = first.subarray(1000, 6000);
    const history = concat(first, second).subarray(second.length);
    const thirdCompressed = deflateRawSync(third, { dictionary: history });
    expect(() => inflateRawSync(thirdCompressed)).toThrow();
    expect(thirdCompressed.length).toBeLessThan(100);
    const packed = file(
      first.length + second.length + third.length,
      [
        chunk(first.length, deflateRawSync(first)),
        chunk(second.length, deflateRawSync(second, { dictionary: first })),
        chunk(third.length, thirdCompressed),
      ],
      "bzip",
    );
    expect(decompressDirectX(packed)).toEqual(
      concat(utf8("xof 0303bin 0032"), first, second, third),
    );
  });

  it("accepts a distance of exactly 32768 and overlapping copies", () => {
    const first = Uint8Array.from({ length: 32768 }, (_, i) => i & 255);
    // Final fixed block: length 3 / distance 32768; then length 258 / distance 1.
    const raw = new Writer()
      .write(1, 1)
      .write(1, 2)
      .fixed(257)
      .code(29, 5)
      .write(8191, 13)
      .fixed(285)
      .code(0, 5)
      .fixed(256)
      .finish();
    const expected = concat(first.subarray(0, 3), new Uint8Array(258).fill(2));
    const packed = file(
      first.length + expected.length,
      [chunk(first.length, deflateRawSync(first)), chunk(expected.length, raw)],
      "bzip",
    );
    expect(decompressDirectX(packed).subarray(16 + first.length)).toEqual(
      expected,
    );
  });

  it("permits final bit padding but no extra bytes", () => {
    const raw = new Writer()
      .write(1, 1)
      .write(1, 2)
      .fixed(65)
      .fixed(256)
      .finish();
    raw[raw.length - 1] |= 0xfc;
    expect(decompressDirectX(file(1, [chunk(1, raw)])).subarray(16)).toEqual(
      utf8("A"),
    );
  });

  it("enforces lower caller limits against input and reconstructed bytes", () => {
    const packed = compress(triangle);
    expect(decompressDirectX(packed, triangle.length)).toEqual(triangle);
    expect(() => decompressDirectX(packed, triangle.length - 1)).toThrow(
      /expanded.*limit/,
    );
    expect(() => decompressDirectX(triangle, triangle.length - 1)).toThrow(
      /input exceeds/,
    );
    for (const limit of [NaN, Infinity, 15, 30_000_001, 100.5])
      expect(() => decompressDirectX(packed, limit)).toThrow(
        /invalid byte limit/,
      );
    expect(() => decompressDirectX(file(16_000_000, []), 16_000_000)).toThrow(
      /expanded.*limit/,
    );
  });

  it("validates global size limits without allocating declared output", () => {
    expect(() => decompressDirectX(new Uint8Array(30_000_001))).toThrow(
      /30 MB/,
    );
    for (const size of [0, 16, 30_000_001, 0xffffffff]) {
      const packed = concat(utf8("xof 0303tzip0032"), dword(size));
      expect(() => decompressDirectX(packed)).toThrow(/expanded/);
    }
  });

  it.each([
    "xof 0400tzip0032",
    "xof 0303tzip0128",
    "xof 0303zzzz0032",
    "xof 0303cmp 0032",
  ])("rejects unsupported header %s", (header) => {
    expect(() => decompressDirectX(utf8(header))).toThrow(/header|cmp/);
  });

  it("rejects every truncated prefix of valid compressed input", () => {
    const packed = compress(triangle);
    for (let end = 4; end < packed.length; end++)
      expect(() => decompressDirectX(packed.subarray(0, end))).toThrow();
  });

  it.each([
    ["zero output", 0, 5],
    ["oversize output", 32769, 5],
    ["short input", 1, 3],
    ["oversize input", 1, 32781],
  ])("rejects %s chunk lengths", (_name, expanded, compressed) => {
    const bytes = concat(
      utf8("xof 0303tzip0032"),
      dword(32785),
      word(expanded as number),
      word(compressed as number),
      utf8("CK"),
      new Uint8Array(3),
    );
    expect(() => decompressDirectX(bytes)).toThrow(/chunk.*size|chunk output/);
  });

  it("rejects corrupt signatures, over/under-declared totals, trailers and appended chunks", () => {
    const packed = compress(triangle);
    const signature = packed.slice();
    signature[24] = 0;
    expect(() => decompressDirectX(signature)).toThrow(/CK/);
    const under = packed.slice();
    new DataView(under.buffer).setUint32(16, triangle.length - 1, true);
    expect(() => decompressDirectX(under)).toThrow(/exceed/);
    const over = packed.slice();
    new DataView(over.buffer).setUint32(16, triangle.length + 1, true);
    expect(() => decompressDirectX(over)).toThrow(/do not match/);
    expect(() => decompressDirectX(concat(packed, new Uint8Array(1)))).toThrow(
      /truncated.*header/,
    );
    expect(() =>
      decompressDirectX(concat(packed, chunk(1, deflateRawSync(utf8("X"))))),
    ).toThrow(/exceed/);
  });

  it("rejects under/over-expansion rather than trusting fflate output truncation", () => {
    const payload = deflateRawSync(new Uint8Array(32768).fill(65));
    expect(() => decompressDirectX(file(1, [chunk(1, payload)]))).toThrow(
      /expansion exceeds/,
    );
    expect(() =>
      decompressDirectX(file(2, [chunk(2, deflateRawSync(utf8("A")))])),
    ).toThrow(/output does not match/);
  });

  it("rejects malformed stored LEN/NLEN and unsupported shortened stored blocks", () => {
    const stored = Uint8Array.of(1, 1, 0, 254, 255, 65);
    expect(decompressDirectX(file(1, [chunk(1, stored)])).subarray(16)).toEqual(
      utf8("A"),
    );
    const corrupt = stored.slice();
    corrupt[3] = 0;
    expect(() => decompressDirectX(file(1, [chunk(1, corrupt)]))).toThrow(
      /LEN\/NLEN/,
    );
    expect(() =>
      decompressDirectX(file(1, [chunk(1, Uint8Array.of(1, 1, 0, 65))])),
    ).toThrow(/truncated/);
  });

  it("rejects a missing final flag, reserved block, trailing junk and concatenated DEFLATE", () => {
    const raw = deflateRawSync(utf8("A"), { strategy: constants.Z_FIXED });
    const unfinished = Uint8Array.from(raw);
    unfinished[0] &= 0xfe;
    expect(() => decompressDirectX(file(1, [chunk(1, unfinished)]))).toThrow();
    expect(() =>
      decompressDirectX(file(1, [chunk(1, Uint8Array.of(7, 0))])),
    ).toThrow(/reserved.*block/);
    expect(() =>
      decompressDirectX(file(1, [chunk(1, concat(raw, Uint8Array.of(0)))])),
    ).toThrow(/trailing/);
    expect(() =>
      decompressDirectX(file(1, [chunk(1, concat(raw, raw))])),
    ).toThrow(/trailing/);
  });

  it("rejects reserved length/distance codes and references before dictionary history", () => {
    const reservedLength = new Writer()
      .write(1, 1)
      .write(1, 2)
      .fixed(286)
      .fixed(256)
      .finish();
    const reservedDistance = new Writer()
      .write(1, 1)
      .write(1, 2)
      .fixed(257)
      .code(30, 5)
      .fixed(256)
      .finish();
    const missingHistory = new Writer()
      .write(1, 1)
      .write(1, 2)
      .fixed(257)
      .code(0, 5)
      .fixed(256)
      .finish();
    expect(() =>
      decompressDirectX(file(3, [chunk(3, reservedLength)])),
    ).toThrow(/reserved.*length/);
    expect(() =>
      decompressDirectX(file(3, [chunk(3, reservedDistance)])),
    ).toThrow(/reserved.*distance/);
    expect(() =>
      decompressDirectX(file(3, [chunk(3, missingHistory)])),
    ).toThrow(/history/);
  });

  it("rejects invalid dynamic alphabet sizes and oversubscribed/incomplete code trees", () => {
    const invalidCount = new Writer()
      .write(1, 1)
      .write(2, 2)
      .write(30, 5)
      .write(0, 5)
      .write(0, 4)
      .finish();
    expect(() => decompressDirectX(file(1, [chunk(1, invalidCount)]))).toThrow(
      /alphabet size/,
    );
    for (const length of [1, 3]) {
      const raw = new Writer()
        .write(1, 1)
        .write(2, 2)
        .write(0, 5)
        .write(0, 5)
        .write(0, 4);
      for (let i = 0; i < 4; i++) raw.write(length, 3);
      expect(() =>
        decompressDirectX(file(1, [chunk(1, raw.finish())])),
      ).toThrow(/Huffman tree/);
    }
  });

  it("accepts a literal-only dynamic block with an unused distance alphabet", () => {
    const raw = dynamicLiteralLengths([65, 256])
      .write(0, 1)
      .write(1, 1)
      .finish();
    expect(inflateRawSync(raw)).toEqual(Buffer.from("A"));
    expect(decompressDirectX(file(1, [chunk(1, raw)])).subarray(16)).toEqual(
      utf8("A"),
    );
  });

  it("rejects missing end markers, oversubscribed literals and illegal dynamic repeats", () => {
    expect(() =>
      decompressDirectX(
        file(1, [chunk(1, dynamicLiteralLengths([65]).finish())]),
      ),
    ).toThrow(/end-of-block/);
    expect(() =>
      decompressDirectX(
        file(1, [chunk(1, dynamicLiteralLengths([65, 66, 256]).finish())]),
      ),
    ).toThrow(/oversubscribed/);
    const overflow = dynamicPrefix()
      .code(3, 2)
      .write(127, 7)
      .code(3, 2)
      .write(127, 7)
      .finish();
    expect(() => decompressDirectX(file(1, [chunk(1, overflow)]))).toThrow(
      /repeat exceeds/,
    );
    const noPrevious = new Writer()
      .write(1, 1)
      .write(2, 2)
      .write(0, 5)
      .write(0, 5)
      .write(0, 4)
      .write(1, 3)
      .write(0, 3)
      .write(0, 3)
      .write(1, 3)
      .code(1, 1)
      .write(0, 2)
      .finish();
    expect(() => decompressDirectX(file(1, [chunk(1, noPrevious)]))).toThrow(
      /no previous/,
    );
  });

  it("bounds chunk count and aggregate DEFLATE-block work even with tiny expansion", () => {
    const one = chunk(1, deflateRawSync(utf8("A")));
    expect(() =>
      decompressDirectX(file(4097, Array<Uint8Array>(4097).fill(one))),
    ).toThrow(/chunk count/);
    const raw = new Writer();
    for (let i = 0; i < 7000; i++) raw.write(0, 1).write(1, 2).fixed(256);
    raw.write(1, 1).write(1, 2).fixed(65).fixed(256);
    const block = chunk(1, raw.finish());
    expect(() =>
      decompressDirectX(file(10, Array<Uint8Array>(10).fill(block))),
    ).toThrow(/DEFLATE block count/);
  });

  it("matches independent output across deterministic data and compressor strategies", () => {
    let seed = 9141;
    for (let run = 0; run < 32; run++) {
      const body = Uint8Array.from({ length: 300 + run * 1331 }, (_, i) => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return run % 3 === 0
          ? seed >>> 24
          : run % 3 === 1
            ? i % 19
            : (seed >>> 24) % 5;
      });
      const original = concat(utf8(`xof 0303bin 00${run % 2 ? 64 : 32}`), body);
      expect(
        decompressDirectX(
          compress(original, {
            level: run % 10,
            strategy: run % 4 ? undefined : constants.Z_FIXED,
          }),
        ),
      ).toEqual(original);
    }
  });
});
