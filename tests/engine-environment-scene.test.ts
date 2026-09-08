import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { EnvironmentScene } from '../src/renderer/engine/environment-scene';
import { SkyGradient, sampleSkyGradient, validSkyColors, type SkyColors } from '../src/renderer/engine/sky-gradient';
import { createDemoWorld } from '../src/renderer/engine/demo';
import type { AssetFetcher } from '../src/renderer/engine/assets';

const sky = readFileSync(resolve(import.meta.dirname, 'fixtures/environment/skybox.rwx'), 'utf8');
const ground = readFileSync(resolve(import.meta.dirname, 'fixtures/environment/ground.rwx'), 'utf8');
const value = (source: string) => ({ bytes: new TextEncoder().encode(source), contentType: 'text/plain' });
const settings = () => ({ ...createDemoWorld().settings, demo: false, objectPath: 'https://objects.example/world/', skybox: 'skybox', ground: 'ground', repeatingGround: false });
const fetcher = vi.fn<AssetFetcher>(async url => {
  if (url.includes('/textures/')) throw new Error('Optional fixture image unavailable');
  return value(url.includes('skybox') ? sky : ground);
});
const scenes: EnvironmentScene[] = [];
function makeScene(asset: AssetFetcher = fetcher) {
  const scene = new THREE.Scene(), warning = vi.fn(), changed = vi.fn();
  const environment = new EnvironmentScene(scene, asset, changed, warning);
  scenes.push(environment);
  return { scene, environment, warning, changed };
}
function renderHarness() {
  const events: Array<{ scene?: THREE.Scene; camera?: THREE.PerspectiveCamera; autoClear?: boolean; background?: unknown; clearDepth?: boolean }> = [];
  const renderer = { autoClear: true, render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) { events.push({ scene, camera, background: scene.background, autoClear: this.autoClear }); }, clearDepth() { events.push({ clearDepth: true }); } };
  const camera = new THREE.PerspectiveCamera(62, 1.5, 0.1, 1200);
  camera.position.set(100, 4, 500); camera.rotation.set(0.1, 0.7, 0, 'YXZ');
  const lights = { sun: new THREE.DirectionalLight('#ff0000', 2), ambient: new THREE.AmbientLight('#00ff00', 0.5), hemi: new THREE.HemisphereLight('#0000ff', '#999999', 0.2) };
  lights.sun.position.set(42, 20, -18); lights.sun.target.position.set(10, 3, 0);
  return { events, renderer: renderer as unknown as THREE.WebGLRenderer, camera, lights };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
afterEach(async () => { scenes.splice(0).forEach(scene => scene.dispose()); await settle(); vi.restoreAllMocks(); fetcher.mockClear(); });

describe('authored environment asset scene lifecycle', () => {
  it('loads ground alongside terrain at its authored origin and provides the real collision surface', async () => {
    const { scene, environment } = makeScene(); environment.update(settings());
    await vi.waitFor(() => expect(environment.collisionMeshes()).toHaveLength(1));
    const mesh = environment.collisionMeshes()[0];
    expect(mesh.parent!.position.toArray()).toEqual([0, 0, 0]); expect(scene.children).toContain(mesh.parent);
    expect(new THREE.Raycaster(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0)).intersectObject(mesh)[0].point.y).toBeCloseTo(0.2);
    const initial = mesh.parent;
    environment.update({ ...settings(), terrainEnabled: false, terrainOffset: 20 });
    expect(environment.collisionMeshes()[0].parent).toBe(initial);
    expect(initial!.position.y).toBe(0);
  });
  it('renders sky before world using a source-sized camera, cleared depth and shared camera orientation', async () => {
    const { scene, environment } = makeScene(); environment.update(settings()); await settle();
    const harness = renderHarness(), background = new THREE.Color('#123456'); scene.background = background;
    environment.render(harness.renderer, harness.camera, harness.lights);
    expect(harness.events).toHaveLength(3);
    const [skyPass, depth, worldPass] = harness.events;
    expect(skyPass.scene).not.toBe(scene); expect(skyPass.camera!.position.toArray()).toEqual([0, 0, 0]);
    expect(skyPass.camera!.quaternion.angleTo(harness.camera.quaternion)).toBeCloseTo(0);
    expect(skyPass.camera!.far).toBeCloseTo(Math.sqrt(3) * 2); expect(skyPass.camera!.far).not.toBe(harness.camera.far);
    expect(skyPass.background).toBe(background); expect(skyPass.autoClear).toBe(true);
    expect(depth.clearDepth).toBe(true); expect(worldPass.scene).toBe(scene); expect(worldPass.background).toBeNull(); expect(worldPass.autoClear).toBe(false);
    expect(scene.background).toBe(background); expect(harness.renderer.autoClear).toBe(true);
    const skySun = skyPass.scene!.children.find(child => child instanceof THREE.DirectionalLight) as THREE.DirectionalLight;
    expect(skySun.position.toArray()).toEqual([32, 17, -18]); expect(skySun.intensity).toBe(2);
  });
  it('restores renderer state when the world render throws after drawing the sky', async () => {
    const { scene, environment } = makeScene(); environment.update(settings()); await settle();
    const harness = renderHarness(), background = new THREE.Color('#123456'); scene.background = background;
    const render = harness.renderer.render.bind(harness.renderer);
    harness.renderer.render = (pass, camera) => { if (pass === scene) throw new Error('Render interrupted'); render(pass, camera); };
    expect(() => environment.render(harness.renderer, harness.camera, harness.lights)).toThrow('Render interrupted');
    expect(scene.background).toBe(background); expect(harness.renderer.autoClear).toBe(true);
  });
  it('disposes owned roots once on source replacement, without altering unrelated scene objects', async () => {
    const { scene, environment } = makeScene(); environment.update(settings()); await settle();
    const mesh = environment.collisionMeshes()[0], geometry = vi.spyOn(mesh.geometry, 'dispose');
    const user = new THREE.Group(); scene.add(user);
    environment.update({ ...settings(), ground: '', skybox: '' });
    expect(environment.collisionMeshes()).toEqual([]); expect(geometry).toHaveBeenCalledTimes(1); expect(scene.children).toEqual([user]);
    environment.dispose(); expect(geometry).toHaveBeenCalledTimes(1);
  });
  it('rejects stale ground loads after replacement and reset', async () => {
    let release!: (asset: Awaited<ReturnType<AssetFetcher>>) => void;
    const pending = new Promise<Awaited<ReturnType<AssetFetcher>>>(resolve => { release = resolve; });
    const asset: AssetFetcher = async url => url.includes('old') ? pending : value(ground);
    const { scene, environment } = makeScene(asset);
    environment.update({ ...settings(), skybox: '', ground: 'old' }); await Promise.resolve();
    environment.update({ ...settings(), skybox: '' }); await vi.waitFor(() => expect(environment.collisionMeshes()).toHaveLength(1));
    const current = environment.collisionMeshes()[0]; release(value(ground)); await settle();
    expect(environment.collisionMeshes()).toEqual([current]); expect(scene.children).toHaveLength(1);
    environment.reset(); expect(scene.children).toHaveLength(0);
  });
  it('deduplicates unsupported repeating-ground/backdrop notices and never invents a tiled ground', async () => {
    const { environment, warning } = makeScene();
    const value = { ...settings(), repeatingGround: true, backdrop: 'panorama' };
    environment.update(value); environment.update(value); await settle();
    expect(environment.collisionMeshes()).toHaveLength(1);
    expect(warning.mock.calls.filter(([message]) => message.includes('Repeating ground'))).toHaveLength(1);
    expect(warning.mock.calls.filter(([message]) => message.includes('Legacy backdrop'))).toHaveLength(1);
  });
});

