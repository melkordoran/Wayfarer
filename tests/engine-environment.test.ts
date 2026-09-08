import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { EnvironmentController, applyWaterAppearance, flightAllowed, terrainElevation, waterAppearance, type EnvironmentMode } from '../src/renderer/engine/environment';
import { WorldEngine } from '../src/renderer/engine';
import { createDemoWorld } from '../src/renderer/engine/demo';
import type { WorldSettings } from '../src/shared/types';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    shadowMap = {}; capabilities = { getMaxAnisotropy: () => 1 }; info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  } };
});

function resources() {
  const value = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(62, 1, 0.1, 1200),
    sun: new THREE.DirectionalLight(), ambient: new THREE.AmbientLight(), hemi: new THREE.HemisphereLight(),
    renderer: { toneMappingExposure: 1, shadowMap: { enabled: true } } };
  value.scene.add(value.sun, value.sun.target, value.ambient, value.hemi);
  return { ...value, controller: new EnvironmentController(value) };
}
const position = { x: 12, y: 3, z: -29, yaw: 0 };
const authored = (): WorldSettings => ({ ...createDemoWorld().settings, demo: false, fogEnabled: true, fogMin: 12, fogMax: 350,
  fogColor: '#aa3300', ambientColor: '#102030', lightColor: '#fedcba', skyColor: '#102040', lightDirection: { x: 0.5, y: -1, z: 0.25 },
  waterEnabled: true, waterColor: '#123456', waterOpacity: 128 / 255, waterLevel: 4.75, terrainOffset: -0.1 });

