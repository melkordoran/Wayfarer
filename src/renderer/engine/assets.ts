import { strFromU8 } from 'fflate';
import { decompressDirectX } from './directx-compression';
import { boundedUnzip } from './zip';

export type AssetFetcher = (url: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
const MODEL_ASSET_LIMIT = 30_000_000;
const MODEL_ARCHIVE_ENTRIES = 1024;

/** Explicit extensions select one format; legacy names try compressed, RWX, then X. */
export function modelAssetNames(name: string): string[] {
  const extension = /\.(rwx|x|zip)$/i.exec(name)?.[1].toLowerCase();
  const stem = extension ? name.slice(0, -(extension.length + 1)) : name;
  if (!stem || /\.(?:cob|cav|awcav)$/i.test(name)) throw new Error('Only RWX and DirectX .x model geometry is supported; CAV and COB are not supported');
  const formats = extension === 'rwx' ? ['.rwx'] : extension === 'x' ? ['.x'] : ['.rwx', '.x'];
  return ['.zip', ...formats].map(suffix => stem + suffix);
}

export function assetUrls(objectPath: string, name: string, folder: 'models' | 'textures'): string[] {
  if (!name) return [];
  if (/^https?:\/\//i.test(name)) return [name];
  if (!objectPath) return [];
  // Model names are relative to the world's object path, never filesystem paths.
  const clean = name.replace(/\\/g, '/').split('/').pop() ?? '';
  if (!clean || clean === '.' || clean === '..') return [];
  const base = objectPath.replace(/\/?$/, '/');
  if (folder === 'models') return modelAssetNames(clean).map(filename => new URL(`models/${encodeURIComponent(filename)}`, base).href);
  const stem = clean.replace(/\.(?:rwx|zip|jpg|jpeg|png|bmp|gif)$/i, '');
  const extensions = ['.jpg', '.png', '.zip', '.bmp', '.gif'];
  if (/\.(?:jpg|jpeg|png|bmp|gif)$/i.test(clean)) extensions.unshift(clean.slice(stem.length));
  return [...new Set(extensions)].map(extension => new URL(`${folder}/${encodeURIComponent(stem + extension)}`, base).href);
}

export function unpackAsset(bytes: Uint8Array, kind: 'model' | 'texture', requestedName?: string): { bytes: Uint8Array; filename?: string } {
  if (bytes.length > 30_000_000) throw new Error('Asset exceeds the 30 MB download limit');
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { bytes };
  if (kind === 'model') return unpackModelArchive(bytes, requestedName);
  let acceptedSize = 0;
  const files = boundedUnzip(bytes, { maxBytes: MODEL_ASSET_LIMIT, maxEntries: MODEL_ARCHIVE_ENTRIES, filter: file => {
    const matches = /\.(png|jpe?g|bmp|gif)$/i.test(file.name);
    if (!matches || file.originalSize > 30_000_000 || acceptedSize + file.originalSize > 30_000_000) return false;
    acceptedSize += file.originalSize;
    return true;
  } });
  const filename = Object.keys(files).sort()[0];
  if (!filename) throw new Error(`Archive contains no supported ${kind}`);
  return { bytes: files[filename], filename };
}

export function decodeRwx(bytes: Uint8Array): string {
  const asset = unpackAsset(bytes, 'model');
  if (/\.x$/i.test(asset.filename ?? '') || isDirectXHeader(asset.bytes)) throw new Error('DirectX .x geometry requires the DirectX model loader');
  return strFromU8(asset.bytes).replace(/^\uFEFF/, '');
}

function modelBasename(name: string): string {
  if (/^https?:\/\//i.test(name)) {
    try { name = decodeURIComponent(new URL(name).pathname); }
    catch { throw new Error('Invalid model asset URL'); }
  }
  return name.replace(/\\/g, '/').split('/').pop() ?? '';
}

function modelFormat(name: string | undefined): 'rwx' | 'x' | undefined {
  return name ? /\.(rwx|x)$/i.exec(modelBasename(name))?.[1].toLowerCase() as 'rwx' | 'x' | undefined : undefined;
}

function unpackModelArchive(bytes: Uint8Array, requestedName?: string): { bytes: Uint8Array; filename: string } {
  const requested = requestedName ? modelBasename(requestedName) : undefined;
  const wanted = requested ? new Set(modelAssetNames(requested).filter(name => /\.(?:rwx|x)$/i.test(name)).map(name => name.toLowerCase())) : undefined;
  let entries = 0, total = 0;
  const names = new Set<string>();
  const files = boundedUnzip(bytes, { maxBytes: MODEL_ASSET_LIMIT, maxEntries: MODEL_ARCHIVE_ENTRIES, filter: entry => {
    if (++entries > MODEL_ARCHIVE_ENTRIES) throw new Error('Model archive exceeds 1024 entries');
    const path = entry.name;
    // Names are never extracted to disk, but rejecting path tricks avoids ambiguous
    // cross-platform selection and future accidental traversal at this boundary.
    if (!path || path.length > 1024 || /[\\:\u0000]/.test(path) || path.startsWith('/') || path.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid path in model archive');
    const folded = path.toLowerCase();
    if (names.has(folded)) throw new Error('Duplicate filename in model archive');
    names.add(folded);
    if (!/\.(?:rwx|x)$/i.test(path) || (wanted && !wanted.has(modelBasename(path).toLowerCase()))) return false;
    if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > MODEL_ASSET_LIMIT || (total += entry.originalSize) > MODEL_ASSET_LIMIT) throw new Error('Model archive exceeds expanded size limit');
    return true;
  } });
  const matches = Object.keys(files);
  if (!matches.length) throw new Error(requested ? 'Archive contains no supported model matching the requested basename and format' : 'Archive contains no supported model');
  if (matches.length !== 1) throw new Error('Model archive is ambiguous: expected exactly one matching model');
  const filename = matches[0];
  if (files[filename].byteLength > MODEL_ASSET_LIMIT) throw new Error('Model archive exceeds expanded size limit');
  return { bytes: files[filename], filename };
}

/** Bounded streaming GZIP decoding also validates CRC and concatenated members. */
async function decompressModelGzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (bytes.length < 18) throw new Error('Truncated model GZIP');
  if (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 4, true) > MODEL_ASSET_LIMIT) throw new Error('Model GZIP exceeds expanded size limit');
  const reader = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      if ((total += value.byteLength) > MODEL_ASSET_LIMIT) throw new Error('Model GZIP exceeds expanded size limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export function isDirectXHeader(bytes: Uint8Array): boolean {
  return bytes[0] === 0x78 && bytes[1] === 0x6f && bytes[2] === 0x66 && bytes[3] === 0x20;
}

export type DecodedModelAsset =
  | { format: 'rwx'; source: string; filename?: string }
  | { format: 'x'; source: Uint8Array; filename?: string };

/** Unwraps at most GZIP -> ZIP -> geometry. Never guesses X from its filename alone.
 * requestedName constrains ZIP selection; sourceName is the actual fetched URL and
 * constrains raw fallback responses, so an .rwx response cannot disguise .x data.
 */
export async function decodeModelAsset(bytes: Uint8Array, requestedName?: string, sourceName?: string): Promise<DecodedModelAsset> {
  if (bytes.byteLength > MODEL_ASSET_LIMIT) throw new Error('Model asset exceeds the 30 MB download limit');
  const unpacked = unpackAsset(await decompressModelGzip(bytes), 'model', requestedName);
  const format = isDirectXHeader(unpacked.bytes) ? 'x' : 'rwx';
  const expected = modelFormat(requestedName), actual = modelFormat(unpacked.filename ?? sourceName);
  if ((expected && expected !== format) || (actual && actual !== format)) throw new Error('Model filename/header format mismatch');
  if (format === 'x') {
    return { format, source: decompressDirectX(unpacked.bytes), filename: unpacked.filename };
  }
  if (unpacked.bytes.includes(0)) throw new Error('Model is not supported text RWX or headered DirectX geometry');
  return { format, source: strFromU8(unpacked.bytes).replace(/^\uFEFF/, ''), filename: unpacked.filename };
}

/** A small queue keeps entering large worlds from spawning thousands of simultaneous requests. */
export class AssetQueue {
  private active = 0;
  private pending: Array<() => void> = [];
  constructor(private concurrency = 6) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>(resolve => this.pending.push(resolve));
    else this.active++;
    try { return await task(); }
    finally {
      const next = this.pending.shift();
      if (next) next(); // Transfer the existing slot directly to the next waiter.
      else this.active--;
    }
  }
}

export async function firstAvailable(fetcher: AssetFetcher, urls: string[]): Promise<{ bytes: Uint8Array; contentType: string; url: string }> {
  let lastError: unknown;
  for (const url of urls) {
    try { const asset = await fetcher(url); return { ...asset, bytes: new Uint8Array(asset.bytes), url }; }
    catch (error) { lastError = error; }
  }
  throw lastError ?? new Error('World has no valid object path');
}