const colors: SkyColors = { west: '#ff0000', east: '#00ff00', top: '#0000ff', bottom: '#ffff00', north: '#ff00ff', south: '#00ffff' };
describe('six-direction authored sky gradient', () => {
  it.each([
    [[1, 0, 0], 'west'], [[-1, 0, 0], 'east'], [[0, 1, 0], 'top'],
    [[0, -1, 0], 'bottom'], [[0, 0, 1], 'north'], [[0, 0, -1], 'south'],
  ] as Array<[number[], keyof SkyColors]>)('uses the AW cardinal anchor %j for %s', (direction, name) => {
    expect(sampleSkyGradient(colors, new THREE.Vector3(...direction)).getHexString()).toBe(colors[name].slice(1));
  });
  it('smoothly blends in linear color space and remains continuous across cardinal boundaries', () => {
    const diagonal = sampleSkyGradient(colors, new THREE.Vector3(1, 1, 0));
    expect(diagonal.r).toBeCloseTo(0.5); expect(diagonal.g).toBeCloseTo(0); expect(diagonal.b).toBeCloseTo(0.5);
    const left = sampleSkyGradient(colors, new THREE.Vector3(-1e-5, 1, 0)), right = sampleSkyGradient(colors, new THREE.Vector3(1e-5, 1, 0));
    expect(Math.abs(left.r - right.r)).toBeLessThan(1e-8); expect(left.b).toBeCloseTo(right.b);
    expect(validSkyColors({ ...colors, north: 'invalid' })).toBeUndefined(); expect(validSkyColors(colors)).toEqual(colors);
  });
  it('passes exact colors/camera matrices to the shader and owns its geometry/material disposal', () => {
    const gradient = new SkyGradient(), camera = new THREE.PerspectiveCamera(62, 1.5, 0.1, 400);
    camera.rotation.set(0.3, 0.7, 0); gradient.update(colors, camera);
    expect(gradient.mesh.visible).toBe(true); expect(gradient.mesh.material.depthWrite).toBe(false);
    for (const [name, value] of Object.entries(colors)) expect((gradient.mesh.material.uniforms[name].value as THREE.Color).getHexString()).toBe(value.slice(1));
    expect((gradient.mesh.material.uniforms.inverseProjection.value as THREE.Matrix4).equals(camera.projectionMatrixInverse)).toBe(true);
    expect((gradient.mesh.material.uniforms.cameraRotation.value as THREE.Matrix3).equals(new THREE.Matrix3().setFromMatrix4(camera.matrixWorld))).toBe(true);
    gradient.update(undefined, camera); expect(gradient.mesh.visible).toBe(false);
    const geometry = vi.spyOn(gradient.mesh.geometry, 'dispose'), material = vi.spyOn(gradient.mesh.material, 'dispose'); gradient.dispose();
    expect(geometry).toHaveBeenCalledTimes(1); expect(material).toHaveBeenCalledTimes(1);
  });
  it('renders a gradient background pass without requiring any skybox downloads', () => {
    const { scene, environment } = makeScene(), harness = renderHarness(); scene.userData.authoredSkyColors = colors;
    environment.render(harness.renderer, harness.camera, harness.lights);
    expect(harness.events).toHaveLength(3);
    const gradient = harness.events[0].scene!.children.find(child => child instanceof THREE.Mesh) as THREE.Mesh;
    expect(gradient.visible).toBe(true); expect(gradient.material).toBeInstanceOf(THREE.ShaderMaterial); expect(fetcher).not.toHaveBeenCalled();
    delete scene.userData.authoredSkyColors; harness.events.length = 0;
    environment.render(harness.renderer, harness.camera, harness.lights);
    expect(harness.events).toHaveLength(1); expect(harness.events[0].scene).toBe(scene);
  });
});