describe('authored environment controller', () => {
  it('uses true ambient and directional colors without preset fill in world mode', () => {
    const view = resources(), settings = authored(); view.controller.apply(settings, 'world', position);
    expect(view.ambient.color.getHexString()).toBe('102030'); expect(view.ambient.intensity).toBe(1); expect(view.hemi.intensity).toBe(0);
    expect(view.sun.color.getHexString()).toBe('fedcba'); expect(view.sun.intensity).toBe(1);
    expect((view.scene.background as THREE.Color).getHexString()).toBe('102040');
    expect(view.renderer.toneMappingExposure).toBe(1);
  });
  it.each([
    [{ x: -1, y: 0, z: 0 }, [1, 0, 0]],
    [{ x: 0, y: -1, z: 0 }, [0, 1, 0]],
    [{ x: 0, y: 0, z: -1 }, [0, 0, 1]],
  ])('places the source opposite the documented shine-to vector %j', (direction, expected) => {
    const view = resources(); view.controller.apply({ ...authored(), lightDirection: direction }, 'world', position);
    expect(view.sun.position.clone().sub(view.sun.target.position).normalize().toArray()).toEqual(expected);
    view.controller.follow({ x: -420, y: 19, z: 2450, yaw: 2 });
    expect(view.sun.position.clone().sub(view.sun.target.position).normalize().toArray()).toEqual(expected);
  });
  it('retains ambient but invents no directional sun for a zero authored vector', () => {
    const view = resources(); view.controller.apply({ ...authored(), lightDirection: { x: 0, y: 0, z: 0 } }, 'world', position);
    expect(view.sun.intensity).toBe(0); expect(view.ambient.intensity).toBe(1);
    view.controller.apply(authored(), 'world', position); expect(view.sun.intensity).toBe(1);
  });
  it.each(['world', 'day', 'sunset', 'night'] as EnvironmentMode[])('honors disabled fog and authored visibility even under %s lighting', mode => {
    const view = resources(); view.controller.apply({ ...authored(), fogEnabled: false, fogMax: 432, disableShadows: true }, mode, position);
    expect(view.scene.fog).toBeNull(); expect(view.camera.far).toBe(432);
    expect(view.renderer.shadowMap.enabled).toBe(false); expect(view.sun.castShadow).toBe(false);
  });
  it.each(['world', 'day', 'sunset', 'night'] as EnvironmentMode[])('retains enabled fog color and distances under %s lighting', mode => {
    const view = resources(); view.controller.apply(authored(), mode, position);
    const fog = view.scene.fog as THREE.Fog;
    expect(fog.color.getHexString()).toBe('aa3300'); expect(fog.near).toBe(12); expect(fog.far).toBe(350);
  });
  it('keeps all rendering values finite for malformed ranges, direction, and colors', () => {
    const view = resources(); view.controller.apply({ ...authored(), fogMin: Infinity, fogMax: NaN, lightDirection: { x: NaN, y: Infinity, z: -Infinity }, ambientColor: 'invalid' }, 'world', position);
    expect(view.camera.far).toBe(1200); expect((view.scene.fog as THREE.Fog).near).toBe(65);
    expect(view.sun.intensity).toBe(0); expect([...view.sun.position].every(Number.isFinite)).toBe(true);
    view.controller.apply({ ...authored(), fogMin: 900, fogMax: 0 }, 'world', position);
    expect((view.scene.fog as THREE.Fog).near).toBeLessThan((view.scene.fog as THREE.Fog).far);
    expect(view.camera.far).toBeGreaterThan(view.camera.near);
  });
  it('restores authored colors and exposure after a local Golden hour preview', () => {
    const view = resources(); view.controller.apply(authored(), 'sunset', position);
    expect(view.sun.color.getHexString()).toBe('ffc48b'); expect(view.hemi.intensity).toBe(1.6);
    view.controller.apply(authored(), 'world', position);
    expect(view.sun.color.getHexString()).toBe('fedcba'); expect(view.hemi.intensity).toBe(0);
  });
  it('applies normalized opacity and metre water height, including fully transparent and opaque surfaces', () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
    try {
      applyWaterAppearance(mesh, authored());
      expect(mesh.material.color.getHexString()).toBe('123456'); expect(mesh.material.opacity).toBe(128 / 255);
      expect(mesh.position.y).toBe(4.75); expect(mesh.material.transparent).toBe(true); expect(mesh.material.depthWrite).toBe(false);
      applyWaterAppearance(mesh, { ...authored(), waterOpacity: 0 }); expect(mesh.visible).toBe(false);
      applyWaterAppearance(mesh, { ...authored(), waterOpacity: 1 });
      expect(mesh.visible).toBe(true); expect(mesh.material.transparent).toBe(false); expect(mesh.material.depthWrite).toBe(true);
      expect(waterAppearance({ ...authored(), waterOpacity: NaN }).opacity).toBe(0.72);
      expect(terrainElevation({ ...authored(), terrainOffset: NaN })).toBe(0);
    } finally { mesh.geometry.dispose(); mesh.material.dispose(); }
  });
  it('uses effective capability including caretaker override without guessing it from identity', () => {
    expect(flightAllowed({ ...authored(), allowFlying: false, canFly: true })).toBe(true);
    expect(flightAllowed({ ...authored(), allowFlying: false, canFly: false })).toBe(false);
    expect(flightAllowed({ ...authored(), allowFlying: false })).toBe(false);
    expect(flightAllowed(createDemoWorld().settings)).toBe(true);
  });
});

