import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelPreviewSession, PREVIEW_LIMITS } from '../src/renderer/engine/model-preview';
import { createRwxGroup, disposeModelTree } from '../src/renderer/engine/rwx-mesh';
import { parseRwx } from '../src/renderer/engine/rwx';
import type { AssetFetcher } from '../src/renderer/engine/assets';

const head = 'ModelBegin\nClumpBegin\nVertex 0 0 0\nVertex 1 0 0\nVertex 0 1 0\n';
const model = head + 'Triangle 1 2 3\nClumpEnd\nModelEnd';
const textured = (count: number) => head + Array.from({ length: count }, (_, i) => `Texture tex${i}\nTriangle 1 2 3`).join('\n') + '\nClumpEnd\nModelEnd';
const bytes = (text: string) => ({ bytes: new TextEncoder().encode(text), contentType: 'text/plain' });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const sessions: ModelPreviewSession[] = [];
const session = (fetcher: AssetFetcher, update = vi.fn()) => { const value = new ModelPreviewSession(fetcher, 'https://example.test/', update); sessions.push(value); return value; };
afterEach(() => { for (const item of sessions.splice(0)) item.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('preview cancellation and actual Three resource ownership', () => {
  it('does not begin a scheduled texture request after material disposal', async () => {
    const fetcher = vi.fn(async () => new THREE.Texture());
    const root = createRwxGroup(parseRwx(textured(1)), { loadTexture: fetcher }); disposeModelTree(root);
    await flush(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not run extension fallbacks after an in-flight model is cancelled', async () => {
    const download = deferred<ReturnType<typeof bytes>>(), fetcher = vi.fn(() => download.promise);
    const preview = session(fetcher), loading = preview.load('part.rwx'); await flush();
    expect(fetcher).toHaveBeenCalledTimes(1); preview.dispose();
    await expect(loading).rejects.toThrow('cancelled'); download.reject(new Error('request timed out'));
    await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('limits all sessions together to two real downloads and removes obsolete queued requests', async () => {
    const downloads: Array<ReturnType<typeof deferred<ReturnType<typeof bytes>>>> = [];
    let active = 0, maximum = 0;
    const fetcher = vi.fn<AssetFetcher>(async url => {
      active++; maximum = Math.max(maximum, active);
      try {
        if (url.includes('latest')) return bytes(model);
        const pending = deferred<ReturnType<typeof bytes>>(); downloads.push(pending); return await pending.promise;
      } finally { active--; }
    });
    const obsolete = Array.from({ length: 12 }, () => session(fetcher));
    const pending = obsolete.map((item, index) => item.load(`obsolete${index}.rwx`).catch(error => error));
    await flush(); expect(fetcher).toHaveBeenCalledTimes(2);
    obsolete.forEach(item => item.dispose());
    const latest = session(fetcher), loading = latest.load('latest.rwx'); await flush(); expect(fetcher).toHaveBeenCalledTimes(2);
    downloads[0].resolve(bytes(model)); expect((await loading).root.children).toHaveLength(1);
    downloads[1].resolve(bytes(model)); await Promise.all(pending); await flush();
    expect(maximum).toBe(2); expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([url]) => !/obsolete(?:[2-9]|1[01])/.test(url))).toBe(true);
  });
  it('caps unique textures and releases each geometry, material, texture and bitmap exactly once', async () => {
    const bitmaps: Array<{ width: number; height: number; close: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { const bitmap = { width: 16, height: 16, close: vi.fn() }; bitmaps.push(bitmap); return bitmap; }));
    const update = vi.fn(), fetcher = vi.fn<AssetFetcher>(async url => url.includes('/models/') ? bytes(textured(18)) : { bytes: new Uint8Array([1]), contentType: 'image/png' });
    const preview = session(fetcher, update), { root } = await preview.load('many.rwx');
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(18));
    const meshes = root.children as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[];
    const textures = meshes.flatMap(mesh => mesh.material.map ? [mesh.material.map] : []);
    expect(textures).toHaveLength(PREVIEW_LIMITS.textures);
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/textures/'))).toHaveLength(16);
    const disposals = [...meshes.flatMap(mesh => [vi.spyOn(mesh.geometry, 'dispose'), vi.spyOn(mesh.material, 'dispose')]), ...textures.map(texture => vi.spyOn(texture, 'dispose'))];
    preview.dispose(); preview.dispose();
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
  it('caps aggregate texture pixels and closes the rejected bitmap immediately', async () => {
    const bitmaps: Array<{ width: number; height: number; close: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { const bitmap = { width: 4096, height: 2048, close: vi.fn() }; bitmaps.push(bitmap); return bitmap; }));
    const update = vi.fn(), preview = session(async url => url.includes('/models/') ? bytes(textured(3)) : { bytes: new Uint8Array([1]), contentType: 'image/png' }, update);
    const { root } = await preview.load('large-textures.rwx'); await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(3));
    expect(root.children.filter(mesh => (mesh as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material.map)).toHaveLength(2);
    expect(bitmaps[2].close).toHaveBeenCalledTimes(1); expect(bitmaps[0].close).not.toHaveBeenCalled();
    preview.dispose(); bitmaps.forEach(bitmap => expect(bitmap.close).toHaveBeenCalledTimes(1));
  });
  it('shares one bitmap between a texture and identical mask without double disposal', async () => {
    const bitmap = { width: 16, height: 16, close: vi.fn() }, decode = vi.fn(async () => bitmap);
    vi.stubGlobal('createImageBitmap', decode);
    const update = vi.fn(), preview = session(async url => url.includes('/models/') ? bytes(model.replace('Triangle', 'Texture same mask same\nTriangle')) : { bytes: new Uint8Array([1]), contentType: 'image/png' }, update);
    const { root } = await preview.load('shared.rwx'); await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    const material = (root.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material;
    expect(material.map).toBe(material.alphaMap); expect(decode).toHaveBeenCalledTimes(1);
    const dispose = vi.spyOn(material.map!, 'dispose'); preview.dispose(); preview.dispose();
    expect(dispose).toHaveBeenCalledTimes(1); expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
  it('rejects per-image size overflow without attaching the bitmap', async () => {
    const bitmap = { width: 4097, height: 1, close: vi.fn() }; vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const update = vi.fn(), preview = session(async url => url.includes('/models/') ? bytes(textured(1)) : { bytes: new Uint8Array([1]), contentType: 'image/png' }, update);
    const { root } = await preview.load('oversize.rwx'); await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect((root.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material.map).toBeNull();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
  it('rejects the real part budget before constructing meshes or requesting textures', async () => {
    const fetcher = vi.fn(async () => bytes(textured(PREVIEW_LIMITS.parts + 1))), preview = session(fetcher);
    await expect(preview.load('many-parts.rwx')).rejects.toThrow('too detailed'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
