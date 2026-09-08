import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WorldEngine } from '../src/renderer/engine';
import { createDemoWorld } from '../src/renderer/engine/demo';
import { parseRwx } from '../src/renderer/engine/rwx';
import type { TerrainTile, WorldObject } from '../src/shared/types';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    shadowMap = {}; capabilities = { getMaxAnisotropy: () => 1 }; info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  } };
});
function fakeCanvas() {
  return Object.assign(new EventTarget(), { style: {}, clientWidth: 800, clientHeight: 600,
    getContext: () => ({ measureText: () => ({ width: 80 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} }),
  }) as unknown as HTMLCanvasElement;
}
const engines: WorldEngine[] = [];
function setup(objectPath = '') {
  const engine = new WorldEngine(fakeCanvas(), { asset: vi.fn().mockRejectedValue(new Error('No network')), onPosition: vi.fn(), onSelect: vi.fn(), onStats: vi.fn() });
  engines.push(engine); engine.setWorld({ ...createDemoWorld().settings, objectPath, demo: false, terrainEnabled: true }); return engine;
}
const tile = (pageX: number, pageZ: number, nodeX = 64): TerrainTile => ({ pageX, pageZ, nodeX, nodeZ: 64, size: 2, heights: [0], textures: [0, 1, 0, 1] });
const object = (id: number, model = 'wayfarer:cube'): WorldObject => ({ id, owner: 1, model, action: '', description: '', x: id, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 });
const terrain = (engine: WorldEngine) => Reflect.get(engine, 'terrain') as Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>>;
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null, createElement: fakeCanvas }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('streamed scene resource unload', () => {
  it('unloads exactly the requested objects and all nodes of exact page coordinates once', () => {
    const engine = setup(); engine.setObjects([object(1), object(2)]); engine.setSelection([1, 2], 1);
    engine.setTerrain(tile(1, 2)); engine.setTerrain(tile(1, 2, 96)); engine.setTerrain(tile(1, 20));
    const removed = [terrain(engine).get('1,2,64,64')!, terrain(engine).get('1,2,96,64')!], retained = terrain(engine).get('1,20,64,64')!;
    const disposals = removed.map(mesh => ({ geometry: vi.spyOn(mesh.geometry, 'dispose'), materials: mesh.material.map(material => vi.spyOn(material, 'dispose')) }));
    const retainedDispose = vi.spyOn(retained.geometry, 'dispose');
    const root = Reflect.get(engine, 'objects').get(1).root as THREE.Group;
    const mesh = root.getObjectsByProperty('isMesh', true)[0] as THREE.Mesh, objectDispose = vi.spyOn(mesh.geometry, 'dispose');
    const deleted = vi.spyOn(Reflect.get(engine, 'transformTools'), 'objectDeleted');
    engine.unloadSceneData([1, 1, NaN], [{ pageX: 1, pageZ: 2 }, { pageX: 1, pageZ: 2 }, { pageX: Infinity, pageZ: 2 }]);
    expect(Reflect.get(engine, 'objects').has(1)).toBe(false); expect(Reflect.get(engine, 'objects').has(2)).toBe(true);
    expect(deleted).toHaveBeenCalledTimes(1); expect(objectDispose).toHaveBeenCalledTimes(1);
    expect(Reflect.get(engine, 'selectedIds')).toEqual(new Set([2])); expect(Reflect.get(engine, 'selectedId')).toBe(2);
    expect(terrain(engine).size).toBe(1); expect(retainedDispose).not.toHaveBeenCalled();
    for (const item of disposals) { expect(item.geometry).toHaveBeenCalledTimes(1); item.materials.forEach(dispose => expect(dispose).toHaveBeenCalledTimes(1)); }
    expect(Reflect.get(engine, 'collisionMeshes')).toContain(retained);
    removed.forEach(mesh => expect(Reflect.get(engine, 'collisionMeshes')).not.toContain(mesh));
  });
  it('disposes exclusively owned terrain maps while preserving a cache-owned map used by surviving nodes', () => {
    const engine = setup(); engine.setTerrain(tile(0, 0)); engine.setTerrain(tile(1, 0));
    const first = terrain(engine).get('0,0,64,64')!, second = terrain(engine).get('1,0,64,64')!;
    const owned = new THREE.Texture(), shared = new THREE.Texture(); shared.userData.sharedAsset = true;
    first.material[0].map = owned; first.material[1].map = shared; second.material[0].map = shared;
    const ownedDispose = vi.spyOn(owned, 'dispose'), sharedDispose = vi.spyOn(shared, 'dispose');
    engine.unloadSceneData([], [{ pageX: 0, pageZ: 0 }]);
    expect(ownedDispose).toHaveBeenCalledOnce(); expect(sharedDispose).not.toHaveBeenCalled(); expect(second.material[0].map).toBe(shared);
    expect(Reflect.get(engine, 'ground').visible).toBe(false);
    engine.unloadSceneData([], [{ pageX: 1, pageZ: 0 }]); expect(Reflect.get(engine, 'ground').visible).toBe(true); expect(sharedDispose).not.toHaveBeenCalled(); shared.dispose();
  });
  it('prevents late terrain attachment to disposed materials while allowing a fresh replacement to use the shared result', async () => {
    const engine = setup('https://fixture.invalid/');
    let resolveTexture!: (texture: THREE.Texture) => void;
    const pending = new Promise<THREE.Texture>(resolve => { resolveTexture = resolve; });
    vi.spyOn(engine as unknown as { loadTexture(name: string): Promise<THREE.Texture> }, 'loadTexture').mockReturnValue(pending);
    engine.setTerrain(tile(0, 0)); const old = terrain(engine).get('0,0,64,64')!;
    engine.unloadSceneData([], [{ pageX: 0, pageZ: 0 }]); engine.setTerrain(tile(0, 0)); const current = terrain(engine).get('0,0,64,64')!;
    const texture = new THREE.Texture(); texture.userData.sharedAsset = true; resolveTexture(texture); await tick();
    expect(old.material.every(material => material.userData.disposed && material.map === null)).toBe(true);
    expect(current.material.every(material => material.map === texture && !material.userData.disposed)).toBe(true); texture.dispose();
  });
  it('does not resurrect an unloaded object after its queued RWX download completes', async () => {
    const engine = setup(); let resolveModel!: (model: ReturnType<typeof parseRwx>) => void;
    const pending = new Promise<ReturnType<typeof parseRwx>>(resolve => { resolveModel = resolve; });
    vi.spyOn(engine as unknown as { loadRwx(name: string): Promise<ReturnType<typeof parseRwx>> }, 'loadRwx').mockReturnValue(pending);
    engine.setObjects([object(5, 'later.rwx')]); const root = Reflect.get(engine, 'objects').get(5).root as THREE.Group;
    const mesh = (root.children[0] as THREE.Group).children[0] as THREE.Mesh, dispose = vi.spyOn(mesh.geometry, 'dispose');
    engine.unloadSceneData([5], []); resolveModel(parseRwx('Vertex 0 0 0\nVertex 1 0 0\nVertex 0 1 0\nTriangle 1 2 3')); await tick();
    expect(Reflect.get(engine, 'objects').has(5)).toBe(false); expect(root.parent).toBeNull(); expect(dispose).toHaveBeenCalledOnce();
  });
  it('does not change settings, player position, avatars or generation during distance eviction', () => {
    const engine = setup(); const position = engine.getPosition(), settings = Reflect.get(engine, 'settings'), generation = Reflect.get(engine, 'generation');
    engine.setAvatar({ session: 14, citizen: 2, name: 'Neighbor', type: 0, gesture: 0, state: 0, x: 1, y: 0, z: 1, yaw: 0 });
    engine.setObjects([object(1)]); engine.setTerrain(tile(1, 1)); engine.unloadSceneData([1], [{ pageX: 1, pageZ: 1 }]);
    expect(engine.getPosition()).toEqual(position); expect(Reflect.get(engine, 'settings')).toBe(settings); expect(Reflect.get(engine, 'generation')).toBe(generation);
    expect(Reflect.get(engine, 'avatars').has(14)).toBe(true);
  });
});
