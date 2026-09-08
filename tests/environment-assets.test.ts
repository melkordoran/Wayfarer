import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { strToU8, unzipSync, unzlibSync, zipSync } from 'fflate';
import { EnvironmentAssetSession, ENVIRONMENT_ASSET_LIMITS } from '../src/renderer/engine/environment-assets';
import type { AssetFetcher } from '../src/renderer/engine/assets';
import { originalEnvironmentPng } from './fixtures/environment/textures';

const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, 'fixtures/environment', name), 'utf8');
const sky = fixture('skybox.rwx'), ground = fixture('ground.rwx');
const bytes = (text: string) => ({ bytes: strToU8(text), contentType: 'text/plain' });
const base = 'https://objects.example/world/';
const sessions: EnvironmentAssetSession[] = [];
function session(fetcher: AssetFetcher, kind: 'skybox' | 'ground' = 'ground', update = vi.fn(), path = base) {
  const value = new EnvironmentAssetSession(fetcher, path, kind, update); sessions.push(value); return value;
}
function bitmap(width = 2, height = 2) { return { width, height, close: vi.fn() }; }
const mesh = (root: THREE.Group) => root.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
const imageBytes = () => ({ bytes: originalEnvironmentPng(), contentType: 'image/png' });
async function settled() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
afterEach(async () => { sessions.splice(0).forEach(value => value.dispose()); await settled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('original environment geometry and images', () => {
  it('generates deterministic real 2x2 PNG texture and mask bytes', () => {
    for (const mask of [false, true]) {
      const png = originalEnvironmentPng(mask);
      expect(png).toEqual(originalEnvironmentPng(mask));
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const view = new DataView(png.buffer);
      expect(view.getUint32(16)).toBe(2); expect(view.getUint32(20)).toBe(2);
      const size = view.getUint32(33);
      expect(new TextDecoder().decode(png.subarray(37, 41))).toBe('IDAT');
      expect(unzlibSync(png.subarray(41, 41 + size))).toHaveLength(18);
    }
    expect(originalEnvironmentPng()).not.toEqual(originalEnvironmentPng(true));
  });

  it('loads actual ZIP sky geometry and preserves small authored bounds, facing, UVs and materials', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap()));
    const fetcher = vi.fn<AssetFetcher>(async url => url.includes('/models/')
      ? { bytes: zipSync({ 'skybox.rwx': strToU8(sky) }), contentType: 'application/zip' } : imageBytes());
    const value = session(fetcher, 'skybox');
    const result = await value.load('skybox.rwx');
    expect(fetcher.mock.calls[0][0]).toBe(base + 'models/skybox.zip');
    expect(result.bounds.min.toArray()).toEqual([-1, -1, -1]);
    expect(result.bounds.max.toArray()).toEqual([1, 1, 1]);
    expect(result.root.position.toArray()).toEqual([0, 0, 0]);
    expect(result.root.scale.toArray()).toEqual([1, 1, 1]);
    const item = mesh(result.root);
    expect(item.geometry.getAttribute('position').count).toBe(36);
    expect(item.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(item.material.side).toBe(THREE.FrontSide);
    expect(item.material.depthWrite).toBe(true);
    expect(item.material.fog).toBe(false);
    expect(item.castShadow).toBe(false); expect(item.receiveShadow).toBe(false);
    expect(item.userData.solid).toBe(false);
    result.root.updateMatrixWorld(true);
    for (const direction of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
      const hits = new THREE.Raycaster(new THREE.Vector3(), direction).intersectObject(result.root, true);
      expect(hits.length).toBeGreaterThan(0); expect(hits[0].distance).toBeCloseTo(1);
    }
    await vi.waitFor(() => expect(item.material.alphaMap).toBeTruthy());
    expect(item.material.map).toBeTruthy();
    expect(result.warnings).toEqual([]);
  });

  it('falls back ZIP to raw RWX and retains authored ground elevation, normal, collision and lighting', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap()));
    const fetcher = vi.fn<AssetFetcher>(async url => {
      if (url.endsWith('ground.zip')) throw new Error('missing');
      return url.includes('/models/') ? bytes(ground) : imageBytes();
    });
    const { root, bounds } = await session(fetcher).load('ground');
    expect(fetcher.mock.calls.slice(0, 2).map(([url]) => url)).toEqual([base + 'models/ground.zip', base + 'models/ground.rwx']);
    expect(bounds.min.y).toBeCloseTo(.2); expect(bounds.max.y).toBeCloseTo(.2);
    expect(bounds.getSize(new THREE.Vector3()).toArray()).toEqual([60, 0, 60]);
    const item = mesh(root);
    expect(item.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(item.material.color.toArray()).toEqual([.8, .7, .5]);
    expect(item.material.fog).toBe(true); expect(item.userData.solid).toBe(true);
    expect(item.geometry.getAttribute('normal').getY(0)).toBeCloseTo(1);
    expect(root.children).toHaveLength(1); // No invented repeat grid.
    expect(root.userData.worldObject).toBeUndefined();
  });

  it('reports unsupported directives and missing textures without invented replacement geometry', async () => {
    const update = vi.fn();
    const { root, warnings } = await session(async url => {
      if (url.includes('/textures/')) throw new Error('HTTP 404');
      return bytes(ground.replace('ModelEnd', 'SomeUnsupportedDirective\nModelEnd'));
    }, 'ground', update).load('ground');
    expect(warnings).toContain('Unsupported RWX command: someunsupporteddirective');
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('Environment texture unavailable: tint.png.')])));
    expect(mesh(root).geometry.getAttribute('position').count).toBe(6);
    expect(mesh(root).material.map).toBeNull();
  });
});

