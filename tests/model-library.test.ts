import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetUrls } from "../src/renderer/engine/assets";
import {
  buildModelCatalog,
  loadModelLibrary,
  modelLibraryKey,
  normalizeModelRef,
  rememberModel,
  saveModelLibrary,
  setModelFavorite,
  MODEL_LIBRARY_LIMITS,
  ORIGINAL_MODEL_NAMES,
  type ModelLibraryScope,
  type ModelLibraryStorage,
} from "../src/renderer/model-library";

const studio: ModelLibraryScope = { kind: "studio" };
const world: ModelLibraryScope = {
  kind: "world",
  host: "127.0.0.1",
  port: 16670,
  tls: false,
  world: "Haven",
  objectPath: "http://127.0.0.1:17400/",
};
function memory() {
  const values = new Map<string, string>();
  const storage: ModelLibraryStorage = {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => {
      values.set(key, value);
    }),
  };
  return { values, storage };
}
function key(scope: ModelLibraryScope = world): string {
  const result = modelLibraryKey(scope);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function model(input: string) {
  const normalized = normalizeModelRef(input);
  if (!normalized.ok) throw new Error(normalized.error.message);
  return normalized.value;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("safe model references", () => {
  it.each([
    "Column",
    "Column.rwx",
    "Column.RWX",
    "Column.zip",
    "  Column.ZIP  ",
  ])(
    "normalizes model alias %s while matching existing loader URLs",
    (input) => {
      const normalized = model(input);
      expect(normalized).toEqual({
        model: /\.rwx$/i.test(input.trim()) ? "Column.rwx" : "Column",
        displayName: "Column",
        kind: /\.rwx$/i.test(input.trim()) ? "rwx" : "auto",
      });
      expect(
        assetUrls("https://assets.example/path/", input.trim(), "models"),
      ).toEqual(
        assetUrls("https://assets.example/path/", normalized.model, "models"),
      );
    },
  );
  it("preserves filename case and formats names without changing the model reference", () => {
    expect(model("oak_bench-02")).toEqual({
      model: "oak_bench-02",
      displayName: "Oak Bench 02",
      kind: "auto",
    });
    expect(model("tree").model).not.toBe(model("Tree").model);
    expect(model("structure.v2").model).toBe("structure.v2");
  });
  it.each([
    "",
    " ",
    ".",
    "..",
    "../column.rwx",
    "folder/column.rwx",
    "folder\\column.rwx",
    "/column.rwx",
    "https://assets.example/column.rwx",
    "//assets.example/column.rwx",
    "file:///column.rwx",
    "user:secret@host.rwx",
    "name?token=secret",
    "name#part",
    "name%2erwx",
    "x\0.rwx",
    "<script>",
    "wayfarer:unknown",
    "WAYFARER:tree",
    "texture.png",
    "model.",
    "a".repeat(256),
  ])("rejects unsafe, unsupported or oversized reference %s", (input) => {
    expect(normalizeModelRef(input).ok).toBe(false);
  });
  it("allows only procedural shapes implemented by makeDemoModel, without using its unknown fallback", () => {
    const source = readFileSync(
      new URL("../src/renderer/engine/demo.ts", import.meta.url),
      "utf8",
    );
    const names = [
      ...source
        .slice(source.indexOf("export function makeDemoModel"))
        .matchAll(/case ['"]([^'"]+)['"]:/g),
    ]
      .map((match) => `wayfarer:${match[1]}`)
      .sort();
    expect([...ORIGINAL_MODEL_NAMES].sort()).toEqual(names);
    for (const name of names) expect(model(name).kind).toBe("builtin");
  });
  it.each([
    "avatar.cav",
    "walk.seq",
    "motion.bvh",
    "avatar.x.zip",
    "avatar.cav.rwx",
  ])(
    "rejects unsupported model or motion format %s instead of implying RWX support",
    (input) => {
      expect(normalizeModelRef(input)).toMatchObject({
        ok: false,
        error: { code: "invalid-model" },
      });
    },
  );
  it("preserves explicit DirectX and RWX format identity separately from automatic lookup", () => {
    expect(model("Marker.X")).toEqual({
      model: "Marker.x",
      displayName: "Marker",
      kind: "x",
    });
    expect(model("Marker.rwx").kind).toBe("rwx");
    expect(model("Marker.zip")).toEqual(model("Marker"));
    expect(model("Marker").kind).toBe("auto");
    expect(model("Marker.x").model).not.toBe(model("Marker").model);
    expect(assetUrls("https://assets.example/", "Marker.X", "models")).toEqual(
      assetUrls("https://assets.example/", model("Marker.X").model, "models"),
    );
    expect(model("a".repeat(255)).model).toHaveLength(255);
    expect(normalizeModelRef("a".repeat(254) + ".x").ok).toBe(false);
  });
});

describe("bounded loaded-world model catalogs", () => {
  it("does not invent fixture or studio models for an arbitrary empty network world", () => {
    expect(buildModelCatalog([])).toEqual({
      items: [],
      ignored: 0,
      truncated: false,
      unscanned: 0,
    });
  });
  it("includes every original model only when requested, counting actual usage separately", () => {
    const catalog = buildModelCatalog(
      [{ model: "wayfarer:tree" }, { model: "wayfarer:tree" }],
      { includeBuiltins: true },
    );
    expect(catalog.items).toHaveLength(15);
    expect(
      catalog.items.find((entry) => entry.model === "wayfarer:tree")?.usage,
    ).toBe(2);
    expect(
      catalog.items.find((entry) => entry.model === "wayfarer:cube")?.usage,
    ).toBe(0);
    expect(buildModelCatalog([{ model: "wayfarer:tree" }]).items).toHaveLength(
      1,
    );
  });
  it("combines archive/bare aliases, sorts naturally and reports ignored malformed occurrences", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const catalog = buildModelCatalog([
      { model: "tree10.rwx" },
      { model: "bench.zip" },
      { model: "tree2" },
      { model: "bench" },
      { model: "../bad.rwx" },
      { model: "https://elsewhere/model.rwx" },
      { model: "wayfarer:unimplemented" },
    ]);
    expect(catalog.items.map((entry) => [entry.model, entry.usage])).toEqual([
      ["bench", 2],
      ["tree2", 1],
      ["tree10.rwx", 1],
    ]);
    expect(catalog.ignored).toBe(3);
    expect(catalog.truncated).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps sorted selection and usage deterministic when more than 500 unique models arrive out of order", () => {
    const objects = Array.from({ length: 505 }, (_, index) => ({
      model: `piece${index}.rwx`,
    }));
    objects.push({ model: "piece1.rwx" });
    const a = buildModelCatalog(objects),
      b = buildModelCatalog([...objects].reverse());
    expect(a).toEqual(b);
    expect(a.items).toHaveLength(500);
    expect(a.truncated).toBe(true);
    expect(a.items[0].model).toBe("piece0.rwx");
    expect(a.items.at(-1)?.model).toBe("piece499.rwx");
    expect(a.items.find((entry) => entry.model === "piece1.rwx")?.usage).toBe(
      2,
    );
  });
  it("bounds scanning separately and reports unscanned objects without calling them malformed", () => {
    const objects = Array(MODEL_LIBRARY_LIMITS.scanObjects + 1).fill({
      model: "column",
    });
    objects[objects.length - 1] = { model: "../ignored-after-cap" };
    const catalog = buildModelCatalog(objects);
    expect(catalog.items[0].usage).toBe(MODEL_LIBRARY_LIMITS.scanObjects);
    expect(catalog).toMatchObject({
      ignored: 0,
      truncated: true,
      unscanned: 1,
    });
  });
  it("does not retain mutable caller references or crash on sparse property arrays", () => {
    const objects = [{ model: "column" }],
      catalog = buildModelCatalog(objects);
    objects[0].model = "tree";
    expect(catalog.items[0].model).toBe("column");
    expect(buildModelCatalog(Array(2)).ignored).toBe(2);
  });
});

describe("scoped model favorites and recents", () => {
  it("reads missing state without writing and returns detached saved preferences", () => {
    const store = memory();
    expect(loadModelLibrary(studio, store.storage)).toEqual({
      ok: true,
      value: { favorites: [], recent: [] },
    });
    expect(store.storage.setItem).not.toHaveBeenCalled();
    const preferences = {
      favorites: ["wayfarer:tree"],
      recent: ["column.zip"],
    };
    expect(saveModelLibrary(studio, preferences, store.storage).ok).toBe(true);
    preferences.favorites.length = 0;
    expect(loadModelLibrary(studio, store.storage)).toEqual({
      ok: true,
      value: { favorites: ["wayfarer:tree"], recent: ["column"] },
    });
  });
  it.each([
    studio,
    { ...world, host: "another.example" },
    { ...world, port: 16671 },
    { ...world, tls: true },
    { ...world, world: "Other" },
    { ...world, objectPath: "http://127.0.0.1:17400/other/" },
  ])("isolates library scope %j", (other) => {
    const store = memory();
    setModelFavorite(world, "column", true, store.storage);
    expect(key(other as ModelLibraryScope)).not.toBe(key());
    expect(loadModelLibrary(other as ModelLibraryScope, store.storage)).toEqual(
      { ok: true, value: { favorites: [], recent: [] } },
    );
  });
  it("normalizes endpoint/world casing, URL defaults and directory slashes without losing path case", () => {
    expect(
      key({
        ...world,
        host: "LOCALHOST.",
        world: " haven ",
        objectPath: "http://assets.example:80/Path",
      }),
    ).toBe(
      key({
        ...world,
        host: "localhost",
        world: "Haven",
        objectPath: "http://assets.example/Path/",
      }),
    );
    expect(
      key({ ...world, objectPath: "http://assets.example/Path/" }),
    ).not.toBe(key({ ...world, objectPath: "http://assets.example/path/" }));
    expect(key({ ...world, host: "[::1]" })).toBe(
      key({ ...world, host: "::1" }),
    );
  });
  it.each([
    { ...world, password: "secret" },
    { ...world, username: "person" },
    { ...world, objectPath: "http://name:secret@assets.example/" },
    { ...world, objectPath: "https://assets.example/?token=secret" },
    { ...world, objectPath: "https://assets.example/#secret" },
    { ...world, objectPath: "file:///private/path" },
    { ...world, objectPath: "javascript:alert(1)" },
    { ...world, host: "name:secret@host" },
    { ...world, host: "[" },
    { ...world, host: "host:16670" },
    { ...world, world: "" },
    { ...world, port: 0 },
    { ...studio, credentials: "secret" },
  ])("rejects malformed or secret-bearing scope %j", (invalid) => {
    const store = memory();
    expect(
      setModelFavorite(
        invalid as ModelLibraryScope,
        "column",
        true,
        store.storage,
      ).ok,
    ).toBe(false);
    expect(store.storage.setItem).not.toHaveBeenCalled();
  });
  it("toggles normalized favorites without duplicates and preserves recent history", () => {
    const store = memory();
    rememberModel(world, "tree", store.storage);
    setModelFavorite(world, "Column.zip", true, store.storage);
    setModelFavorite(world, "Column", true, store.storage);
    expect(loadModelLibrary(world, store.storage)).toEqual({
      ok: true,
      value: { favorites: ["Column"], recent: ["tree"] },
    });
    expect(setModelFavorite(world, "Column", false, store.storage)).toEqual({
      ok: true,
      value: { favorites: [], recent: ["tree"] },
    });
  });
  it("refuses a 65th favorite without evicting existing favorites", () => {
    const store = memory(),
      favorites = Array.from({ length: 64 }, (_, i) => `piece${i}.rwx`);
    expect(
      saveModelLibrary(world, { favorites, recent: [] }, store.storage).ok,
    ).toBe(true);
    const prior = store.values.get(key());
    expect(
      setModelFavorite(world, "another", true, store.storage),
    ).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    expect(store.values.get(key())).toBe(prior);
  });
  it("tracks most-recent-first choices and deliberately rotates only its bounded recent list", () => {
    const store = memory();
    setModelFavorite(world, "favorite", true, store.storage);
    for (let i = 0; i < 40; i++)
      rememberModel(world, `piece${i}`, store.storage);
    const latest = rememberModel(world, "piece20.zip", store.storage);
    expect(latest.ok && latest.value.recent).toHaveLength(32);
    expect(latest.ok && latest.value.recent[0]).toBe("piece20");
    expect(latest.ok && latest.value.recent.at(-1)).toBe("piece8");
    expect(latest.ok && latest.value.favorites).toEqual(["favorite"]);
  });
  it.each([
    "{broken",
    "",
    '{"format":"wayfarer-model-library","version":99}',
    " ".repeat(65_537),
  ])(
    "never overwrites corrupt, oversized or unsupported saved bytes",
    (corrupt) => {
      const store = memory();
      store.values.set(key(), corrupt);
      expect(loadModelLibrary(world, store.storage)).toMatchObject({
        ok: false,
        error: { code: "corrupt-storage" },
      });
      expect(
        setModelFavorite(world, "column", true, store.storage),
      ).toMatchObject({ ok: false, error: { code: "corrupt-storage" } });
      expect(rememberModel(world, "tree", store.storage).ok).toBe(false);
      expect(store.values.get(key())).toBe(corrupt);
      expect(store.storage.setItem).not.toHaveBeenCalled();
    },
  );
  it("refuses saved scope mismatch and unknown model refs instead of quietly dropping data", () => {
    const store = memory();
    saveModelLibrary(
      studio,
      { favorites: ["wayfarer:tree"], recent: [] },
      store.storage,
    );
    store.values.set(key(), store.values.get(key(studio))!);
    expect(loadModelLibrary(world, store.storage)).toMatchObject({
      ok: false,
      error: { code: "corrupt-storage" },
    });
    const raw = JSON.parse(store.values.get(key(studio))!);
    raw.favorites = ["wayfarer:unimplemented"];
    store.values.set(key(studio), JSON.stringify(raw));
    expect(loadModelLibrary(studio, store.storage)).toMatchObject({
      ok: false,
      error: { code: "corrupt-storage" },
    });
  });
  it("rejects invalid state, duplicate aliases, sparse arrays and hidden credentials before writing", () => {
    const store = memory();
    for (const state of [
      { favorites: ["column", "column.zip"], recent: [] },
      { favorites: Array(1), recent: [] },
      { favorites: ["https://elsewhere/model.rwx"], recent: [] },
      { favorites: [], recent: [], password: "secret" },
      { favorites: [], recent: Array(33).fill("tree") },
    ]) {
      expect(saveModelLibrary(world, state, store.storage).ok).toBe(false);
    }
    expect(store.storage.setItem).not.toHaveBeenCalled();
  });
  it("reports quota errors and preserves existing preference bytes", () => {
    const store = memory();
    setModelFavorite(world, "tree", true, store.storage);
    const prior = store.values.get(key());
    store.storage.setItem = () => {
      throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    };
    expect(rememberModel(world, "column", store.storage)).toMatchObject({
      ok: false,
      error: { code: "quota-exceeded" },
    });
    expect(store.values.get(key())).toBe(prior);
  });
  it("does not write after read failure and supports unavailable or injected browser storage", () => {
    const store = memory();
    store.storage.getItem = () => {
      throw new Error("denied");
    };
    expect(setModelFavorite(world, "tree", true, store.storage)).toMatchObject({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    expect(store.storage.setItem).not.toHaveBeenCalled();
    vi.stubGlobal("localStorage", undefined);
    expect(loadModelLibrary(studio).ok).toBe(false);
    const browser = memory();
    vi.stubGlobal("localStorage", browser.storage);
    expect(rememberModel(studio, "wayfarer:tree").ok).toBe(true);
  });
});
