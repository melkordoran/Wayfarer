/** Fixed caller-authorized QA URLs, no redirects or ambient credentials. */
export function createScopedAssetFetcher(authorize: (input: string) => string) {
  let pending = 0;
  return async (input: string): Promise<{ bytes: Uint8Array; contentType: string }> => {
    const url = authorize(input);
    if (pending >= 16) throw new Error('Isolated asset request limit reached.');
    pending++;
    try {
      const response = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000), headers: { Accept: '*/*', 'User-Agent': 'Wayfarer-Isolated-QA' } });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Isolated asset request failed (' + response.status + ').'); }
      if (Number(response.headers.get('content-length')) > 1_000_000) { await response.body.cancel(); throw new Error('Isolated asset exceeds the 1 MB limit.'); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1_000_000) { await reader.cancel(); throw new Error('Isolated asset exceeds the 1 MB limit.'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { bytes, contentType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream' };
    } finally { pending--; }
  };
}
