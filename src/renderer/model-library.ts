import type { WorldObject } from "../shared/types";

export const MODEL_LIBRARY_LIMITS = Object.freeze({
  catalog: 500,
  scanObjects: 100_000,
  favorites: 64,
  recent: 32,
  modelCharacters: 255,
  fileBytes: 64 * 1024,
});
export type ModelLibraryScope =
  | { kind: "studio" }
  | {
      kind: "world";
      host: string;
      port: number;
      tls: boolean;
      world: string;
      objectPath: string;
    };
export interface ModelLibraryState {
  favorites: string[];
  recent: string[];
}
export interface ModelLibraryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface ModelReference {
  model: string;
  displayName: string;
  kind: "builtin" | "auto" | "rwx" | "x";
}
export interface ModelCatalogEntry extends ModelReference {
  usage: number;
}
export interface ModelCatalog {
  items: ModelCatalogEntry[];
  ignored: number;
  truncated: boolean;
  unscanned: number;
}
export type ModelLibraryErrorCode =
  | "invalid-model"
  | "invalid-scope"
  | "invalid-library"
  | "unsupported-version"
  | "limit-exceeded"
  | "corrupt-storage"
  | "storage-unavailable"
  | "quota-exceeded";
export type ModelLibraryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ModelLibraryErrorCode; message: string } };

/** The actual implemented makeDemoModel cases, not its generic unknown-shape fallback. */
export const ORIGINAL_MODEL_NAMES = Object.freeze(
  [
    "arch",
    "bench",
    "column",
    "cube",
    "fountain",
    "gallery",
    "lamp",
    "landscape",
    "obelisk",
    "pavilion",
    "planter",
    "plaza",
    "rock",
    "sign",
    "tree",
  ].map((name) => `wayfarer:${name}`),
);
const originals = new Set(ORIGINAL_MODEL_NAMES);
const encoder = new TextEncoder();
const collator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
class Invalid extends Error {
  constructor(
    readonly code: ModelLibraryErrorCode,
    message: string,
  ) {
    super(message);
  }
}
const fail = <T>(
  code: ModelLibraryErrorCode,
  message: string,
): ModelLibraryResult<T> => ({ ok: false, error: { code, message } });
function attempt<T>(task: () => T): ModelLibraryResult<T> {
  try {
    return { ok: true, value: task() };
  } catch (error) {
    return error instanceof Invalid
      ? fail(error.code, error.message)
      : fail("invalid-library", "The model library contains invalid data.");
  }
}
function plain(
  value: unknown,
  keys: string[],
  code: ModelLibraryErrorCode,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Invalid(
      code,
      "Only supported plain fields may be stored in the model library.",
    );
  return value as Record<string, unknown>;
}
function checkedString(
  value: unknown,
  label: string,
  maximum: number,
  code: ModelLibraryErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Invalid(code, `Invalid ${label}.`);
  return value;
}
function reference(value: unknown): ModelReference {
  const clean = checkedString(
    value,
    "model reference",
    MODEL_LIBRARY_LIMITS.modelCharacters,
    "invalid-model",
  ).trim();
  if (originals.has(clean))
    return {
      model: clean,
      displayName: clean
        .slice(9)
        .replace(/^./, (letter) => letter.toUpperCase()),
      kind: "builtin",
    };
  // Explicit extensions retain format; bare/ZIP aliases retain automatic lookup.
  // Never lowercase the stem: an HTTP object path may be case-sensitive.
  // Deliberately narrower than the loader: URLs and path-flattening are not saved aliases.
  if (
    !/^[a-z0-9][a-z0-9_.-]*$/i.test(clean) ||
    clean.includes("..") ||
    clean.endsWith(".")
  )
    throw new Invalid(
      "invalid-model",
      "Use an original wayfarer: model or a plain RWX/DirectX model name, without a URL, path or traversal.",
    );
  const kind = /\.x$/i.test(clean)
    ? "x"
    : /\.rwx$/i.test(clean)
      ? "rwx"
      : "auto";
  const stem = clean.replace(/\.(?:rwx|zip|x)$/i, "");
  if (/\.(?:x|cav|seq|bvh)$/i.test(stem))
    throw new Invalid(
      "invalid-model",
      "CAV and SEQ/BVH motion files are not geometry models; use a plain RWX or DirectX X model name.",
    );
  if (!stem || stem.endsWith(".") || /\.(?:jpg|jpeg|png|bmp|gif)$/i.test(stem))
    throw new Invalid(
      "invalid-model",
      "Choose a model reference, not a texture file.",
    );
  const model = kind === "auto" ? stem : `${stem}.${kind}`;
  if (model.length > MODEL_LIBRARY_LIMITS.modelCharacters)
    throw new Invalid(
      "invalid-model",
      "The normalized model name exceeds 255 characters.",
    );
  return {
    model,
    displayName: stem
      .replace(/[-_]+/g, " ")
      .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase()),
    kind,
  };
}
export function normalizeModelRef(
  value: unknown,
): ModelLibraryResult<ModelReference> {
  return attempt(() => reference(value));
}
function compare(a: ModelReference, b: ModelReference): number {
  return (
    collator.compare(a.displayName, b.displayName) ||
    (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)
  );
}

