import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIsolatedFixture,
  isolatedAssetFiles,
  type IsolatedAssetProfile,
} from "../scripts/axis-isolated.mjs";
import { directXFixtureAssets } from "../scripts/directx-fixture-assets.mjs";
import {
  directXAnimationAssets,
  directXAnimationContentType,
  withDirectXAnimationCatalog,
} from "../scripts/directx-animation-assets.mjs";
import {
  loadAvatarSequence,
  parseAvatarCatalog,
} from "../src/renderer/engine/avatar-assets";
import { boundedUnzip } from "../src/renderer/engine/zip";

const project = resolve(import.meta.dirname, "..");
const catalogNames = ["avatars/avatars.dat", "avatars/avatars.zip"];
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const hashes = (files: Map<string, Uint8Array>) =>
  Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)]));

describe("explicit isolated DirectX animation profile", () => {
  it("preserves all29 baseline public bytes and all43 existing DirectX profile bytes", () => {
    const baseline = isolatedAssetFiles(),
      directx = isolatedAssetFiles("directx");
    expect(baseline.size).toBe(29);
    expect(directx.size).toBe(43);
    for (const [name, bytes] of baseline)
      expect(bytes).toEqual(
        readFileSync(resolve(project, "public/assets", name)),
      );
    const independentlyMerged = new Map(baseline);
    for (const [name, bytes] of directXFixtureAssets())
      independentlyMerged.set(name, Buffer.from(bytes));
    expect(hashes(directx)).toEqual(hashes(independentlyMerged));
    const before = { baseline: hashes(baseline), directx: hashes(directx) };
    isolatedAssetFiles("directx-animation");
    expect(hashes(isolatedAssetFiles())).toEqual(before.baseline);
    expect(hashes(isolatedAssetFiles("directx"))).toEqual(before.directx);
    expect(hashes(isolatedAssetFiles("baseline"))).toEqual(before.baseline);
  });

  it("adds exactly12 original motion files and only replaces the fresh catalog pair", () => {
    const base = isolatedAssetFiles("directx"),
      motion = directXAnimationAssets(),
      animation = isolatedAssetFiles("directx-animation");
    expect(motion.size).toBe(12);
    expect(animation.size).toBe(55);
    const added = [...animation.keys()].filter((name) => !base.has(name));
    expect(added.sort()).toEqual([...motion.keys()].sort());
    const changed = [...base]
      .filter(([name, bytes]) => hash(animation.get(name)!) !== hash(bytes))
      .map(([name]) => name);
    expect(changed.sort()).toEqual([...catalogNames].sort());
    for (const [name, bytes] of motion)
      expect(animation.get(name)).toEqual(Buffer.from(bytes));
    const updatedCatalog = withDirectXAnimationCatalog(base);
    for (const name of catalogNames)
      expect(animation.get(name)).toEqual(
        Buffer.from(updatedCatalog.get(name)!),
      );
    expect(
      [...animation.keys()].some((name) => name.startsWith("probes/")),
    ).toBe(false);
    for (const [name, bytes] of animation) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9_./-]*$/i);
      expect(bytes.length).toBeLessThanOrEqual(1_000_000);
    }
    expect(
      [...animation.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    ).toBeLessThan(10_000_000);
    expect(animation.size).toBeLessThanOrEqual(64);
  });

  it("keeps avatar ordinals0/1/2 and appends XSalute2 after Wave1 on avatar2 only", () => {
    const base = parseAvatarCatalog(
      isolatedAssetFiles("directx").get("avatars/avatars.dat")!.toString(),
    );
    const files = isolatedAssetFiles("directx-animation"),
      catalog = parseAvatarCatalog(
        files.get("avatars/avatars.dat")!.toString(),
      );
    expect(
      catalog.entries.map((entry) => [entry.index, entry.geometry]),
    ).toEqual([
      [0, "wf-voyager.rwx"],
      [1, "wf-keeper.rwx"],
      [2, "wf-x-voyager.x"],
    ]);
    expect(catalog.entries.slice(0, 2)).toEqual(base.entries.slice(0, 2));
    expect(catalog.entries[2].implicit).toEqual(base.entries[2].implicit);
    expect(catalog.entries[2].explicit[0]).toEqual(base.entries[2].explicit[0]);
    expect(
      catalog.entries[2].explicit.map((gesture, index) => [
        index + 1,
        gesture.name,
      ]),
    ).toEqual([
      [1, "Wave"],
      [2, "X Salute"],
    ]);
    expect(catalog.entries[2].explicit[1].sequence).toBe("wf-x-salute.x");
    expect(base.entries[2].explicit).toHaveLength(1);
    const zipped = boundedUnzip(files.get("avatars/avatars.zip")!, {
      maxBytes: 1_000_000,
      maxEntries: 8,
    });
    expect(Object.keys(zipped)).toEqual(["avatars.dat"]);
    expect(Buffer.from(zipped["avatars.dat"])).toEqual(
      files.get("avatars/avatars.dat"),
    );
  });

  it("returns independent owned buffers without changing public originals or other profiles", () => {
    const original = isolatedAssetFiles("directx-animation"),
      baselineBefore = hashes(isolatedAssetFiles()),
      directxBefore = hashes(isolatedAssetFiles("directx"));
    const expected = hashes(original),
      independent = isolatedAssetFiles("directx-animation");
    for (const bytes of original.values()) bytes.fill(0);
    expect(hashes(independent)).toEqual(expected);
    expect(hashes(isolatedAssetFiles("directx-animation"))).toEqual(expected);
    expect(hashes(isolatedAssetFiles())).toEqual(baselineBefore);
    expect(hashes(isolatedAssetFiles("directx"))).toEqual(directxBefore);
  });

  it("loads every new raw/ZIP/internal-compressed sequence from only its in-memory profile", async () => {
    const files = isolatedAssetFiles("directx-animation");
    const realNetwork = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network forbidden in profile test"));
    try {
      for (const stem of [
        "wf-x-salute",
        "wf-x-salute-binary32",
        "wf-x-salute-binary64",
        "wf-x-salute-tzip",
        "wf-x-salute-bzip",
        "wf-x-salute-seq",
      ]) {
        const name = stem.endsWith("-seq") ? `${stem}.seq` : `${stem}.x`;
        const fetcher = vi.fn(async (url: string) => {
          const prefix = "https://isolated-animation.wayfarer.invalid/";
          if (!url.startsWith(prefix))
            throw new Error("Unexpected fixture origin");
          const relative = url.slice(prefix.length),
            bytes = files.get(relative);
          if (!bytes) throw new Error("Missing original fixture");
          return {
            bytes: Uint8Array.from(bytes),
            contentType: directXAnimationContentType(relative),
          };
        });
        const sequence = await loadAvatarSequence(
          "https://isolated-animation.wayfarer.invalid/",
          name,
          fetcher,
        );
        expect(sequence.durationMs).toBe(4000);
        expect(fetcher).toHaveBeenCalled();
      }
      expect(realNetwork).not.toHaveBeenCalled();
    } finally {
      realNetwork.mockRestore();
    }
  });

  it.each([
    "directx_animation",
    "DIRECTX-ANIMATION",
    "directx-animation/",
    "../axis",
    "",
    null,
    {},
    1,
  ])(
    "rejects invalid explicit profile%j before fixture preparation",
    async (value) => {
      expect(() => isolatedAssetFiles(value as IsolatedAssetProfile)).toThrow(
        /profile/,
      );
      // Invalid options fail before port probing, credential creation or writes.
      if (value !== null)
        await expect(
          createIsolatedFixture({
            assetProfile: value as IsolatedAssetProfile,
          }),
        ).rejects.toThrow(/profile/);
    },
  );
});

