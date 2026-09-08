import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isolatedAssetFiles } from "../scripts/axis-isolated.mjs";
import { directXFixtureAssets } from "../scripts/directx-fixture-assets.mjs";
import { directXAnimationAssets } from "../scripts/directx-animation-assets.mjs";
import {
  exactOwnedDirectXObject,
  verifyOriginalDirectXModel,
  verifyOriginalDirectXWave,
  verifyOriginalDirectXSalute,
} from "../scripts/axis-isolated-directx-helpers";
import { decodeModelAsset } from "../src/renderer/engine/assets";
import { parseDirectX } from "../src/renderer/engine/directx";
import {
  parseAvatarCatalog,
  parseAvatarSequence,
} from "../src/renderer/engine/avatar-assets";
import { createScopedAssetFetcher } from "../src/main/scoped-assets";
import { nativeQaAssetTarget } from "../src/main/native-startup";
import type { WorldObject } from "../src/shared/types";

const project = resolve(import.meta.dirname, ".."),
  qa = {
    mode: "fixture" as const,
    universePort: 26670,
    worldPort: 27000,
    assetPort: 27400,
  };
describe("opt-in fresh DirectX fixture asset profile", () => {
  it("keeps all29 default copied files byte-identical to existing public originals", () => {
    const implicit = isolatedAssetFiles(),
      explicit = isolatedAssetFiles("baseline");
    expect(implicit.size).toBe(29);
    expect([...implicit.keys()]).toEqual([...explicit.keys()]);
    for (const [name, bytes] of implicit) {
      expect(bytes).toEqual(
        readFileSync(resolve(project, "public/assets", name)),
      );
      expect(bytes).toEqual(explicit.get(name));
    }
    expect([...implicit.keys()].some((name) => name.endsWith(".x"))).toBe(
      false,
    );
  });
  it("merges only known originals before writes, replacing only the fresh catalog pair", () => {
    const base = isolatedAssetFiles(),
      profile = isolatedAssetFiles("directx"),
      generated = directXFixtureAssets();
    expect(profile.size).toBe(43);
    for (const [name, bytes] of base)
      if (!["avatars/avatars.dat", "avatars/avatars.zip"].includes(name))
        expect(profile.get(name)).toEqual(bytes);
    for (const [name, bytes] of generated)
      expect(profile.get(name)).toEqual(Buffer.from(bytes));
    expect(
      [...profile.values()].reduce((total, bytes) => total + bytes.length, 0),
    ).toBeLessThan(10_000_000);
    expect(
      [...profile.values()].every((bytes) => bytes.length < 1_000_000),
    ).toBe(true);
    expect(
      parseAvatarCatalog(
        profile.get("avatars/avatars.dat")!.toString(),
      ).entries.map((value) => [value.index, value.geometry]),
    ).toEqual([
      [0, "wf-voyager.rwx"],
      [1, "wf-keeper.rwx"],
      [2, "wf-x-voyager.x"],
    ]);
    expect([...profile.keys()].some((name) => name.startsWith("probes/"))).toBe(
      false,
    );
  });
  it("does not share mutable buffers with another profile map or alter default bytes", () => {
    const a = isolatedAssetFiles("directx"),
      b = isolatedAssetFiles("directx");
    a.get("avatars/avatars.dat")!.fill(0);
    a.get("models/wf-x-marker.x")!.fill(0);
    expect(b.get("avatars/avatars.dat")!.toString()).toContain(
      "Original DirectX Voyager",
    );
    expect(b.get("models/wf-x-marker.x")!.toString()).toContain("xof");
    expect(
      isolatedAssetFiles().get("avatars/avatars.dat")!.toString(),
    ).not.toContain("DirectX");
  });
  it.each(["other", "DIRECTX", "", null, {}, "../axis"])(
    "rejects unknown profile%s before preparing services",
    (value) =>
      expect(() => isolatedAssetFiles(value as "directx")).toThrow(/profile/),
  );
});

