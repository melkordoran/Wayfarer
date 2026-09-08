import { crc32, deflateRawSync } from "node:zlib";
import {
  gzipSync,
  strToU8,
  zipSync,
  Zip,
  ZipDeflate,
  ZipPassThrough,
} from "fflate";
import { describe, expect, it, vi } from "vitest";
import { boundedUnzip } from "../src/renderer/engine/zip";
import { decodeModelAsset, unpackAsset } from "../src/renderer/engine/assets";

const encode = strToU8;
const options = { maxBytes: 30_000_000, maxEntries: 1024 };
const concat = (...parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};
type Source = {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  descriptor?: "signed" | "unsigned";
  raw?: Uint8Array;
  size?: number;
  checksum?: number;
  flags?: number;
  extra?: Uint8Array;
};

/** Independent classic ZIP writer using Node zlib, not production ZIP code. */
function archive(sources: Source[], comment = "") {
  const locals: number[] = [],
    centrals: number[] = [],
    descriptors: number[] = [];
  const localParts: Uint8Array[] = [],
    centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const source of sources) {
    const name = encode(source.name),
      extra = source.extra ?? new Uint8Array(),
      method = source.method ?? 8;
    const raw =
      source.raw ?? (method === 8 ? deflateRawSync(source.data) : source.data);
    const size = source.size ?? source.data.length,
      checksum = source.checksum ?? crc32(source.data);
    const flags = source.flags ?? 0x800 | (source.descriptor ? 8 : 0);
    const local = new Uint8Array(30 + name.length + extra.length),
      view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, flags, true);
    view.setUint16(8, method, true);
    if (!source.descriptor) {
      view.setUint32(14, checksum, true);
      view.setUint32(18, raw.length, true);
      view.setUint32(22, size, true);
    }
    view.setUint16(26, name.length, true);
    view.setUint16(28, extra.length, true);
    local.set(name, 30);
    local.set(extra, 30 + name.length);
    const descriptor = new Uint8Array(
      source.descriptor ? (source.descriptor === "signed" ? 16 : 12) : 0,
    );
    if (source.descriptor) {
      const desc = new DataView(descriptor.buffer),
        start = source.descriptor === "signed" ? 4 : 0;
      if (start) desc.setUint32(0, 0x08074b50, true);
      desc.setUint32(start, checksum, true);
      desc.setUint32(start + 4, raw.length, true);
      desc.setUint32(start + 8, size, true);
    }
    const central = new Uint8Array(46 + name.length + extra.length),
      cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, raw.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    central.set(extra, 46 + name.length);
    locals.push(offset);
    descriptors.push(offset + local.length + raw.length);
    localParts.push(local, raw, descriptor);
    centralParts.push(central);
    offset += local.length + raw.length + descriptor.length;
  }
  let centralOffset = offset;
  for (const part of centralParts) {
    centrals.push(offset);
    offset += part.length;
  }
  const text = encode(comment),
    end = new Uint8Array(22 + text.length),
    ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, sources.length, true);
  ev.setUint16(10, sources.length, true);
  ev.setUint32(12, offset - centralOffset, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, text.length, true);
  end.set(text, 22);
  return {
    bytes: concat(...localParts, ...centralParts, end),
    locals,
    centrals,
    descriptors,
    end: offset,
  };
}