describe("animation profile merge safety", () => {
  afterEach(() => {
    vi.doUnmock("../scripts/directx-animation-assets.mjs");
    vi.resetModules();
  });

  it.each([
    ["existing file", "seqs/wf-wave.seq", new Uint8Array(1)],
    ["traversal", "seqs/../escape.x", new Uint8Array(1)],
    ["absolute", "/seqs/escape.x", new Uint8Array(1)],
    ["new folder", "avatars/new.x", new Uint8Array(1)],
    ["oversize", "seqs/huge.x", new Uint8Array(1_000_001)],
  ] as const)(
    "rejects%s output from an accidental generator change",
    async (_label, name, bytes) => {
      vi.doMock("../scripts/directx-animation-assets.mjs", () => ({
        withDirectXAnimationCatalog,
        directXAnimationAssets: () => new Map([[name, bytes]]),
      }));
      vi.resetModules();
      const module = await import("../scripts/axis-isolated.mjs");
      expect(() => module.isolatedAssetFiles("directx-animation")).toThrow(
        /cannot replace|Invalid generated/,
      );
    },
  );

  it("retains total file and byte budgets after animation merging", async () => {
    for (const mode of ["files", "bytes"]) {
      const generated = new Map(
        Array.from({ length: mode === "files" ? 22 : 11 }, (_, index) => [
          `seqs/extra${index}.x`,
          new Uint8Array(mode === "files" ? 1 : 1_000_000),
        ]),
      );
      vi.doMock("../scripts/directx-animation-assets.mjs", () => ({
        withDirectXAnimationCatalog,
        directXAnimationAssets: () => generated,
      }));
      vi.resetModules();
      const module = await import("../scripts/axis-isolated.mjs");
      expect(() => module.isolatedAssetFiles("directx-animation")).toThrow(
        /fixture budgets/,
      );
      vi.doUnmock("../scripts/directx-animation-assets.mjs");
    }
  });

  it("bounds both generated catalog entries before copying their bytes", async () => {
    vi.doMock("../scripts/directx-animation-assets.mjs", () => ({
      directXAnimationAssets,
      withDirectXAnimationCatalog: () =>
        new Map([["avatars/avatars.dat", new Uint8Array(1_000_001)]]),
    }));
    vi.resetModules();
    const module = await import("../scripts/axis-isolated.mjs");
    expect(() => module.isolatedAssetFiles("directx-animation")).toThrow(
      /animation catalog/,
    );
  });
});