describe("dedicated DirectX integration numeric and cleanup checks", () => {
  it.each(['', '-binary32', '-binary64', '-tzip', '-bzip', '-seq'])('verifies original external X salute numeric skin, independent pose and neutral checks for%s', suffix => {
    const model = parseDirectX(directXFixtureAssets().get('avatars/wf-x-voyager.x')!);
    const sequence = parseAvatarSequence(directXAnimationAssets().get(`seqs/wf-x-salute${suffix}.${suffix === '-seq' ? 'seq' : 'x'}`)!);
    const evidence = verifyOriginalDirectXSalute(model, sequence);
    expect(evidence).toMatchObject({ format: 'directx', durationMs: 4000, independentNeutral: true, finalNeutral: true });
    evidence.weightedPointAt1000ms.forEach((value, axis) => expect(value).toBeCloseTo([.32, 1.12, .1][axis], 6));
    expect(() => verifyOriginalDirectXSalute(model, { ...sequence, durationMs: 2000 })).toThrow();
  });
  it.each(["", "-binary32", "-binary64"])(
    "proves original raw/ZIP static and skinned oracles for%s",
    async (suffix) => {
      const files = directXFixtureAssets();
      for (const [kind, stem] of [
        ["static", "models/wf-x-marker"],
        ["avatar", "avatars/wf-x-voyager"],
      ] as const)
        for (const extension of [".x", ".zip"]) {
          const path = stem + suffix + extension,
            decoded = await decodeModelAsset(
              files.get(path)!,
              stem.split("/").at(-1) + suffix + ".x",
              "http://127.0.0.1:27400/" + path,
            );
          if (decoded.format !== "x") throw new Error("Expected X");
          const result = verifyOriginalDirectXModel(
            parseDirectX(decoded.source),
            kind,
          );
          expect(result.meshes).toBe(1);
          expect(result.joints).toBe(kind === "avatar" ? 16 : 0);
        }
    },
  );
  it("applies the exact original live Wave to the skinned model and returns to neutral", () => {
    const model = parseDirectX(
        directXFixtureAssets().get("avatars/wf-x-voyager.x")!,
      ),
      wave = parseAvatarSequence(
        readFileSync(resolve(project, "public/assets/seqs/wf-wave.seq")),
      );
    expect(() => verifyOriginalDirectXWave(model, wave)).not.toThrow();
  });
  it("refuses cleanup of unloaded, reusedID or remotely changed snapshots", () => {
    const owned: WorldObject = {
      id: 33,
      owner: 2,
      model: "wf-x-marker.x",
      description: "owned",
      action: "",
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
    };
    expect(exactOwnedDirectXObject({ ...owned }, owned)).toBe(true);
    for (const current of [
      undefined,
      { ...owned, id: 34 },
      { ...owned, owner: 3 },
      { ...owned, model: "other.x" },
      { ...owned, x: 1 },
      { ...owned, description: "changed" },
    ])
      expect(exactOwnedDirectXObject(current, owned)).toBe(false);
  });
});

describe("DirectX runner uses the same fixed nativeQA asset policy", () => {
  it("rejects primary, remote, credentials and query URLs before any network call", async () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network"));
    try {
      const fetcher = createScopedAssetFetcher((input) =>
        nativeQaAssetTarget(input, qa),
      );
      for (const url of [
        "http://127.0.0.1:17400/models/a.x",
        "https://127.0.0.1:27400/models/a.x",
        "http://example.invalid:27400/models/a.x",
        "http://u:p@127.0.0.1:27400/models/a.x",
        "http://127.0.0.1:27400/models/a.x?q=1",
      ])
        await expect(fetcher(url)).rejects.toThrow();
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
  it("requests native redirect rejection, no ambient credentials, and refuses a redirect response", async () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1:17400/private" },
        }),
      );
    try {
      const fetcher = createScopedAssetFetcher((input) =>
        nativeQaAssetTarget(input, qa),
      );
      await expect(
        fetcher("http://127.0.0.1:27400/models/a.x"),
      ).rejects.toThrow(/302/);
      expect(network).toHaveBeenCalledTimes(1);
      expect(network).toHaveBeenCalledWith(
        "http://127.0.0.1:27400/models/a.x",
        expect.objectContaining({ redirect: "error", credentials: "omit" }),
      );
    } finally {
      network.mockRestore();
    }
  });
});