describe('environment source and resource ownership', () => {
  it.each(['../sky.rwx', 'https://other.example/sky.rwx', 'folder/ground', 'wayfarer:landscape', 'world.awg', 'world.awg.zip', 'world.cav', 'world.seq', 'image.png'])('refuses unsupported or non-basename models %s without a request', async model => {
    const fetcher = vi.fn<AssetFetcher>();
    await expect(session(fetcher).load(model)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['file:///tmp/', 'https://user:password@example.test/', 'https://example.test/?token=secret', 'https://example.test/#fragment'])('rejects inappropriate object paths %s', path => {
    expect(() => session(vi.fn(), 'ground', vi.fn(), path)).toThrow();
  });

  it('rejects URL textures without navigating or fetching them', async () => {
    const fetcher = vi.fn<AssetFetcher>(async () => bytes(ground.replace('tint.png', 'https://other.example/image.png')));
    const update = vi.fn();
    await session(fetcher, 'ground', update).load('ground');
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('plain object-path filename')])));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('removes attached roots and disposes exclusively owned geometry, materials and bitmaps exactly once', async () => {
    const image = bitmap(); vi.stubGlobal('createImageBitmap', vi.fn(async () => image));
    const value = session(async url => url.includes('/models/') ? bytes(ground) : imageBytes());
    const { root } = await value.load('ground');
    const scene = new THREE.Scene(); scene.add(root);
    await vi.waitFor(() => expect(mesh(root).material.map).toBeTruthy());
    const geometry = vi.spyOn(mesh(root).geometry, 'dispose'), material = vi.spyOn(mesh(root).material, 'dispose');
    const texture = vi.spyOn(mesh(root).material.map!, 'dispose');
    value.dispose(); value.dispose();
    expect(scene.children).not.toContain(root);
    expect(geometry).toHaveBeenCalledOnce(); expect(material).toHaveBeenCalledOnce();
    expect(texture).toHaveBeenCalledOnce(); expect(image.close).toHaveBeenCalledOnce();
    await expect(value.load('another')).rejects.toThrow('no longer available');
  });

  it('does not let a canceled world load attach or start raw-model fallback after its old request settles', async () => {
    let reject!: (cause: Error) => void;
    const fetcher = vi.fn<AssetFetcher>(() => new Promise((_resolve, no) => { reject = no; }));
    const old = session(fetcher);
    const failed = expect(old.load('old')).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    old.dispose();
    const next = session(async () => bytes(ground.replace('Texture tint.png\n', '')), 'ground', vi.fn(), 'https://new.example/');
    const current = await next.load('current');
    const scene = new THREE.Scene(); scene.add(current.root);
    reject(new Error('old request failed')); await failed; await settled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(scene.children).toEqual([current.root]);
    expect(mesh(current.root).material.userData.disposed).not.toBe(true);
  });

  it('closes a late decoded bitmap and suppresses texture updates after world disposal', async () => {
    let finish!: (value: ReturnType<typeof bitmap>) => void;
    const decode = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('createImageBitmap', decode);
    const update = vi.fn(), image = bitmap();
    const old = session(async url => url.includes('/models/') ? bytes(ground) : imageBytes(), 'ground', update);
    await old.load('ground');
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    old.dispose(); finish(image);
    await vi.waitFor(() => expect(image.close).toHaveBeenCalledOnce());
    expect(update).not.toHaveBeenCalled();
  });

  it('deduplicates repeated material references without sharing ownership across sessions', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap()));
    const model = ground.replace('ClumpEnd', 'Color .2 .3 .4\nQuad 1 2 3 4\nClumpEnd');
    const fetcher = vi.fn<AssetFetcher>(async url => url.includes('/models/') ? bytes(model) : imageBytes());
    const first = session(fetcher), second = session(fetcher);
    const a = await first.load('ground'), b = await second.load('ground');
    await vi.waitFor(() => expect(mesh(a.root).material.map && mesh(b.root).material.map).toBeTruthy());
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/textures/'))).toHaveLength(2);
    expect((a.root.children[1] as THREE.Mesh).material).not.toBe(mesh(a.root).material);
    expect(((a.root.children[1] as THREE.Mesh).material as THREE.MeshStandardMaterial).map).toBe(mesh(a.root).material.map);
    expect(mesh(a.root).material.map).not.toBe(mesh(b.root).material.map);
    const untouched = vi.spyOn(mesh(b.root).material.map!, 'dispose');
    first.dispose(); expect(untouched).not.toHaveBeenCalled();
  });
});