function fakeCanvas() {
  return Object.assign(new EventTarget(), {
    style: {}, clientWidth: 800, clientHeight: 600, width: 800, height: 600,
    getContext: () => ({ measureText: () => ({ width: 80 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} }),
  }) as unknown as HTMLCanvasElement;
}
const engines: WorldEngine[] = [];
type Internals = { terrain: Map<string, THREE.Mesh>; water: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>; ground: THREE.Mesh; fly: boolean; move(dt: number): void; keys: Set<string>; camera: THREE.PerspectiveCamera; sun: THREE.DirectionalLight; scene: THREE.Scene };
const inspect = (engine: WorldEngine) => engine as unknown as Internals;
function makeEngine(settings = authored()) {
  const canvas = fakeCanvas(), action = vi.fn();
  const engine = new WorldEngine(canvas, { asset: vi.fn().mockRejectedValue(new Error('No network')), onPosition: vi.fn(), onSelect: vi.fn(), onStats: vi.fn(), onAction: action });
  engines.push(engine); engine.setWorld(settings);
  Object.assign(document, { activeElement: canvas });
  return { engine, action, view: inspect(engine) };
}
function key(code: string, type = 'keydown', repeat = false) { window.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, repeat })); }
beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null, createElement: fakeCanvas }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('environment engine integration', () => {
  it('moves terrain and its actual raycast surface without mutating tile samples or replacing geometry', () => {
    const settings = authored(), { engine, view } = makeEngine(settings);
    const tile = { pageX: 0, pageZ: 0, nodeX: 64, nodeZ: 64, size: 2, heights: [2], textures: [0] };
    engine.setTerrain(tile); const mesh = [...view.terrain.values()][0], geometry = mesh.geometry;
    expect(mesh.position.y).toBe(-0.1);
    const ray = new THREE.Raycaster(new THREE.Vector3(10, 20, 10), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(mesh)[0].point.y).toBeCloseTo(1.9);
    engine.teleport(position); engine.updateWorld({ ...settings, terrainOffset: 3.5, waterLevel: -2, waterOpacity: 1 });
    expect(mesh.geometry).toBe(geometry); expect(tile.heights).toEqual([2]); expect(engine.getPosition()).toEqual({ ...position, pitch: 0 });
    expect(ray.intersectObject(mesh)[0].point.y).toBeCloseTo(5.5);
    expect(view.water.position.y).toBe(-2); expect(view.water.material.opacity).toBe(1);
    expect(view.ground.position.y).toBeCloseTo(3.45);
  });
  it.each(['KeyF', 'Space', 'PageUp', 'PageDown'])('blocks %s flight requests and repeated-key notification floods', code => {
    const settings = { ...authored(), terrainEnabled: false, canFly: false, allowFlying: false }, { engine, view, action } = makeEngine(settings);
    const before = engine.getPosition().y;
    key(code); key(code, 'keydown', true); view.move(0.05);
    expect(view.fly).toBe(false); expect(engine.getPosition().y).toBe(before);
    expect(action.mock.calls.filter(([value]) => value.type === 'flight-denied')).toHaveLength(1);
  });
  it('honors caretaker capability then immediately revokes active flight and held vertical keys', () => {
    const settings = { ...authored(), terrainEnabled: false, allowFlying: false, canFly: true }, { engine, view, action } = makeEngine(settings);
    expect(engine.setFlying(true)).toBe(true); key('PageUp'); view.move(0.05);
    const y = engine.getPosition().y; expect(y).toBeGreaterThan(settings.entry.y);
    engine.updateWorld({ ...settings, canFly: false });
    expect(view.fly).toBe(false); expect(view.keys.has('PageUp')).toBe(false);
    expect(action.mock.calls.at(-1)![0]).toEqual({ type: 'fly', value: 'false' });
    view.move(0.05); expect(engine.getPosition().y).toBe(y); expect(engine.setFlying(true)).toBe(false);
  });
  it.each([true, false])('notifies the UI of a world flight reset even when destination canFly=%s', canFly => {
    const { engine, view, action } = makeEngine({ ...authored(), canFly: true });
    engine.setFlying(true); key('PageUp'); action.mockClear();
    engine.setWorld({ ...authored(), name: 'Destination', canFly });
    expect(view.fly).toBe(false); expect(view.keys.has('PageUp')).toBe(false);
    expect(action.mock.calls.filter(([event]) => event.type === 'fly')).toEqual([[{ type: 'fly', value: 'false' }]]);
  });
  it('updates authored lights and visibility in place without moving the player or changing local preset fog policy', () => {
    const { engine, view } = makeEngine(); engine.setEnvironmentMode('world'); engine.teleport(position);
    const settings = { ...authored(), fogEnabled: false, fogMax: 72, lightDirection: { x: 0, y: -1, z: 0 }, ambientColor: '#ffffff' };
    engine.updateWorld(settings);
    expect(view.scene.fog).toBeNull(); expect(view.camera.far).toBe(72); expect(engine.getPosition()).toEqual({ ...position, pitch: 0 });
    expect(view.sun.position.clone().sub(view.sun.target.position).normalize().toArray()).toEqual([0, 1, 0]);
    engine.setTimeOfDay('night'); expect(view.scene.fog).toBeNull(); expect(view.camera.far).toBe(72);
  });
});
