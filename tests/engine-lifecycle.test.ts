import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WorldEngine } from '../src/renderer/engine';
import { createDemoWorld } from '../src/renderer/engine/demo';
import type { AvatarRig, AvatarSequence } from '../src/renderer/engine/avatar-assets';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    shadowMap = {}; capabilities = { getMaxAnisotropy: () => 1 }; info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio() {} setSize() {} render() {} dispose = vi.fn(); forceContextLoss = vi.fn();
  } };
});

function fakeCanvas() {
  return Object.assign(new EventTarget(), {
    style: {}, clientWidth: 800, clientHeight: 600, width: 800, height: 600,
    getContext: () => ({ measureText: () => ({ width: 80 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} }),
  }) as unknown as HTMLCanvasElement;
}
type InspectEngine = {
  scene: THREE.Scene; objects: Map<number, { root: THREE.Group }>;
  terrain: Map<string, THREE.Mesh>; avatars: Map<number, { root: THREE.Group }>;
  water: THREE.Mesh | null; ground: THREE.Mesh | null;
  renderer: { dispose: () => void; forceContextLoss: () => void };
};
const inspect = (engine: WorldEngine) => engine as unknown as InspectEngine;
const engines: WorldEngine[] = [];
const makeEngine = (options: Partial<ConstructorParameters<typeof WorldEngine>[1]> = {}) => {
  const engine = new WorldEngine(fakeCanvas(), { asset: vi.fn(), onPosition: vi.fn(), onSelect: vi.fn(), onStats: vi.fn(), ...options });
  engines.push(engine); return engine;
};

beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null, createElement: fakeCanvas }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.unstubAllGlobals(); });