describe('environment budgets', () => {
  it('rejects oversized downloads and empty or extreme geometry, never returning a fallback', async () => {
    const oversized = session(async () => ({ bytes: new Uint8Array(ENVIRONMENT_ASSET_LIMITS.downloadBytes + 1), contentType: '' }));
    await expect(oversized.load('too-big')).rejects.toThrow('30 MB');
    await expect(session(async () => bytes('ModelBegin\nModelEnd')).load('empty')).rejects.toThrow('no finite supported geometry');
    await expect(session(async () => bytes(ground.replace('Translate 0 .02 0', 'Translate 999999999 0 0'))).load('extreme')).rejects.toThrow('coordinates');
  });

  it('enforces parser work and post-parse material-part bounds', async () => {
    await expect(session(async () => bytes('ModelBegin\n'.repeat(ENVIRONMENT_ASSET_LIMITS.commands + 1))).load('commands')).rejects.toThrow('command budget');
    const triangle = 'ModelBegin\nClumpBegin\nVertex 0 0 0\nVertex 1 0 0\nVertex 0 1 0\n';
    const parts = triangle + Array.from({ length: ENVIRONMENT_ASSET_LIMITS.parts + 1 }, (_, index) => `Tag ${index}\nTriangle 1 2 3`).join('\n') + '\nClumpEnd\nModelEnd';
    await expect(session(async () => bytes(parts)).load('parts')).rejects.toThrow('geometry budget');
  });

  it('enforces the 500000 rendered-vertex acceptance limit', async () => {
    const many = 'ModelBegin\nClumpBegin\nVertex 0 0 0\nVertex 1 0 0\nVertex 0 1 0\n' + 'Triangle 1 2 3\n'.repeat(Math.floor(ENVIRONMENT_ASSET_LIMITS.vertices / 3) + 1) + 'ClumpEnd\nModelEnd';
    await expect(session(async () => bytes(many)).load('vertices')).rejects.toThrow('geometry budget');
  });

  it('closes an oversized decoded image and reports the retention limit without discarding the model', async () => {
    const image = bitmap(4097, 2); vi.stubGlobal('createImageBitmap', vi.fn(async () => image));
    const update = vi.fn();
    const { root } = await session(async url => url.includes('/models/') ? bytes(ground) : imageBytes(), 'ground', update).load('ground');
    await vi.waitFor(() => expect(image.close).toHaveBeenCalledOnce());
    expect(mesh(root).material.map).toBeNull();
    expect(update).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('4096px / 16 megapixel retention budget')]));
  });

  it('counts masks toward the total retained image budget', async () => {
    const images = [bitmap(4096, 4096), bitmap(1, 1)];
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValueOnce(images[0]).mockResolvedValueOnce(images[1]));
    const update = vi.fn();
    const { root } = await session(async url => url.includes('/models/') ? bytes(sky) : imageBytes(), 'skybox', update).load('sky');
    await vi.waitFor(() => expect(images[1].close).toHaveBeenCalledOnce());
    expect(images[0].close).not.toHaveBeenCalled();
    expect(mesh(root).material.map).toBeTruthy(); expect(mesh(root).material.alphaMap).toBeNull();
  });

  it('limits requested texture identities to 16, preserving existing model geometry', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap()));
    const model = ground.replace('Texture tint.png\n', '').replace('Quad 1 2 3 4',
      Array.from({ length: 17 }, (_, i) => `Texture t${i}.png\nQuad 1 2 3 4`).join('\n'));
    const fetcher = vi.fn<AssetFetcher>(async url => url.includes('/models/') ? bytes(model) : imageBytes());
    const update = vi.fn();
    const { root } = await session(fetcher, 'ground', update).load('ground');
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('16-image budget')])));
    await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.includes('/textures/'))).toHaveLength(16));
    expect(root.children).toHaveLength(17);
    expect((root.children[16] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material.map).toBeNull();
  });

  it('bounds global active and queued work, dropping canceled queued jobs before any network request', async () => {
    const pending: Array<(value: ReturnType<typeof bytes>) => void> = [];
    const fetcher = vi.fn<AssetFetcher>(() => new Promise(resolve => pending.push(resolve)));
    const values = Array.from({ length: 35 }, () => session(fetcher));
    const results = values.map((value, index) => value.load(`item${index}`).then(() => 'ok', cause => (cause as Error).message));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(await results[34]).toContain('queue is full');
    for (const value of values) value.dispose();
    for (const done of pending) done(bytes(ground));
    const ended = await Promise.all(results);
    expect(ended.slice(0, 34).every(value => /cancelled/.test(value))).toBe(true);
    await settled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
