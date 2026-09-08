import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetUrl, assertCommand } from '../src/shared/validation';

describe('untrusted asset URLs and command boundaries', () => {
  it.each(['file:///etc/passwd', 'data:text/plain,secret', 'javascript:alert(1)', 'ftp://example.com/model.rwx', 'http://user:password@example.com/a', 'https://user@example.com/a', 'http://[bad', '', 'http://example.com/' + 'a'.repeat(8192)])('rejects unsafe or malformed asset URL %s', input => {
    expect(() => assetUrl(input)).toThrow();
  });
  it('permits explicit loopback fixture HTTP and regular HTTPS', () => {
    expect(assetUrl('http://127.0.0.1:17400/models/arch.rwx').port).toBe('17400');
    expect(assetUrl('https://assets.example.com/models/arch.zip').protocol).toBe('https:');
  });
  it.each([null, [], { type: 'launch' }, { type: 'chat', text: 'hello\0world' }, { type: 'move', position: { x: Infinity, y: 0, z: 0, yaw: 0 } }])('rejects malformed commands', command => {
    expect(() => assertCommand(command)).toThrow();
  });
  it.each(['https://example.com', 'example.com/path', 'user@example.com', '127.0.0.1\n'])('rejects hosts with URL syntax or controls', host => {
    expect(() => assertCommand({ type: 'connect', options: { host, port: 16670, username: 'Tester', password: '', tls: false } })).toThrow();
  });
  it.each([0, -1, 65536, 1.5, NaN])('rejects invalid port %s', port => {
    expect(() => assertCommand({ type: 'connect', options: { host: '127.0.0.1', port, username: 'Tester', password: '', tls: false } })).toThrow();
  });
});

describe('bounded asset retrieval', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());
  async function subject() { return (await import('../src/main/assets')).fetchAsset; }
  function streamResponse(status: number, headers: Record<string, string> = {}) {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    return { response: new Response(body, { status, headers }), cancel };
  }

  it('deduplicates simultaneous requests and omits ambient credentials', async () => {
    let complete: (response: Response) => void = () => {};
    const fetch = vi.fn((_url: string | URL | Request, _options?: RequestInit) => new Promise<Response>(resolve => { complete = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const fetchAsset = await subject();
    const first = fetchAsset('https://example.com/model.rwx');
    const second = fetchAsset('https://example.com/model.rwx');
    expect(fetch).toHaveBeenCalledTimes(1);
    complete(new Response('ModelBegin\nModelEnd', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
    expect(await first).toEqual(await second);
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'manual' });
  });

  it.each(['file:///etc/passwd', 'http://user:password@example.com/model.rwx', 'http://[bad'])('validates redirect target %s before following it', location => {
    const { response, cancel } = streamResponse(302, { location });
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    return subject().then(async fetchAsset => {
      await expect(fetchAsset('https://example.com/model.rwx')).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    });
  });

  it('stops redirect loops after four follows and cancels every discarded body', async () => {
    const cancellations: ReturnType<typeof vi.fn>[] = [];
    const fetch = vi.fn(() => {
      const { response, cancel } = streamResponse(302, { location: '/loop' }); cancellations.push(cancel); return response;
    });
    vi.stubGlobal('fetch', fetch);
    const fetchAsset = await subject();
    await expect(fetchAsset('https://example.com/model.rwx')).rejects.toThrow(/redirect limit/i);
    expect(fetch).toHaveBeenCalledTimes(5);
    for (const cancel of cancellations) expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a declared oversized response without reading it', async () => {
    const { response, cancel } = streamResponse(200, { 'content-length': String(32 * 1024 * 1024 + 1) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect((await subject())('https://example.com/large')).rejects.toThrow(/32 MB/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('enforces the byte cap when Content-Length lies and cancels the stream', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); }, cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-length': '1' } })));
    await expect((await subject())('https://example.com/large')).rejects.toThrow(/32 MB/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels unsuccessful response bodies so failed asset loads release their connection', async () => {
    const { response, cancel } = streamResponse(503);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect((await subject())('https://example.com/unavailable')).rejects.toThrow(/503/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('removes failed in-flight entries so the next request can retry', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('temporary network failure')).mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    const fetchAsset = await subject();
    await expect(fetchAsset('https://example.com/retry')).rejects.toThrow(/temporary/);
    expect(new TextDecoder().decode((await fetchAsset('https://example.com/retry')).bytes)).toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds distinct concurrent downloads while still allowing request coalescing', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetch = vi.fn(() => new Promise<Response>(resolve => resolvers.push(resolve)));
    vi.stubGlobal('fetch', fetch);
    const fetchAsset = await subject();
    const pending = Array.from({ length: 16 }, (_, i) => fetchAsset(`https://example.com/pending-${i}`));
    const coalesced = fetchAsset('https://example.com/pending-0');
    await expect(fetchAsset('https://example.com/overflow')).rejects.toThrow(/too many/i);
    expect(fetch).toHaveBeenCalledTimes(16);
    for (const resolve of resolvers) resolve(new Response('ok'));
    await Promise.all([...pending, coalesced]);
    fetch.mockResolvedValueOnce(new Response('available'));
    await expect(fetchAsset('https://example.com/after-completion')).resolves.toHaveProperty('bytes');
  });

  it('bounds the count of cached zero-byte responses and evicts least-recently-used entries', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(new Uint8Array())));
    vi.stubGlobal('fetch', fetch);
    const fetchAsset = await subject();
    for (let i = 0; i < 256; i++) await fetchAsset(`https://example.com/empty-${i}`);
    await fetchAsset('https://example.com/empty-0'); // keep this older entry in use
    await fetchAsset('https://example.com/empty-overflow');
    expect(fetch).toHaveBeenCalledTimes(257);
    await fetchAsset('https://example.com/empty-0');
    expect(fetch).toHaveBeenCalledTimes(257);
    await fetchAsset('https://example.com/empty-1');
    expect(fetch).toHaveBeenCalledTimes(258);
  });
});
