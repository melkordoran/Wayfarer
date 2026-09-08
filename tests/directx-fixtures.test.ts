import { describe, expect, it } from "vitest";
import { unzipSync, unzlibSync } from "fflate";
import { resolve } from "node:path";
import {
  directXFixtureAssets,
  directXFixtureExpectations,
  directXFixtureSources,
  directXMalformedFixtures,
  writeDirectXFixtureAssets,
} from "../scripts/directx-fixture-assets.mjs";
import { parseAvatarCatalog } from "../src/renderer/engine/avatar-assets";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const near = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) =>
    expect(value).toBeCloseTo(expected[index], 8),
  );
};
// Lexical byte audit only: this does not construct a DirectX mesh or rig and
// never imports the production .x parser. Values/positions below are independent
// authored numeric oracles, not a parser/emitter round trip.
function tokenAudit(bytes: Uint8Array, terminatorBytes = 4) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    bits = Number(text(bytes.slice(12, 16))),
    names: string[] = [],
    strings: string[] = [],
    floats: number[] = [],
    integers: number[] = [],
    guids: number[][] = [];
  let p = 16;
  const u16 = () => {
      const value = view.getUint16(p, true);
      p += 2;
      return value;
    },
    u32 = () => {
      const value = view.getUint32(p, true);
      p += 4;
      return value;
    };
  while (p < bytes.length) {
    const token = u16();
    if (token === 1 || token === 2) {
      const count = u32(),
        value = text(bytes.slice(p, p + count));
      expect(p + count).toBeLessThanOrEqual(bytes.length);
      p += count;
      (token === 1 ? names : strings).push(value);
      if (token === 2) expect(terminatorBytes === 4 ? u32() : u16()).toBe(20);
    } else if (token === 3) integers.push(u32());
    else if (token === 5) {
      guids.push([...bytes.slice(p, p + 16)]);
      p += 16;
    } else if (token === 6 || token === 7) {
      const count = u32();
      expect(count).toBeLessThan(100_000);
      for (let i = 0; i < count; i++) {
        if (token === 6) integers.push(u32());
        else {
          floats.push(
            bits === 32 ? view.getFloat32(p, true) : view.getFloat64(p, true),
          );
          p += bits / 8;
        }
      }
    } else
      expect([10, 11, 14, 15, 20, 31, 40, 41, 42, 49, 52]).toContain(token);
  }
  expect(p).toBe(bytes.length);
  return { bits, names, strings, floats, integers, guids };
}