describe('World renderer lifecycle', () => {
  it('updates attributes without losing objects, avatars, terrain, selection or position', () => {
    const engine = makeEngine(), demo = createDemoWorld();
    const rock = demo.objects.find(object => object.model === 'wayfarer:rock')!;
    engine.setWorld(demo.settings); engine.setObjects([rock]); engine.setSelected(rock.id);
    engine.setAvatar({ session: 1, citizen: 1, name: 'Explorer', type: 0, gesture: 0, state: 0, x: 1, y: 0, z: 3, yaw: 0 });
    engine.setTerrain({ pageX: 0, pageZ: 0, nodeX: 64, nodeZ: 64, size: 32, heights: [4], textures: [0] });
    const position = { x: 43, y: 8, z: -21, yaw: 1.2, pitch: 0.1 };
    engine.teleport(position);
    const view = inspect(engine), objectRoot = view.objects.get(rock.id)!.root, avatarRoot = view.avatars.get(1)!.root, terrain = [...view.terrain.values()][0];
    engine.updateWorld({ ...demo.settings, name: 'commons', title: 'Updated title', fogMax: 400, waterEnabled: true, waterLevel: 2, entry: { x: 0, y: 0, z: 0, yaw: 0 } });
    expect(engine.getPosition()).toEqual(position);
    expect(view.objects.get(rock.id)!.root).toBe(objectRoot);
    expect(view.avatars.get(1)!.root).toBe(avatarRoot);
    expect([...view.terrain.values()][0]).toBe(terrain);
    expect(view.water!.position.y).toBe(2);
    expect((view.scene.fog as THREE.Fog).far).toBe(400);
  });
  it('toggles terrain and water without deleting stored terrain geometry', () => {
    const engine = makeEngine(), settings = { ...createDemoWorld().settings, demo: false };
    engine.setWorld(settings);
    engine.setTerrain({ pageX: 0, pageZ: 0, nodeX: 64, nodeZ: 64, size: 32, heights: [0], textures: [0] });
    const view = inspect(engine), terrain = [...view.terrain.values()][0];
    engine.updateWorld({ ...settings, terrainEnabled: false, waterEnabled: true, waterLevel: 4 });
    expect(terrain.visible).toBe(false); expect(view.ground).toBeNull(); expect(view.water!.position.y).toBe(4);
    engine.updateWorld({ ...settings, terrainEnabled: true, waterEnabled: false });
    expect(terrain.visible).toBe(true); expect(view.terrain.size).toBe(1); expect(view.ground).not.toBeNull(); expect(view.water).toBeNull();
  });
  it('retains geometry for identical repeated cell queries', () => {
    const engine = makeEngine(), demo = createDemoWorld(), rock = demo.objects.find(object => object.model === 'wayfarer:rock')!;
    engine.setWorld(demo.settings); engine.setObjects([rock]);
    const root = inspect(engine).objects.get(rock.id)!.root;
    engine.setObjects([{ ...rock, owner: 5 }]);
    expect(inspect(engine).objects.get(rock.id)!.root).toBe(root);
    expect(root.userData.worldObject.owner).toBe(5);
  });
  it('loads each terrain image through the cache and maps it onto the matching geometry material', async () => {
    const engine = makeEngine(), settings = { ...createDemoWorld().settings, objectPath: 'https://example.test/assets/', demo: false };
    engine.setWorld(settings);
    const texture = new THREE.Texture();
    const load = vi.spyOn(engine as unknown as { loadTexture: (name: string) => Promise<THREE.Texture> }, 'loadTexture').mockResolvedValue(texture);
    engine.setTerrain({ pageX: 0, pageZ: 0, nodeX: 64, nodeZ: 64, size: 2, heights: [0], textures: [0, 64, 1, 254] });
    await Promise.resolve();
    const mesh = [...inspect(engine).terrain.values()][0];
    expect(load.mock.calls).toEqual([['terrain0'], ['terrain1']]);
    expect((mesh.material as THREE.MeshStandardMaterial[]).map(material => material.map)).toEqual([texture, texture]);
    expect(inspect(engine).ground!.visible).toBe(false);
    texture.userData.sharedAsset = true;
  });
  it('does not dispose a shared downloaded texture when deleting a procedural object', () => {
    const engine = makeEngine(), demo = createDemoWorld(), rock = demo.objects.find(object => object.model === 'wayfarer:rock')!;
    engine.setWorld(demo.settings); engine.setObjects([rock]);
    const texture = new THREE.Texture(); texture.userData.sharedAsset = true;
    const dispose = vi.spyOn(texture, 'dispose');
    inspect(engine).objects.get(rock.id)!.root.traverse(node => { if (node instanceof THREE.Mesh) (node.material as THREE.MeshStandardMaterial).map = texture; });
    engine.deleteObject(rock.id);
    expect(dispose).not.toHaveBeenCalled(); texture.dispose();
  });
  it('releases resources once and leaves the canvas context reusable for StrictMode', () => {
    const engine = makeEngine(), renderer = inspect(engine).renderer;
    engine.dispose(); engine.dispose();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.forceContextLoss).not.toHaveBeenCalled();
  });
  it('loads the original catalog and rigid avatar through the asset pipeline and animates independent instances', async () => {
    const asset = vi.fn(async (url: string) => ({ bytes: new Uint8Array(readFileSync(resolve('public/assets', '.' + new URL(url).pathname))), contentType: 'application/octet-stream' }));
    const catalog = vi.fn(), engine = makeEngine({ asset, onAvatarCatalog: catalog });
    engine.setWorld({ ...createDemoWorld().settings, objectPath: 'https://fixture.example/', demo: false });
    const avatar = { session: 12, citizen: 1, name: 'Explorer', type: 0, gesture: 0, state: 0, x: 0, y: 0, z: 0, yaw: 0 };
    engine.setAvatar(avatar); engine.setAvatar({ ...avatar, session: 13, name: 'Neighbor' });
    type Entry = { rig: AvatarRig; body: THREE.Group; sequence?: AvatarSequence; sequenceStarted: number; sequenceName?: string };
    const first = inspect(engine).avatars.get(12)! as unknown as Entry, second = inspect(engine).avatars.get(13)! as unknown as Entry;
    await vi.waitFor(() => expect(first.rig?.joints.size).toBe(16));
    expect(catalog.mock.calls.at(-1)![0].entries[0].name).toBe('Wayfarer Voyager');
    expect(first.body.visible).toBe(false); expect(first.rig.root).not.toBe(second.rig.root);
    expect(asset.mock.calls.filter(([url]) => url.endsWith('/avatars/wf-voyager.zip'))).toHaveLength(1);
    const animate = (entry: Entry, time: number, moving: boolean) => (engine as unknown as { animateAvatar(entry: unknown, time: number, moving: boolean): void }).animateAvatar(entry, time, moving);
    animate(first, performance.now(), false);
    await vi.waitFor(() => expect(first.sequence?.format).toBe('binary'));
    expect(first.sequenceName).toBe('wf-idle');
    engine.setAvatar({ ...avatar, gesture: 1 }); animate(first, performance.now(), false);
    await vi.waitFor(() => expect(first.sequence?.format).toBe('awsq'));
    animate(first, first.sequenceStarted + 700, false);
    const animated = first.rig.joints.get('lfshoulder')!, untouched = second.rig.joints.get('lfshoulder')!;
    expect(animated.group.quaternion.angleTo(animated.bindRotation)).toBeCloseTo(145 * Math.PI / 180);
    expect(untouched.group.quaternion.angleTo(untouched.bindRotation)).toBeCloseTo(0);
    engine.setAvatar({ ...avatar, gesture: 0 }); animate(first, performance.now(), true);
    await vi.waitFor(() => expect(first.sequenceName).toBe('wf-walk'));
  });
  it('retains original fallback figures when avatar geometry has an invalid format header', async () => {
    const text = 'version 3\navatar\nname=Unsupported\ngeometry=skinned.x\nendavatar';
    const asset = vi.fn(async (url: string) => { if (url.endsWith('.zip')) throw new Error('Not found'); return { bytes: new TextEncoder().encode(text), contentType: 'text/plain' }; });
    const engine = makeEngine({ asset }); engine.setWorld({ ...createDemoWorld().settings, objectPath: 'https://fixture.example/', demo: false });
    engine.setAvatar({ session: 17, citizen: 1, name: 'Explorer', type: 0, gesture: 0, state: 0, x: 0, y: 0, z: 0, yaw: 0 });
    const entry = inspect(engine).avatars.get(17)! as unknown as { body: THREE.Group; root: THREE.Group; rig?: AvatarRig };
    await vi.waitFor(() => expect(entry.root.userData.avatarAssetError).toMatch(/filename\/header format mismatch/));
    expect(entry.body.visible).toBe(true); expect(entry.rig).toBeUndefined();
  });
});
