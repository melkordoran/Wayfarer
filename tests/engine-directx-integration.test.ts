import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { WorldEngine, type AvatarAssetState } from '../src/renderer/engine';
import { createDemoWorld } from '../src/renderer/engine/demo';
import { parseDirectX } from '../src/renderer/engine/directx';
import { createDirectXInstance, type DirectXInstance } from '../src/renderer/engine/directx-mesh';
import * as avatarAssets from '../src/renderer/engine/avatar-assets';
import { ModelPreviewSession } from '../src/renderer/engine/model-preview';
import { EnvironmentAssetSession } from '../src/renderer/engine/environment-assets';
import type { Avatar } from '../src/shared/types';
import { directXFixtureExpectations } from '../scripts/directx-fixture-assets.mjs';
import { strToU8, zipSync } from 'fflate';
import { directXQuaternionReferenceText } from './fixtures/directx-animation-oracles';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    shadowMap = {}; capabilities = { getMaxAnisotropy: () => 1 }; info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  } };
});
const fixtureRoot = resolve(import.meta.dirname, 'fixtures/directx');
const original = (name: string) => new Uint8Array(readFileSync(resolve(fixtureRoot, name)));
const asset = vi.fn(async (url: string) => {
  const path = new URL(url).pathname.slice(1);
  const bytes = path.startsWith('seqs/') ? new Uint8Array(readFileSync(resolve('public/assets', path))) : original(path);
  return { bytes, contentType: 'application/octet-stream' };
});
function fakeCanvas() {
  return Object.assign(new EventTarget(), { style: {}, clientWidth: 800, clientHeight: 600, width: 800, height: 600,
    getContext: () => ({ measureText: () => ({ width: 80 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} }),
  }) as unknown as HTMLCanvasElement;
}
type AvatarEntry = { avatar: Avatar; root: THREE.Group; body: THREE.Group; rig?: DirectXInstance; sequence?: avatarAssets.AvatarSequence; sequenceStarted: number; gesture?: { phase: string } };
type Internals = { avatars: Map<number, AvatarEntry>; objects: Map<number, { root: THREE.Group; ready: boolean }>; scene: THREE.Scene; animateAvatar(entry: AvatarEntry, time: number, moving: boolean): void };
const inspect = (engine: WorldEngine) => engine as unknown as Internals;
const engines: WorldEngine[] = [], cleanups: Array<() => void> = [];
const avatar: Avatar = { session: 12, citizen: 1, name: 'Explorer', type: 2, gesture: 0, state: 0, x: 0, y: 0, z: 0, yaw: 0 };
function makeEngine(options: Partial<ConstructorParameters<typeof WorldEngine>[1]> = {}) {
  const states: AvatarAssetState[] = [], engine = new WorldEngine(fakeCanvas(), { asset, onPosition: vi.fn(), onSelect: vi.fn(), onStats: vi.fn(), onAvatarAssetState: value => states.push(value), ...options });
  engines.push(engine); engine.setWorld({ ...createDemoWorld().settings, demo: false, objectPath: 'https://fixture.example/' }); return { engine, states };
}
function mesh(root: THREE.Object3D) { let value!: THREE.Mesh; root.traverse(node => { if (!value && node instanceof THREE.Mesh) value = node; }); return value; }
const settled = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const expectVector = (actual: THREE.Vector3, expected: number[]) => actual.toArray().forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 7));
beforeEach(() => {
  asset.mockClear();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null, createElement: fakeCanvas }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 32, height: 32, close: vi.fn() })));
});
afterEach(async () => { engines.splice(0).forEach(engine => engine.dispose()); cleanups.splice(0).forEach(dispose => dispose()); await settled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('original DirectX fixtures through the shared renderer', () => {
  it.each(['', '-binary32', '-binary64'])('matches independent authored bind and weighted elbow witnesses for %s encoding', suffix => {
    const parsed = parseDirectX(original(`avatars/wf-x-voyager${suffix}.x`));
    const instance = createDirectXInstance(parsed, { jointName: avatarAssets.directXJointName }); cleanups.push(instance.dispose);
    const item = mesh(instance.root) as THREE.SkinnedMesh, expected = directXFixtureExpectations().skinned;
    expect(instance.joints.size).toBe(16); expect(instance.warnings.filter(value => /offsets differ/.test(value))).toEqual([]);
    for (const witness of [expected.elbowWitness, expected.blendedWitness]) {
      const point = parsed.meshes[0].positions.slice(witness.index * 3, witness.index * 3 + 3), positions = item.geometry.getAttribute('position');
      let index = -1;
      for (let at = 0; at < positions.count; at++) if (Math.abs(positions.getX(at) - point[0]) < 1e-7 && Math.abs(positions.getY(at) - point[1]) < 1e-7 && Math.abs(positions.getZ(at) - point[2]) < 1e-7) { index = at; break; }
      expect(index).toBeGreaterThanOrEqual(0);
      instance.applyPose(new Map());
      let actual = item.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(item.matrixWorld);
      actual.toArray().forEach((value, axis) => expect(value).toBeCloseTo(witness.bind[axis], 6));
      instance.applyPose(new Map([['lfelbow', { rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2), translation: new THREE.Vector3() }]]));
      actual = item.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(item.matrixWorld);
      actual.toArray().forEach((value, axis) => expect(value).toBeCloseTo(witness.rotated90Z[axis], 6));
    }
  });

  it('loads a real .x property from ZIP, attaches its texture, preserves selection and releases its own resources', async () => {
    const { engine } = makeEngine(), object = { ...createDemoWorld().objects[0], id: 500, model: 'wf-x-marker.x', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, action: '' };
    engine.setObjects([object]); engine.setSelection([500]);
    await vi.waitFor(() => expect(inspect(engine).objects.get(500)?.ready).toBe(true));
    const root = inspect(engine).objects.get(500)!.root, item = mesh(root), material = (item.material as THREE.MeshPhongMaterial[])[0];
    await vi.waitFor(() => expect(material.map).toBeTruthy());
    const bounds = new THREE.Box3().setFromObject(root); expectVector(bounds.min, [4.75, .5, -5]); expectVector(bounds.max, [5.75, 2, -3]);
    const dispose = vi.spyOn(item.geometry, 'dispose'), textureDispose = vi.spyOn(material.map!, 'dispose');
    engine.unloadSceneData([500], []); expect(dispose).toHaveBeenCalledTimes(1); expect(textureDispose).not.toHaveBeenCalled();
    engine.dispose(); expect(textureDispose).toHaveBeenCalledTimes(1);
  });

  it('animates separate network avatars with existing SEQ playback and exposes guarded asset status', async () => {
    const { engine, states } = makeEngine(); engine.setAvatar(avatar); engine.setAvatar({ ...avatar, session: 13 });
    await vi.waitFor(() => expect(inspect(engine).avatars.get(12)?.rig?.joints.size).toBe(16));
    const first = inspect(engine).avatars.get(12)!, second = inspect(engine).avatars.get(13)!;
    expect(states.filter(value => value.session === 12).map(value => value.status)).toEqual(['loading', 'ready']);
    expect(states.find(value => value.status === 'ready' && value.session === 12)).toMatchObject({ format: 'x', local: false, geometry: 'wf-x-voyager.x', type: 2 });
    engine.setAvatar({ ...avatar, gesture: 1 }); inspect(engine).animateAvatar(first, performance.now(), false);
    await vi.waitFor(() => expect(first.gesture?.phase).toBe('playing'));
    inspect(engine).animateAvatar(first, first.sequenceStarted + 700, false);
    expect(first.rig!.joints.get('lfshoulder')!.group.quaternion.angleTo(first.rig!.joints.get('lfshoulder')!.bindRotation)).toBeCloseTo(145 * Math.PI / 180);
    expect(second.rig!.joints.get('lfshoulder')!.group.quaternion.angleTo(second.rig!.joints.get('lfshoulder')!.bindRotation)).toBe(0);
    const skeleton = (mesh(first.rig!.root) as THREE.SkinnedMesh).skeleton; skeleton.computeBoneTexture(); const dispose = vi.spyOn(skeleton.boneTexture!, 'dispose');
    engine.deleteAvatar(12); expect(dispose).toHaveBeenCalledTimes(1);
    expect(second.rig!.root.parent).toBe(second.root);
  });

  it('does not publish a ready avatar or allocate an obsolete rig after a pending source is deleted', async () => {
    const parsed = parseDirectX(original('avatars/wf-x-voyager.x')); let finish!: (value: avatarAssets.AvatarModel) => void;
    vi.spyOn(avatarAssets, 'loadAvatarModel').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { engine, states } = makeEngine(); engine.setAvatar(avatar);
    await vi.waitFor(() => expect(states.some(value => value.session === 12 && value.status === 'loading')).toBe(true));
    engine.deleteAvatar(12); finish(parsed); await settled();
    expect(states.filter(value => value.session === 12).map(value => value.status)).toEqual(['loading']); expect(inspect(engine).avatars.has(12)).toBe(false);
  });
  it('loads catalog-referenced X animation through asset dispatch, skins only its own avatar and exposes scoped notes', async () => {
    const catalog = new TextDecoder().decode(original('avatars/avatars.dat')).replaceAll('Wave=wf-wave', 'Wave=wf-reference.x');
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('avatars/avatars.zip')) return { bytes: zipSync({ 'avatars.dat': strToU8(catalog) }), contentType: 'application/zip' };
      if (url.endsWith('seqs/wf-reference.zip')) return { bytes: zipSync({ 'wf-reference.x': strToU8(directXQuaternionReferenceText) }), contentType: 'application/zip' };
      return asset(url);
    });
    const { engine, states } = makeEngine({ asset: fetcher }); engine.setAvatar(avatar); engine.setAvatar({ ...avatar, session: 13 });
    await vi.waitFor(() => expect(inspect(engine).avatars.get(12)?.rig?.joints.size).toBe(16));
    const first = inspect(engine).avatars.get(12)!, second = inspect(engine).avatars.get(13)!;
    engine.setAvatar({ ...avatar, gesture: 1 }); inspect(engine).animateAvatar(first, performance.now(), false);
    await vi.waitFor(() => expect(first.sequence?.format).toBe('directx'));
    expect(first.gesture?.phase).toBe('playing');
    expect(states.filter(value => value.session === 12).at(-1)?.warnings.join(' ')).toMatch(/historical AW exporter parity/);
    inspect(engine).animateAvatar(first, first.sequenceStarted + 500, false);
    expect(first.rig!.joints.get('lfelbow')!.group.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(Math.PI / 3);
    expect(second.rig!.joints.get('lfelbow')!.group.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
    engine.setAvatar({ ...avatar, gesture: 0 });
    expect(first.rig!.joints.get('lfelbow')!.group.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
    expect(states.filter(value => value.session === 12).at(-1)?.warnings.join(' ')).not.toMatch(/historical AW exporter parity/);
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('seqs/wf-reference.zip'))).toBe(true);
  });
  it('keeps a valid X body visible and exposes an actionable unsupported X motion error', async () => {
    const bad = 'xof 0303txt 0032\nAnimationSet Unsupported {}';
    const load = avatarAssets.loadAvatarSequence;
    vi.spyOn(avatarAssets, 'loadAvatarSequence').mockImplementation((path, name, fetcher) => name === 'wf-wave' ? Promise.resolve().then(() => avatarAssets.parseAvatarSequence(strToU8(bad))) : load(path, name, fetcher));
    const { engine, states } = makeEngine(); engine.setAvatar(avatar);
    await vi.waitFor(() => expect(inspect(engine).avatars.get(12)?.rig).toBeTruthy());
    const entry = inspect(engine).avatars.get(12)!;
    engine.setAvatar({ ...avatar, gesture: 1 }); inspect(engine).animateAvatar(entry, performance.now(), false);
    await vi.waitFor(() => expect(states.filter(value => value.session === 12).at(-1)?.message).toMatch(/DirectX animation: AnimationSet has no tracks/));
    expect(entry.gesture).toBeUndefined(); expect(entry.body.visible).toBe(false); expect(entry.rig!.root.visible).toBe(true);
  });
  it('loads the bundled studio X avatar and its texture through the exact in-memory source, with no network', async () => {
    const network = vi.fn().mockRejectedValue(new Error('No network allowed')), states: AvatarAssetState[] = [];
    const engine = new WorldEngine(fakeCanvas(), { asset: network, onPosition: vi.fn(), onSelect: vi.fn(), onStats: vi.fn(), onAvatarAssetState: state => states.push(state) }); engines.push(engine);
    engine.setWorld(createDemoWorld().settings); engine.setAvatarType(2); engine.setCameraMode('third-person');
    await vi.waitFor(() => expect(states.some(state => state.local && state.type === 2 && state.status === 'ready')).toBe(true));
    const ready = states.find(state => state.local && state.type === 2 && state.status === 'ready')!, entry = inspect(engine).avatars.get(ready.session)!;
    const materials = mesh(entry.rig!.root).material as THREE.MeshPhongMaterial[];
    await vi.waitFor(() => expect(materials.some(material => material.map)).toBe(true));
    expect(network).not.toHaveBeenCalled(); expect(ready.geometry).toBe('wf-x-voyager.x'); expect(ready.format).toBe('x');
    const texture = materials.find(material => material.map)!.map!; expect(texture.userData.cacheKey).toContain('https://studio.wayfarer.invalid/');
    const disposed = vi.spyOn(texture, 'dispose'); engine.dispose(); expect(disposed).toHaveBeenCalledTimes(1);
  });

  it('does not report an explicit gesture playing when named frames do not affect the geometry', async () => {
    const staticSource = 'xof 0303txt 0032\nFrame aw_lfshoulder {}\nMesh Static {3;0;0;0;,1;0;0;,0;1;0;;1;3;0,1,2;;}';
    vi.spyOn(avatarAssets, 'loadAvatarModel').mockResolvedValue(parseDirectX(staticSource));
    const { engine } = makeEngine(); engine.setAvatar(avatar);
    await vi.waitFor(() => expect(inspect(engine).avatars.get(12)?.rig).toBeTruthy());
    const entry = inspect(engine).avatars.get(12)!; expect(entry.rig!.joints.size).toBe(0);
    engine.setAvatar({ ...avatar, gesture: 1 }); inspect(engine).animateAvatar(entry, performance.now(), false);
    await vi.waitFor(() => expect(entry.root.userData.avatarSequenceError).toMatch(/no animation tracks mapped/));
    expect(entry.gesture).toBeUndefined(); expect(entry.body.visible).toBe(false);
  });
  it('preserves valid avatar geometry on implicit motion failure and clears the warning after successful locomotion', async () => {
    const load = avatarAssets.loadAvatarSequence;
    vi.spyOn(avatarAssets, 'loadAvatarSequence').mockImplementation((path, name, fetcher) => name === 'wf-idle' ? Promise.reject(new Error('Missing idle')) : load(path, name, fetcher));
    const { engine, states } = makeEngine(); engine.setAvatar(avatar);
    await vi.waitFor(() => expect(inspect(engine).avatars.get(12)?.rig).toBeTruthy()); const entry = inspect(engine).avatars.get(12)!;
    inspect(engine).animateAvatar(entry, performance.now(), false);
    await vi.waitFor(() => expect(states.filter(state => state.session === 12).at(-1)?.message).toMatch(/reference pose/));
    expect(entry.body.visible).toBe(false); expect(entry.rig!.root.visible).toBe(true);
    inspect(engine).animateAvatar(entry, performance.now(), true);
    await vi.waitFor(() => expect(entry.sequence).toBeTruthy());
    expect(states.filter(state => state.session === 12).at(-1)?.status).toBe('ready'); expect(states.filter(state => state.session === 12).at(-1)?.message).toBeUndefined();
    expect(entry.root.userData.avatarSequenceError).toBeUndefined();
  });
  it('ignores a stale motion failure after newer locomotion succeeds', async () => {
    const load = avatarAssets.loadAvatarSequence; let fail!: (error: Error) => void;
    vi.spyOn(avatarAssets, 'loadAvatarSequence').mockImplementation((path, name, fetcher) => name === 'wf-idle' ? new Promise((_resolve, reject) => { fail = reject; }) : load(path, name, fetcher));
    const { engine, states } = makeEngine(); engine.setAvatar(avatar);
    await vi.waitFor(() => expect(inspect(engine).avatars.get(12)?.rig).toBeTruthy()); const entry = inspect(engine).avatars.get(12)!;
    inspect(engine).animateAvatar(entry, performance.now(), false); await settled(); inspect(engine).animateAvatar(entry, performance.now(), true);
    await vi.waitFor(() => expect(entry.sequence).toBeTruthy()); const count = states.length;
    fail(new Error('Late idle failure')); await settled();
    expect(states).toHaveLength(count); expect(entry.root.userData.avatarSequenceError).toBeUndefined(); expect(entry.body.visible).toBe(false);
  });

  it('uses explicit preview texture ownership and releases X textures/bitmaps exactly once', async () => {
    const session = new ModelPreviewSession(asset, 'https://fixture.example/'); cleanups.push(() => session.dispose());
    const result = await session.load('wf-x-marker.x'), item = mesh(result.root), material = (item.material as THREE.MeshPhongMaterial[])[0];
    await vi.waitFor(() => expect(material.map).toBeTruthy());
    const dispose = vi.spyOn(material.map!, 'dispose'), bitmap = material.map!.image as { close: ReturnType<typeof vi.fn> };
    session.dispose(); session.dispose(); expect(dispose).toHaveBeenCalledTimes(1); expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it.each(['ground', 'skybox'] as const)('uses the same .x scene factory for static %s environments', async kind => {
    const session = new EnvironmentAssetSession(asset, 'https://fixture.example/', kind); cleanups.push(() => session.dispose());
    const result = await session.load('wf-x-marker.x'), item = mesh(result.root), materials = item.material as THREE.MeshPhongMaterial[];
    expectVector(result.bounds.min, [4.75, .5, -5]); expectVector(result.bounds.max, [5.75, 2, -3]);
    expect(materials[0]).toBeInstanceOf(THREE.MeshPhongMaterial); expect(materials[0].fog).toBe(kind !== 'skybox'); expect(item.castShadow).toBe(kind !== 'skybox');
    await vi.waitFor(() => expect(materials[0].map).toBeTruthy()); const bitmap = materials[0].map!.image as { close: ReturnType<typeof vi.fn> };
    session.dispose(); expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});