describe("original DirectX fixture generation", () => {
  it("returns deterministic bounded independent byte maps without writing public assets", () => {
    const a = directXFixtureAssets(),
      b = directXFixtureAssets();
    expect(a.size).toBe(16);
    expect([...a.keys()]).toEqual([...b.keys()]);
    let total = 0;
    for (const [name, bytes] of a) {
      expect(bytes).toEqual(b.get(name));
      expect(bytes.byteLength).toBeLessThan(1_000_000);
      expect(name).not.toMatch(/(?:^|\/)\.\.|[\\:]/);
      total += bytes.length;
    }
    expect(total).toBeLessThan(100_000);
    a.get("models/wf-x-marker.x")![0] = 0;
    expect(b.get("models/wf-x-marker.x")![0]).toBe("x".charCodeAt(0));
    expect(text(a.get("directx-LICENSE.txt")!)).toContain("CC0");
  });
  it("keeps raw text and both independently encoded binary variants in matching one-member ZIPs", () => {
    const files = directXFixtureAssets();
    let count = 0;
    for (const [name, bytes] of files)
      if (name.endsWith(".x")) {
        count++;
        const archive = unzipSync(files.get(name.replace(/\.x$/, ".zip"))!);
        expect(Object.keys(archive)).toEqual([name.split("/").at(-1)]);
        expect(Object.values(archive)[0]).toEqual(bytes);
      }
    expect(count).toBe(6);
    expect(
      text(files.get("models/wf-x-marker.x")!).startsWith("xof 0303txt 0032"),
    ).toBe(true);
  });
  it.each([32, 64])(
    "encodes binary%i with little-endian WORD tokens, typed records and DWORD string terminators",
    (bits) => {
      const files = directXFixtureAssets(),
        staticBytes = files.get(`models/wf-x-marker-binary${bits}.x`)!,
        skinBytes = files.get(`avatars/wf-x-voyager-binary${bits}.x`)!;
      expect(text(staticBytes.slice(0, 16))).toBe(`xof 0303bin 00${bits}`);
      // First Frame name record has TOKEN_NAME WORD1, DWORD byte length5.
      expect([...staticBytes.slice(16, 22)]).toEqual([1, 0, 5, 0, 0, 0]);
      expect(text(staticBytes.slice(22, 27))).toBe("Frame");
      const stat = tokenAudit(staticBytes),
        skin = tokenAudit(skinBytes);
      expect(stat.bits).toBe(bits);
      expect(stat.names).toContain("OriginalConcaveMarker");
      expect(stat.strings).toEqual(["wf-x-corners.png"]);
      expect(skin.names).toContain("XSkinMeshHeader");
      expect(skin.strings).toContain("aw_lfelbow");
      expect(skin.guids[0]).toEqual([
        0xce, 0x69, 0xf1, 0x3c, 0x7c, 0xff, 0xab, 0x44, 0x93, 0xc0, 0xf7, 0x8f,
        0x62, 0xd1, 0x72, 0xe2,
      ]);
      expect(skin.floats).toContain(0.75);
      expect(skin.floats).toContain(0.5);
      expect(stat.integers).toContain(6);
      expect(stat.floats).toContain(bits === 32 ? Math.fround(2 / 3) : 2 / 3);
    },
  );
  it("labels the WORD-string exporter variant separately from the normative binary", () => {
    const compat = directXMalformedFixtures().get(
        "compat-word-string-terminator.x",
      )!,
      normal = directXFixtureAssets().get("models/wf-x-marker-binary32.x")!;
    expect(compat.length).toBe(normal.length - 2);
    expect(tokenAudit(compat, 2).strings).toEqual(["wf-x-corners.png"]);
    expect(directXFixtureExpectations().binary.stringTerminatorBytes).toBe(4);
  });
  it("preserves the original two declaration ordinals and appends only X avatar2", () => {
    const files = directXFixtureAssets(),
      catalog = parseAvatarCatalog(text(files.get("avatars/avatars.dat")!));
    expect(catalog.entries.map((a) => [a.index, a.name, a.geometry])).toEqual([
      [0, "Wayfarer Voyager", "wf-voyager.rwx"],
      [1, "Haven Keeper", "wf-keeper.rwx"],
      [2, "Original DirectX Voyager", "wf-x-voyager.x"],
    ]);
    expect(
      Object.values(unzipSync(files.get("avatars/avatars.zip")!))[0],
    ).toEqual(files.get("avatars/avatars.dat"));
  });
  it("keeps negative/warning/compatibility probes out of the served positive map", () => {
    const assets = directXFixtureAssets(),
      bad = directXMalformedFixtures(),
      source = directXFixtureSources();
    expect(bad.size).toBe(10);
    for (const name of bad.keys()) expect(assets.has(name)).toBe(false);
    expect(text(bad.get("missing-bone.x")!)).toContain('"aw_missing"');
    expect(text(bad.get("negative-weight.x")!)).toContain("-1,1,1,1,1,1,1,1;");
    expect(text(bad.get("nonunit-weight.x")!)).toContain(".5,1,1,1,1,1,1,1;");
    expect(text(bad.get("out-of-range-face.x")!)).toContain("9999");
    expect(
      text(bad.get("duplicate-frame-name.x")!).match(/Frame aw_lfshoulder \{/g),
    ).toHaveLength(2);
    expect(text(bad.get("warning-embedded-animation.x")!)).toContain(
      "AnimationSet",
    );
    expect(source.staticText).not.toContain("AnimationSet");
    expect(source.skinnedText).not.toContain("AnimationSet");
    expect(bad.get("overflow-float-count.x")!.length).toBe(22);
    expect(bad.get("truncated-binary32.x")!.length).toBe(
      assets.get("models/wf-x-marker-binary32.x")!.length - 3,
    );
  });
  it("refuses output paths that could overwrite primary, public or broad directories", () => {
    for (const path of [
      "public/assets",
      ".runtime/axis",
      ".runtime/axis-isolated-fake",
      "tests/fixtures",
      "tests/fixtures/../directx",
      "/",
    ])
      expect(() =>
        writeDirectXFixtureAssets(resolve(import.meta.dirname, "..", path)),
      ).toThrow(/output directory/);
    expect(() =>
      writeDirectXFixtureAssets(
        resolve(import.meta.dirname, "fixtures/directx-missing"),
        { check: true },
      ),
    ).toThrow(/Missing/);
  });
});

describe("independent authored geometry and skinning oracle", () => {
  it("has a concave front polygon with exact area and asymmetric nested-transform bounds", () => {
    const e = directXFixtureExpectations(),
      m = e.static;
    expect(e.source.handedness).toBe("right");
    expect(e.source.up).toBe("+Y");
    expect(e.source.units).toContain("unverified");
    const polygon = m.faces[0].map((i) => m.vertices[i]);
    let signed = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      signed += a[0] * b[1] - a[1] * b[0];
    }
    expect(signed / 2).toBe(2);
    expect(m.concaveArea).toBe(2);
    expect(m.materials).toEqual([0, 1]);
    m.vertices.forEach((v, i) =>
      near(m.transformedVertices[i], [v[2] + 5, v[1] + 0.5, -v[0] - 3]),
    );
    near(
      [0, 1, 2].map((axis) =>
        Math.min(...m.transformedVertices.map((v) => v[axis])),
      ),
      m.bounds.min,
    );
    near(
      [0, 1, 2].map((axis) =>
        Math.max(...m.transformedVertices.map((v) => v[axis])),
      ),
      m.bounds.max,
    );
    expect(m.faces[0]).toHaveLength(6);
    expect(m.uv[0]).toEqual([0, 1]);
    expect(m.uv[5]).toEqual([0, 0]);
  });
  it("uses16named bones with genuine shared weights and inverse nonidentity bind offsets", () => {
    const s = directXFixtureExpectations().skinned;
    expect(s.bones).toHaveLength(16);
    expect(s.vertices).toHaveLength(132);
    expect(s.weights).toHaveLength(s.vertices.length);
    expect(
      s.weights.some(
        (w) => w.length === 2 && w[0].weight === 0.25 && w[1].weight === 0.75,
      ),
    ).toBe(true);
    for (const bone of s.bones) {
      expect(bone.name).toMatch(/^aw_/);
      expect(bone.offset.slice(12, 15)).toEqual(bone.origin.map((v) => -v));
      if (bone.parent)
        expect(s.bones.some((b) => b.name === bone.parent)).toBe(true);
    }
    s.vertices.forEach((v, i) => {
      const posed = [0, 0, 0];
      for (const influence of s.weights[i]) {
        const bone = s.bones.find((b) => b.name === influence.bone)!;
        const rest = v.map(
          (x, axis) => x + bone.offset[12 + axis] + bone.origin[axis],
        );
        rest.forEach((x, axis) => (posed[axis] += x * influence.weight));
      }
      expect(s.weights[i].reduce((n, w) => n + w.weight, 0)).toBe(1);
      near(posed, v);
      near(s.bindVertices[i], [posed[2] + 0.25, posed[1], 0.5 - posed[0]]);
    });
  });
  it("has independently known pure-elbow and blended-elbow90degree results", () => {
    const s = directXFixtureExpectations().skinned,
      elbow = s.bones.find((b) => b.name === "aw_lfelbow")!;
    for (const witness of [s.elbowWitness, s.blendedWitness]) {
      const v = s.vertices[witness.index],
        sum = [0, 0, 0];
      for (const w of s.weights[witness.index]) {
        const rotated =
          w.bone === "aw_lfelbow"
            ? [
                elbow.origin[0] - (v[1] - elbow.origin[1]),
                elbow.origin[1] + v[0] - elbow.origin[0],
                v[2],
              ]
            : v;
        rotated.forEach((x, i) => (sum[i] += x * w.weight));
      }
      near(s.bindVertices[witness.index], witness.bind);
      near([sum[2] + 0.25, sum[1], 0.5 - sum[0]], witness.rotated90Z);
      expect(witness.rotated90Z).not.toEqual(witness.bind);
    }
  });
  it("returns independent numeric arrays, not writable process-wide fixture state", () => {
    const a = directXFixtureExpectations();
    a.skinned.vertices[0][0] = 999;
    a.skinned.weights[0][0].weight = 0;
    a.static.bounds.min[0] = 999;
    const b = directXFixtureExpectations();
    expect(b.skinned.vertices[0][0]).not.toBe(999);
    expect(b.skinned.weights[0][0].weight).toBe(1);
    expect(b.static.bounds.min[0]).toBe(4.75);
  });
  it("encodes an original PNG with distinct top/bottom and left/right corner pixels", () => {
    const bytes = directXFixtureAssets().get("textures/wf-x-corners.png")!,
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(view.getUint32(16)).toBe(32);
    expect(view.getUint32(20)).toBe(32);
    let p = 8,
      idat = new Uint8Array();
    while (p < bytes.length) {
      const n = view.getUint32(p),
        kind = text(bytes.slice(p + 4, p + 8));
      if (kind === "IDAT") idat = bytes.slice(p + 8, p + 8 + n);
      p += n + 12;
    }
    const raw = unzlibSync(idat),
      pixel = (x: number, y: number) => [
        ...raw.slice(y * 129 + 1 + x * 4, y * 129 + 1 + x * 4 + 4),
      ];
    expect(pixel(0, 0)).toEqual([30, 180, 160, 255]);
    expect(pixel(31, 0)).toEqual([235, 180, 65, 255]);
    expect(pixel(0, 31)).toEqual([95, 100, 220, 255]);
    expect(pixel(31, 31)).toEqual([220, 75, 100, 255]);
    expect(pixel(4, 4)).toEqual([12, 20, 30, 255]);
  });
});