describe("strict bounded memory-only ZIP extraction", () => {
  it("accepts an independent streaming ZIP producer with deflated and stored descriptors", () => {
    const parts: Uint8Array[] = [];
    let finished = false;
    const zip = new Zip((error, data, final) => {
      if (error) throw error;
      parts.push(data);
      finished = final;
    });
    const deflated = new ZipDeflate("original.x"),
      stored = new ZipPassThrough("note.txt");
    zip.add(deflated);
    deflated.push(encode("first "), false);
    deflated.push(encode("second"), true);
    zip.add(stored);
    stored.push(encode("original note"), true);
    zip.end();
    expect(finished).toBe(true);
    expect(boundedUnzip(concat(...parts), options)).toEqual({
      "original.x": encode("first second"),
      "note.txt": encode("original note"),
    });
  });
  it.each([0, 8] as const)(
    "reads independent method %i archives with nested, empty and UTF-8 files",
    (method) => {
      const sources: Source[] = [
        {
          name: "nested/original.x",
          data: encode("original geometry"),
          method,
        },
        { name: "café.txt", data: encode("bonjour"), method },
        { name: "empty", data: new Uint8Array(), method },
      ];
      const packed = archive(sources, "Original research comment.");
      const decoded = boundedUnzip(packed.bytes, options);
      expect(Object.getPrototypeOf(decoded)).toBeNull();
      for (const entry of sources)
        expect(decoded[entry.name]).toEqual(entry.data);
      expect(Object.keys(decoded)).toHaveLength(3);
    },
  );

  it.each(["signed", "unsigned"] as const)(
    "reads %s descriptors and independently mixed chunks",
    (descriptor) => {
      const sources: Source[] = [
        { name: "one", data: encode("hello"), descriptor },
        {
          name: "two",
          data: new Uint8Array(1000).fill(42),
          descriptor,
          method: 0,
        },
        { name: "three", data: encode("world") },
      ];
      const packed = archive(sources);
      const decoded = boundedUnzip(packed.bytes, options);
      for (const entry of sources)
        expect(decoded[entry.name]).toEqual(entry.data);
    },
  );

  it("handles regular fflate ZIPs without mutating an offset input view", () => {
    const files = {
      "folder/": new Uint8Array(),
      "folder/hello.txt": encode("123456789"),
    };
    const packed = zipSync(files),
      padded = concat(new Uint8Array(3), packed, new Uint8Array(11)),
      before = padded.slice();
    expect(boundedUnzip(padded.subarray(3, -11), options)).toEqual(files);
    expect(padded).toEqual(before);
  });

  it("returns safe own properties even for prototype-like names", () => {
    const packed = archive([
      { name: "__proto__", data: encode("original") },
      { name: "constructor", data: encode("original") },
    ]);
    const result = boundedUnzip(packed.bytes, options);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.keys(result)).toEqual(["__proto__", "constructor"]);
  });

  it("filters metadata while counting every entry and only expanding selected contents", () => {
    const packed = archive([
      { name: "ignored", data: encode("x"), size: 0xffffffff - 1 },
      { name: "original.x", data: encode("ok") },
    ]);
    const filter = vi.fn((entry) => entry.name.endsWith(".x"));
    expect(
      boundedUnzip(packed.bytes, { maxBytes: 2, maxEntries: 2, filter })[
        "original.x"
      ],
    ).toEqual(encode("ok"));
    expect(filter).toHaveBeenCalledTimes(2);
    expect(filter.mock.calls[1][0]).toMatchObject({
      name: "original.x",
      originalSize: 2,
      compression: 8,
      crc32: crc32(encode("ok")),
    });
    expect(() =>
      boundedUnzip(packed.bytes, { maxBytes: 2, maxEntries: 1, filter }),
    ).toThrow(/entries/);
  });

  it("rejects a forged valid prefix despite matching forged size and prefix CRC metadata", () => {
    const prefix = encode(
      "AWSQ Version=1 Limbs=1 Duration=1000\npelvis frames=2\n0 0 0 1 0 0 0 0\n1000 0 0 1 20 0 0 0\n",
    );
    const original = concat(
      prefix,
      encode("UNPARSEABLE TRAILING BYTES ".repeat(4096)),
    );
    const packed = archive([
      {
        name: "probe.seq",
        data: original,
        size: prefix.length,
        checksum: crc32(prefix),
      },
    ]);
    expect(packed.bytes.length).toBeLessThan(600);
    expect(() => boundedUnzip(packed.bytes, options)).toThrow(
      /expansion exceeds/,
    );
  });

  it.each([0, 8] as const)(
    "verifies method %i CRC instead of trusting agreeing headers",
    (method) => {
      const packed = archive([
        { name: "original", data: encode("123456789"), method, checksum: 0 },
      ]);
      expect(() => boundedUnzip(packed.bytes, options)).toThrow(/CRC32/);
    },
  );

  it("rejects falsely oversized expansion, stored-length disagreement and missing DEFLATE", () => {
    expect(() =>
      boundedUnzip(
        archive([{ name: "a", data: encode("x"), size: 2 }]).bytes,
        options,
      ),
    ).toThrow(/output does not match/);
    expect(() =>
      boundedUnzip(
        archive([{ name: "a", data: encode("xy"), size: 1, method: 0 }]).bytes,
        options,
      ),
    ).toThrow(/stored entry length/);
    expect(() =>
      boundedUnzip(
        archive([{ name: "a", data: new Uint8Array(), raw: new Uint8Array() }])
          .bytes,
        options,
      ),
    ).toThrow(/truncated DEFLATE/);
  });

  it("rejects truncated payloads, appended DEFLATE streams and junk inside framing", () => {
    const data = encode("hello"),
      raw = deflateRawSync(data);
    for (const malformed of [
      raw.subarray(0, -1),
      concat(raw, raw),
      concat(raw, Uint8Array.of(0)),
    ]) {
      expect(() =>
        boundedUnzip(
          archive([{ name: "a", data, raw: malformed }]).bytes,
          options,
        ),
      ).toThrow(/truncated|trailing/);
    }
  });

  it("bounds selected expanded totals before allocation, even for individually small entries", () => {
    const packed = archive([
      { name: "a", data: encode("abc") },
      { name: "b", data: encode("def") },
    ]);
    expect(() =>
      boundedUnzip(packed.bytes, { ...options, maxBytes: 5 }),
    ).toThrow(/expanded size/);
    expect(() =>
      boundedUnzip(
        archive([{ name: "a", data: encode("abc"), size: 30_000_001 }]).bytes,
        options,
      ),
    ).toThrow(/expanded size/);
    expect(() => boundedUnzip(new Uint8Array(30_000_001), options)).toThrow(
      /30 MB/,
    );
  });

  it("checks central/local field agreement, including ignored entries", () => {
    const offsets = [4, 6, 8, 10, 12, 14, 18, 22, 30];
    for (const offset of offsets) {
      const packed = archive([{ name: "original", data: encode("source") }]);
      packed.bytes[offset] ^= 1;
      expect(() =>
        boundedUnzip(packed.bytes, { ...options, filter: () => false }),
      ).toThrow(/disagreement/);
    }
  });

  it.each(["signed", "unsigned"] as const)(
    "rejects missing, corrupt or nonzero inconsistent %s descriptors",
    (descriptor) => {
      const packed = archive([
        { name: "a", data: encode("original"), descriptor },
      ]);
      const bad = packed.bytes.slice();
      bad[packed.descriptors[0] + (descriptor === "signed" ? 4 : 0)] ^= 1;
      expect(() => boundedUnzip(bad, options)).toThrow(/descriptor/);
      const badLocal = packed.bytes.slice();
      new DataView(badLocal.buffer).setUint32(22, 1, true);
      expect(() => boundedUnzip(badLocal, options)).toThrow(/disagreement/);
      const noDescriptor = archive([
        { name: "a", data: encode("original"), flags: 0x808 },
      ]);
      expect(() => boundedUnzip(noDescriptor.bytes, options)).toThrow(
        /descriptor/,
      );
    },
  );

  it("rejects every truncated prefix and archive trailers", () => {
    const packed = archive([{ name: "a", data: encode("hello") }]).bytes;
    for (let end = 0; end < packed.length; end++)
      expect(() => boundedUnzip(packed.subarray(0, end), options)).toThrow();
    expect(() =>
      boundedUnzip(concat(packed, Uint8Array.of(0)), options),
    ).toThrow(/trailing/);
  });

  it("rejects overlap, unindexed bytes, invalid central bounds and duplicate indexing", () => {
    const packed = archive([
      { name: "a", data: encode("hello") },
      { name: "b", data: encode("world") },
    ]);
    const sameLocal = packed.bytes.slice();
    new DataView(sameLocal.buffer).setUint32(packed.centrals[1] + 42, 0, true);
    expect(() => boundedUnzip(sameLocal, options)).toThrow(
      /filename disagreement/,
    );
    const badCentral = packed.bytes.slice();
    new DataView(badCentral.buffer).setUint32(packed.end + 12, 1, true);
    expect(() => boundedUnzip(badCentral, options)).toThrow(
      /central-directory bounds/,
    );
    const noSecond = packed.bytes.slice();
    const v = new DataView(noSecond.buffer);
    v.setUint16(packed.end + 8, 1, true);
    v.setUint16(packed.end + 10, 1, true);
    expect(() => boundedUnzip(noSecond, options)).toThrow(/size\/count/);
  });

  it("detects a valid-looking second local header hidden inside another payload before inflating", () => {
    const packed = archive([
      { name: "a", data: new Uint8Array(128), method: 0 },
      { name: "b", data: encode("world") },
    ]);
    // All second-header fields and data still agree with its central record; the
    // first stored file now covers that same range. CRC is deliberately checked
    // only after this structural alias is rejected.
    const shadow = packed.bytes.slice(packed.locals[1], packed.centrals[0]);
    packed.bytes.set(shadow, 31);
    new DataView(packed.bytes.buffer).setUint32(
      packed.centrals[1] + 42,
      31,
      true,
    );
    expect(() => boundedUnzip(packed.bytes, options)).toThrow(/overlapping/);
  });

  it("does not silently ignore local bytes absent from a valid central index", () => {
    const packed = archive([
      { name: "a", data: encode("hello") },
      { name: "b", data: encode("world") },
    ]);
    const keptCentral = packed.bytes.slice(packed.centrals[1], packed.end);
    const end = packed.bytes.slice(packed.end);
    const v = new DataView(end.buffer);
    v.setUint16(8, 1, true);
    v.setUint16(10, 1, true);
    v.setUint32(12, keptCentral.length, true);
    const hiddenFirst = concat(
      packed.bytes.subarray(0, packed.centrals[0]),
      keptCentral,
      end,
    );
    expect(() => boundedUnzip(hiddenFirst, options)).toThrow(/unindexed/);
  });

  it("accepts bounded extra records and central entries reordered independently of local storage", () => {
    const packed = archive([
      {
        name: "a",
        data: encode("hello"),
        extra: Uint8Array.of(0x34, 0x12, 1, 0, 42),
      },
      { name: "b", data: encode("world") },
    ]);
    const reversed = concat(
      packed.bytes.subarray(0, packed.centrals[0]),
      packed.bytes.subarray(packed.centrals[1], packed.end),
      packed.bytes.subarray(packed.centrals[0], packed.centrals[1]),
      packed.bytes.subarray(packed.end),
    );
    expect(boundedUnzip(reversed, options)).toEqual({
      b: encode("world"),
      a: encode("hello"),
    });
  });

  it("accepts a streaming producer that also fills its agreeing local metadata", () => {
    const packed = archive([
      { name: "a", data: encode("hello"), descriptor: "signed" },
    ]);
    const v = new DataView(packed.bytes.buffer),
      central = packed.centrals[0];
    v.setUint32(14, v.getUint32(central + 16, true), true);
    v.setUint32(18, v.getUint32(central + 20, true), true);
    v.setUint32(22, v.getUint32(central + 24, true), true);
    expect(boundedUnzip(packed.bytes, options).a).toEqual(encode("hello"));
  });

  it.each([
    "../bad",
    "/bad",
    "a/../bad",
    "a/./bad",
    "a//bad",
    "C:/bad",
    "a\\bad",
    "a\0bad",
    "a\nbad",
  ])("rejects unsafe path %s", (name) => {
    expect(() =>
      boundedUnzip(archive([{ name, data: encode("x") }]).bytes, options),
    ).toThrow(/Invalid path/);
  });

  it("rejects case-folded duplicates and invalid or unmarked UTF-8", () => {
    expect(() =>
      boundedUnzip(
        archive([
          { name: "a", data: encode("x") },
          { name: "A", data: encode("x") },
        ]).bytes,
        options,
      ),
    ).toThrow(/Duplicate/);
    expect(() =>
      boundedUnzip(
        archive([{ name: "café", data: encode("x"), flags: 0 }]).bytes,
        options,
      ),
    ).toThrow(/non-UTF8/);
    const packed = archive([{ name: "ab", data: encode("x") }]);
    packed.bytes[30] = 0xff;
    packed.bytes[packed.centrals[0] + 46] = 0xff;
    expect(() => boundedUnzip(packed.bytes, options)).toThrow(/UTF-8/);
  });

  it("rejects encrypted flags, unsupported methods, ZIP64 and malformed extras", () => {
    for (const flags of [1, 0x40, 0x20, 0x2000])
      expect(() =>
        boundedUnzip(
          archive([{ name: "a", data: encode("x"), flags }]).bytes,
          options,
        ),
      ).toThrow(/encrypted|flags/);
    const method = archive([{ name: "a", data: encode("x") }]);
    new DataView(method.bytes.buffer).setUint16(
      method.centrals[0] + 10,
      12,
      true,
    );
    expect(() => boundedUnzip(method.bytes, options)).toThrow(
      /compression method/,
    );
    const zip64 = archive([{ name: "a", data: encode("x") }]);
    new DataView(zip64.bytes.buffer).setUint32(
      zip64.centrals[0] + 24,
      0xffffffff,
      true,
    );
    expect(() => boundedUnzip(zip64.bytes, options)).toThrow(/ZIP64/);
    for (const extra of [
      Uint8Array.of(1, 0, 0, 0),
      Uint8Array.of(23, 0, 0, 0),
      Uint8Array.of(55),
      Uint8Array.of(55, 0, 5, 0),
    ]) {
      expect(() =>
        boundedUnzip(
          archive([{ name: "a", data: encode("x"), extra }]).bytes,
          options,
        ),
      ).toThrow(/ZIP64|encrypted|extra-field/);
    }
  });

  it("rejects split archives, mismatched directory counts and invalid caller limits", () => {
    const packed = archive([{ name: "a", data: encode("x") }]);
    const split = packed.bytes.slice();
    new DataView(split.buffer).setUint16(packed.end + 4, 1, true);
    expect(() => boundedUnzip(split, options)).toThrow(/multi-disk/);
    for (const maxEntries of [0, -1, NaN, 4097])
      expect(() =>
        boundedUnzip(packed.bytes, { ...options, maxEntries }),
      ).toThrow(/entry limit/);
    for (const maxBytes of [-1, NaN, Infinity, 30_000_001])
      expect(() =>
        boundedUnzip(packed.bytes, { ...options, maxBytes }),
      ).toThrow(/byte limit/);
  });

  it("keeps model and texture loaders on the same strict extraction boundary", async () => {
    const model = encode(
      "xof 0303txt 0032\nMesh Original {3;0;0;0;,1;0;0;,0;1;0;;1;3;0,1,2;;}",
    );
    const modelZip = archive([
      {
        name: "original.x",
        data: concat(model, encode("bad".repeat(1000))),
        size: model.length,
        checksum: crc32(model),
      },
    ]).bytes;
    await expect(decodeModelAsset(modelZip, "original.x")).rejects.toThrow(
      /expansion exceeds/,
    );
    await expect(
      decodeModelAsset(gzipSync(modelZip), "original.x"),
    ).rejects.toThrow(/expansion exceeds/);
    const texture = archive([
      {
        name: "original.png",
        data: encode("not actually an image"),
        checksum: 0,
      },
    ]).bytes;
    expect(() => unpackAsset(texture, "texture")).toThrow(/CRC32/);
  });
});