/** Loaded property references only. No HTTP fetch, file listing or invented live-world catalog. */
export function buildModelCatalog(
  objects: readonly Pick<WorldObject, "model">[],
  options: { includeBuiltins?: boolean } = {},
): ModelCatalog {
  const items = new Map<string, ModelCatalogEntry>();
  let ignored = 0,
    truncated = false;
  const scanned = Math.min(objects.length, MODEL_LIBRARY_LIMITS.scanObjects);
  function add(model: ModelReference, usage: number) {
    const known = items.get(model.model);
    if (known) {
      known.usage += usage;
      return;
    }
    if (items.size >= MODEL_LIBRARY_LIMITS.catalog) {
      truncated = true;
      // Keep the first 500 sorted references, independently of property packet order.
      let last: ModelCatalogEntry | undefined;
      for (const entry of items.values())
        if (!last || compare(entry, last) > 0) last = entry;
      if (!last || compare(model, last) >= 0) return;
      items.delete(last.model);
    }
    items.set(model.model, { ...model, usage });
  }
  if (options.includeBuiltins)
    for (const model of ORIGINAL_MODEL_NAMES) add(reference(model), 0);
  for (let index = 0; index < scanned; index++) {
    const raw = objects[index];
    const normalized = normalizeModelRef(
      raw && typeof raw === "object" ? raw.model : undefined,
    );
    if (!normalized.ok) {
      ignored++;
      continue;
    }
    add(normalized.value, 1);
  }
  const unscanned = Math.max(0, objects.length - scanned);
  return {
    items: [...items.values()].sort(compare),
    ignored,
    truncated: truncated || unscanned > 0,
    unscanned,
  };
}

