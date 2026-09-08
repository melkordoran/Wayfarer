import { assetUrl } from "../shared/validation";

const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 256;
const MAX_PENDING_ASSETS = 16;
const cache = new Map<string, { bytes: Uint8Array; contentType: string }>();
let cacheBytes = 0;
const inflight = new Map<
  string,
  Promise<{ bytes: Uint8Array; contentType: string }>
>();

/** Fetch media outside the renderer: no ambient browser cookies, bounded size and timeout. */
export async function fetchAsset(
  input: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const key = assetUrl(input).href;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  if (inflight.size >= MAX_PENDING_ASSETS)
    throw new Error(
      "Too many asset requests. Try again when downloads finish.",
    );
  const request = (async () => {
    let url = key;
    let response: Response | undefined;
    const signal = AbortSignal.timeout(20_000);
    for (let redirects = 0; redirects <= 4; redirects++) {
      response = await fetch(url, {
        signal,
        redirect: "manual",
        credentials: "omit",
        headers: { "User-Agent": "Wayfarer/0.1", Accept: "*/*" },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 4)
        throw new Error("Asset redirect limit exceeded.");
      url = assetUrl(new URL(location, url).href).href;
    }
    if (!response?.ok || !response.body) {
      await response?.body?.cancel();
      throw new Error(
        `Asset request failed (${response?.status ?? "no response"}).`,
      );
    }
    if (Number(response.headers.get("content-length")) > MAX_ASSET_BYTES) {
      await response.body.cancel();
      throw new Error("Asset exceeds the 32 MB limit.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_ASSET_BYTES) {
          await reader.cancel();
          throw new Error("Asset exceeds the 32 MB limit.");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = {
      bytes,
      contentType:
        response.headers.get("content-type")?.split(";")[0] ||
        "application/octet-stream",
    };
    while (
      (cacheBytes + length > MAX_CACHE_BYTES ||
        cache.size >= MAX_CACHE_ENTRIES) &&
      cache.size
    ) {
      const oldest = cache.keys().next().value!;
      cacheBytes -= cache.get(oldest)!.bytes.byteLength;
      cache.delete(oldest);
    }
    cache.set(key, result);
    cacheBytes += length;
    return result;
  })();
  inflight.set(key, request);
  try {
    return await request;
  } finally {
    inflight.delete(key);
  }
}
