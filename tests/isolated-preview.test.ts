import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientCommand } from '../src/shared/types';
import { assertPreviewAssetTarget, assertPreviewCommandTarget, assertPreviewWorldTarget, previewOptions } from '../scripts/preview-options';
import { createIsolatedPreviewAssetFetcher } from '../scripts/isolated-preview-assets';
import { isolatedPreviewFileAllowlist } from '../scripts/isolated-preview-config';

const env = { WAYFARER_PREVIEW_ISOLATED: '1', WAYFARER_PREVIEW_BRIDGE_PORT: '5184', WAYFARER_PREVIEW_ORIGIN: 'http://127.0.0.1:5183', WAYFARER_PREVIEW_ISOLATED_UNIVERSE_PORT: '26670', WAYFARER_PREVIEW_ISOLATED_WORLD_PORT: '27000', WAYFARER_PREVIEW_ISOLATED_ASSET_PORT: '27400' };
const options = previewOptions(env);
const connect = (overrides = {}): ClientCommand => ({ type: 'connect', options: { host: '127.0.0.1', port: 26670, tls: false, world: 'Haven', username: 'Isolated', password: 'local-only', ...overrides } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('isolated preview development file scope', () => {
  it('does not expose project/runtime roots or primary/private isolated files', () => {
    const root = '/project', fixture = '/project/.runtime/axis-isolated-AbC123';
    const allow = isolatedPreviewFileAllowlist(root, fixture);
    expect(allow).toEqual(['/project/src', '/project/public', '/project/node_modules', '/project/index.html', '/project/package.json', fixture + '/vite-cache']);
    for (const secret of ['/project/.env', '/project/.runtime/axis/universe/appsettings.yml', fixture + '/manifest.json', fixture + '/universe/appsettings.yml', fixture + '/reports/integration.json'])
      expect(allow.some(path => secret === path || secret.startsWith(path + '/'))).toBe(false);
  });
  it.each(['/project', '/project/.runtime', '/project/.runtime/axis', '/elsewhere/axis-isolated-AbC123', '/project/.runtime/axis-isolated-AbC123/child'])('refuses broad/non-owned cache parent %s', fixture => {
    expect(() => isolatedPreviewFileAllowlist('/project', fixture)).toThrow();
  });
});

describe('isolated preview endpoint scope', () => {
  it('allows only the new UI origin and explicit new endpoints', () => {
    expect([...options.allowedOrigins]).toEqual(['http://127.0.0.1:5183']);
    expect(options.isolation).toEqual({ universePort: 26670, worldPort: 27000, assetPort: 27400 });
    expect(() => assertPreviewCommandTarget(connect(), options)).not.toThrow();
    expect(assertPreviewAssetTarget('http://127.0.0.1:27400/models/arch.rwx', options)).toBe('http://127.0.0.1:27400/models/arch.rwx');
  });
  it.each(Object.keys(env))('fails closed if isolated configuration omits %s', key => {
    const partial: Record<string, string> = { ...env }; delete partial[key]; expect(() => previewOptions(partial)).toThrow();
  });
  it.each(['0', 'true', 'yes', ''])('rejects ambiguous opt-in values %s', value => {
    expect(() => previewOptions({ ...env, WAYFARER_PREVIEW_ISOLATED: value })).toThrow();
  });
  it.each([16670, 17000, 17400, 5173, 5174, 4173, 5183, 5184, 27000, 27400])('rejects primary or conflicting isolated Universe port %s', port => {
    expect(() => previewOptions({ ...env, WAYFARER_PREVIEW_ISOLATED_UNIVERSE_PORT: String(port) })).toThrow();
  });
  it.each([{ port: 16670 }, { port: 17000 }, { port: 17400 }, { host: 'localhost' }, { host: '127.0.0.2' }, { host: 'universe.example' }, { tls: true }])('blocks saved/remote connection target %s', overrides => {
    expect(() => assertPreviewCommandTarget(connect(overrides), options)).toThrow(/own loopback test Universe/);
  });
  it.each(['http://127.0.0.1:17400/models/arch.rwx', 'http://127.0.0.1:16670/', 'http://localhost:27400/models/arch.rwx', 'https://127.0.0.1:27400/models/arch.rwx', 'https://objects.example/a.rwx', 'http://127.0.0.1:27400/models/a?token=x', 'http://127.0.0.1:27400/models/a#fragment', 'http://user:password@127.0.0.1:27400/models/a'])('blocks asset target %s', url => {
    expect(() => assertPreviewAssetTarget(url, options)).toThrow();
  });
  it('does not restrict ordinary preview endpoints without explicit isolation', () => {
    const ordinary = previewOptions({}); expect(ordinary.isolation).toBeNull();
    expect(() => assertPreviewCommandTarget(connect({ host: 'universe.example', port: 6670, tls: true }), ordinary)).not.toThrow();
    expect(assertPreviewAssetTarget('https://objects.example/a.rwx', ordinary)).toBe('https://objects.example/a.rwx');
  });
  it('leaves non-connection commands subject to normal protocol validation', () => {
    expect(() => assertPreviewCommandTarget({ type: 'disconnect' }, options)).not.toThrow();
  });
  it('allows only the exact independently assigned World transport after lookup', () => {
    expect(() => assertPreviewWorldTarget({ host: '127.0.0.1', port: 27000, tls: false }, options)).not.toThrow();
    for (const override of [{ port: 17000 }, { port: 26670 }, { host: 'elsewhere.example' }, { host: 'localhost' }, { tls: true }])
      expect(() => assertPreviewWorldTarget({ host: '127.0.0.1', port: 27000, tls: false, ...override }, options)).toThrow(/own loopback test World/);
  });
});

describe('bounded isolated-only asset requests', () => {
  it('refuses to create an isolated fetcher without a complete isolation scope', () => {
    expect(() => createIsolatedPreviewAssetFetcher(previewOptions({}))).toThrow();
  });
  it('rejects disallowed input without calling fetch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(createIsolatedPreviewAssetFetcher(options)('http://127.0.0.1:17400/models/arch.rwx')).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it('uses no cookies and refuses redirects at the fetch layer', async () => {
    const fetch = vi.fn(async () => new Response('original', { headers: { 'content-type': 'text/plain; charset=utf-8' } })); vi.stubGlobal('fetch', fetch);
    const result = await createIsolatedPreviewAssetFetcher(options)('http://127.0.0.1:27400/models/arch.rwx');
    expect(new TextDecoder().decode(result.bytes)).toBe('original'); expect(result.contentType).toBe('text/plain');
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:27400/models/arch.rwx', expect.objectContaining({ redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal) }));
  });
  it('cancels an unexpected redirect response and never requests its Location', async () => {
    const response = new Response('moved', { status: 302, headers: { location: 'http://127.0.0.1:17400/private' } });
    const cancel = vi.spyOn(response.body!, 'cancel'); const fetch = vi.fn(async () => response); vi.stubGlobal('fetch', fetch);
    await expect(createIsolatedPreviewAssetFetcher(options)('http://127.0.0.1:27400/models/arch.rwx')).rejects.toThrow(/302/);
    expect(fetch).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels rejected HTTP bodies and oversized declared lengths', async () => {
    for (const response of [new Response('no', { status: 404 }), new Response('oversize', { headers: { 'content-length': '1000001' } })]) {
      const cancel = vi.spyOn(response.body!, 'cancel'); vi.stubGlobal('fetch', vi.fn(async () => response));
      await expect(createIsolatedPreviewAssetFetcher(options)('http://127.0.0.1:27400/models/arch.rwx')).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce();
    }
  });
  it('enforces streaming size limits even when Content-Length is absent', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1_000_001)); }, cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream)));
    await expect(createIsolatedPreviewAssetFetcher(options)('http://127.0.0.1:27400/models/arch.rwx')).rejects.toThrow(/1 MB/); expect(cancel).toHaveBeenCalledOnce();
  });
  it('bounds active requests and releases slots after failure', async () => {
    const releases: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => releases.push(resolve))));
    const fetcher = createIsolatedPreviewAssetFetcher(options), url = 'http://127.0.0.1:27400/models/arch.rwx';
    const requests = Array.from({ length: 16 }, () => fetcher(url));
    await expect(fetcher(url)).rejects.toThrow(/limit/);
    releases.splice(0).forEach(release => release(new Response('no', { status: 404 })));
    expect((await Promise.allSettled(requests)).every(result => result.status === 'rejected')).toBe(true);
    const next = fetcher(url); releases[0](new Response('ok')); expect(new TextDecoder().decode((await next).bytes)).toBe('ok');
  });
});