function scope(value: unknown): ModelLibraryScope {
  const kind =
    value && typeof value === "object" && "kind" in value
      ? value.kind
      : undefined;
  if (kind === "studio") {
    plain(value, ["kind"], "invalid-scope");
    return { kind: "studio" };
  }
  const raw = plain(
    value,
    ["kind", "host", "port", "tls", "world", "objectPath"],
    "invalid-scope",
  );
  if (raw.kind !== "world")
    throw new Invalid(
      "invalid-scope",
      "Choose a studio or a specific universe/world model library.",
    );
  let host = checkedString(raw.host, "universe host", 253, "invalid-scope")
    .trim()
    .toLowerCase();
  if (!host || !/^[a-z0-9_.:[\]-]+$/.test(host) || host.includes(".."))
    throw new Invalid(
      "invalid-scope",
      "Use a universe hostname or IP address without credentials or a URL.",
    );
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  try {
    const endpoint = new URL(
      `http://${host.includes(":") ? `[${host}]` : host}/`,
    );
    host = endpoint.hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new Invalid(
      "invalid-scope",
      "The universe hostname or IP address is malformed.",
    );
  }
  if (
    !host ||
    typeof raw.port !== "number" ||
    !Number.isInteger(raw.port) ||
    raw.port < 1 ||
    raw.port > 65535 ||
    typeof raw.tls !== "boolean"
  )
    throw new Invalid("invalid-scope", "Invalid universe endpoint.");
  const world = checkedString(raw.world, "world name", 64, "invalid-scope")
    .trim()
    .toLowerCase();
  if (!world)
    throw new Invalid(
      "invalid-scope",
      "A world name is required to scope its model library.",
    );
  const path = checkedString(
    raw.objectPath,
    "world object path",
    2048,
    "invalid-scope",
  ).trim();
  let objectPath = "";
  if (path) {
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      throw new Invalid(
        "invalid-scope",
        "The world object path is not a valid URL.",
      );
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Invalid(
        "invalid-scope",
        "Model-library scope cannot contain credentials, URL query parameters or fragments.",
      );
    url.pathname = url.pathname.replace(/\/?$/, "/");
    objectPath = url.href;
  }
  return {
    kind: "world",
    host,
    port: raw.port,
    tls: raw.tls,
    world,
    objectPath,
  };
}
function keyFor(identity: ModelLibraryScope): string {
  // Reversible encoding of a validated non-secret tuple avoids weak-hash collisions.
  const tuple =
    identity.kind === "studio"
      ? ["studio"]
      : [
          "world",
          identity.host,
          identity.port,
          identity.tls,
          identity.world,
          identity.objectPath,
        ];
  return `wayfarer:model-library-v1:${encodeURIComponent(JSON.stringify(tuple))}`;
}
export function modelLibraryKey(
  identity: ModelLibraryScope,
): ModelLibraryResult<string> {
  return attempt(() => keyFor(scope(identity)));
}
function references(value: unknown, maximum: number, label: string): string[] {
  if (!Array.isArray(value))
    throw new Invalid(
      "invalid-library",
      `${label} must be a list of model references.`,
    );
  if (value.length > maximum)
    throw new Invalid(
      "limit-exceeded",
      `${label} can contain at most ${maximum} models.`,
    );
  const unique = new Set<string>();
  return Array.from(value, (item) => {
    const model = reference(item).model;
    if (unique.has(model))
      throw new Invalid(
        "invalid-library",
        `${label} contains duplicate model references.`,
      );
    unique.add(model);
    return model;
  });
}
function state(value: unknown): ModelLibraryState {
  const raw = plain(value, ["favorites", "recent"], "invalid-library");
  return {
    favorites: references(
      raw.favorites,
      MODEL_LIBRARY_LIMITS.favorites,
      "Favorites",
    ),
    recent: references(
      raw.recent,
      MODEL_LIBRARY_LIMITS.recent,
      "Recent models",
    ),
  };
}
interface SavedLibrary {
  format: "wayfarer-model-library";
  version: 1;
  scope: ModelLibraryScope;
  favorites: string[];
  recent: string[];
}
function encode(
  identity: ModelLibraryScope,
  library: ModelLibraryState,
): string {
  const json = JSON.stringify({
    format: "wayfarer-model-library",
    version: 1,
    scope: identity,
    ...library,
  });
  if (
    json.length > MODEL_LIBRARY_LIMITS.fileBytes ||
    encoder.encode(json).byteLength > MODEL_LIBRARY_LIMITS.fileBytes
  )
    throw new Invalid(
      "limit-exceeded",
      "The saved model library exceeds 64 KB.",
    );
  return json;
}
function decode(json: string): SavedLibrary {
  if (
    typeof json !== "string" ||
    json.length > MODEL_LIBRARY_LIMITS.fileBytes ||
    encoder.encode(json).byteLength > MODEL_LIBRARY_LIMITS.fileBytes
  )
    throw new Invalid(
      "limit-exceeded",
      "The saved model library exceeds its file limit.",
    );
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    throw new Invalid(
      "invalid-library",
      "The saved model library is not valid JSON.",
    );
  }
  const raw = plain(
    decoded,
    ["format", "version", "scope", "favorites", "recent"],
    "invalid-library",
  );
  if (raw.format !== "wayfarer-model-library")
    throw new Invalid(
      "invalid-library",
      "This is not a Wayfarer model library.",
    );
  if (raw.version !== 1)
    throw new Invalid(
      "unsupported-version",
      "This model library version is not supported.",
    );
  return {
    format: "wayfarer-model-library",
    version: 1,
    scope: scope(raw.scope),
    ...state({ favorites: raw.favorites, recent: raw.recent }),
  };
}
function target(
  storage?: ModelLibraryStorage,
): ModelLibraryResult<ModelLibraryStorage> {
  try {
    const selected = storage ?? globalThis.localStorage;
    if (
      !selected ||
      typeof selected.getItem !== "function" ||
      typeof selected.setItem !== "function"
    )
      throw new Error("Unavailable");
    return { ok: true, value: selected };
  } catch {
    return fail(
      "storage-unavailable",
      "Model-library storage is unavailable. You can still browse loaded models.",
    );
  }
}
function read(
  identity: ModelLibraryScope,
  storage: ModelLibraryStorage,
): ModelLibraryResult<ModelLibraryState> {
  let saved: string | null;
  try {
    saved = storage.getItem(keyFor(identity));
  } catch {
    return fail(
      "storage-unavailable",
      "Model favorites could not be read. Existing data was left untouched.",
    );
  }
  if (saved === null) return { ok: true, value: { favorites: [], recent: [] } };
  const decoded = attempt(() => decode(saved));
  if (!decoded.ok || keyFor(decoded.value.scope) !== keyFor(identity))
    return fail(
      "corrupt-storage",
      "The saved model library is corrupt, unsupported or belongs to another world. Existing bytes were preserved; favorites and recent models will not be overwritten.",
    );
  return {
    ok: true,
    value: { favorites: decoded.value.favorites, recent: decoded.value.recent },
  };
}
export function loadModelLibrary(
  identity: ModelLibraryScope,
  storage?: ModelLibraryStorage,
): ModelLibraryResult<ModelLibraryState> {
  const normalized = attempt(() => scope(identity));
  if (!normalized.ok) return normalized;
  const selected = target(storage);
  if (!selected.ok) return selected;
  return read(normalized.value, selected.value);
}
export function saveModelLibrary(
  identity: ModelLibraryScope,
  library: ModelLibraryState,
  storage?: ModelLibraryStorage,
): ModelLibraryResult<ModelLibraryState> {
  const normalized = attempt(() => ({
    identity: scope(identity),
    library: state(library),
  }));
  if (!normalized.ok) return normalized;
  const selected = target(storage);
  if (!selected.ok) return selected;
  const existing = read(normalized.value.identity, selected.value);
  if (!existing.ok) return existing;
  const json = attempt(() =>
    encode(normalized.value.identity, normalized.value.library),
  );
  if (!json.ok) return json;
  try {
    selected.value.setItem(keyFor(normalized.value.identity), json.value);
  } catch (error) {
    const name =
      error && typeof error === "object" && "name" in error
        ? error.name
        : undefined;
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    const quota =
      name === "QuotaExceededError" ||
      name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      code === 22 ||
      code === 1014;
    return fail(
      quota ? "quota-exceeded" : "storage-unavailable",
      "Model preferences could not be saved on this device. Existing preferences were left untouched.",
    );
  }
  return { ok: true, value: normalized.value.library };
}
export function setModelFavorite(
  identity: ModelLibraryScope,
  model: string,
  favorite: boolean,
  storage?: ModelLibraryStorage,
): ModelLibraryResult<ModelLibraryState> {
  const normalized = normalizeModelRef(model);
  if (!normalized.ok) return normalized;
  if (typeof favorite !== "boolean")
    return fail("invalid-library", "Choose whether this model is a favorite.");
  const loaded = loadModelLibrary(identity, storage);
  if (!loaded.ok) return loaded;
  const favorites = loaded.value.favorites.filter(
    (item) => item !== normalized.value.model,
  );
  if (favorite) favorites.push(normalized.value.model);
  favorites.sort((a, b) => compare(reference(a), reference(b)));
  return saveModelLibrary(identity, { ...loaded.value, favorites }, storage);
}
/** Most-recent-first history intentionally rotates its oldest entry at the 32-item cap. */
export function rememberModel(
  identity: ModelLibraryScope,
  model: string,
  storage?: ModelLibraryStorage,
): ModelLibraryResult<ModelLibraryState> {
  const normalized = normalizeModelRef(model);
  if (!normalized.ok) return normalized;
  const loaded = loadModelLibrary(identity, storage);
  if (!loaded.ok) return loaded;
  return saveModelLibrary(
    identity,
    {
      ...loaded.value,
      recent: [
        normalized.value.model,
        ...loaded.value.recent.filter(
          (item) => item !== normalized.value.model,
        ),
      ].slice(0, MODEL_LIBRARY_LIMITS.recent),
    },
    storage,
  );
}
