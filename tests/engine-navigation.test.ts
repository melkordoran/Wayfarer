import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WorldEngine } from '../src/renderer/engine';
import { createDemoWorld } from '../src/renderer/engine/demo';
import { parseActions } from '../src/renderer/engine/actions';
import { localTeleportAllowed, sameWorld } from '../src/shared/navigation';
import type { Position, WorldObject, WorldSettings } from '../src/shared/types';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    shadowMap = {}; capabilities = { getMaxAnisotropy: () => 1 }; info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  } };
});
const target: Position = { x: 90, y: 5, z: -60, yaw: 2 };
const settings = (): WorldSettings => ({ ...createDemoWorld().settings, demo: false, objectPath: '', canTeleport: false, allowTeleport: false, entry: { x: 3, y: 4, z: 5, yaw: 0 } });
function fakeCanvas() {
  return Object.assign(new EventTarget(), {
    style: {}, clientWidth: 800, clientHeight: 600, width: 800, height: 600,
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 600 }),
    getContext: () => ({ measureText: () => ({ width: 80 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} }),
  }) as unknown as HTMLCanvasElement;
}
const engines: WorldEngine[] = [];
function setup(world = settings()) {
  const onPosition = vi.fn(), onAction = vi.fn();
  const engine = new WorldEngine(fakeCanvas(), { asset: vi.fn().mockRejectedValue(new Error('No network')), onPosition, onAction, onSelect: vi.fn(), onStats: vi.fn() });
  engines.push(engine); engine.setWorld(world); onPosition.mockClear(); onAction.mockClear();
  return { engine, onPosition, onAction };
}
beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null, createElement: fakeCanvas }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('engine navigation permission boundary', () => {
  it('rejects direct manual teleport without changing camera position, movement state, or active transform', () => {
    const { engine, onPosition, onAction } = setup(); const before = engine.getPosition();
    const cancel = vi.spyOn(Reflect.get(engine, 'transformTools'), 'cancel');
    expect(engine.teleport(target)).toBe(false);
    expect(engine.getPosition()).toEqual(before); expect(onPosition).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledWith({ type: 'teleport-denied', value: expect.stringContaining('Local teleporting is disabled') });
  });
  it('retains trusted initial entry and server position even when manual teleporting is denied', () => {
    const { engine, onPosition, onAction } = setup(); expect(engine.getPosition()).toEqual({ ...settings().entry, pitch: 0 });
    expect(engine.applyServerPosition(target)).toBe(true);
    expect(engine.getPosition()).toEqual({ ...target, pitch: 0 }); expect(onPosition).toHaveBeenCalledOnce(); expect(onAction).not.toHaveBeenCalled();
  });
  it('applies rights changes immediately and respects effective caretaker permission', () => {
    const { engine } = setup(); engine.updateWorld({ ...settings(), canTeleport: true, caretaker: true });
    expect(engine.teleport(target)).toBe(true);
    engine.updateWorld(settings()); expect(engine.teleport({ ...target, x: 10 })).toBe(false); expect(engine.getPosition().x).toBe(90);
  });
  it('keeps offline studio navigation available', () => {
    const { engine } = setup({ ...settings(), demo: true }); expect(engine.teleport(target)).toBe(true);
  });
  it.each([
    { ...target, x: NaN }, { ...target, y: Infinity }, { ...target, z: 21474836.48 },
    { ...target, yaw: 1e20 }, { ...target, pitch: -Infinity },
  ])('rejects malformed trusted or action positions %j without emitting movement', position => {
    const { engine, onPosition } = setup(); const before = engine.getPosition();
    expect(engine.applyServerPosition(position)).toBe(false); expect(engine.getPosition()).toEqual(before); expect(onPosition).not.toHaveBeenCalled();
  });
  it.each(['activate teleport 9W 6S 0.5A', 'activate teleport HAVEN 9W 6S 0.5A'])('honors private parsed local object action exception: %s', action => {
    const { engine, onAction } = setup({ ...settings(), name: 'Haven' });
    const object: WorldObject = { id: 10, owner: 1, model: 'test.rwx', description: '', action, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
    const root = new THREE.Group(); root.userData.worldObject = object;
    Reflect.get(engine, 'objects').set(object.id, { root, actions: parseActions(action), object });
    vi.spyOn(Reflect.get(engine, 'ray'), 'intersectObjects').mockReturnValue([{ object: root }]);
    Reflect.get(engine, 'selectAt').call(engine, 400, 300);
    expect(engine.getPosition()).toEqual({ x: 90, y: 5, z: -60, yaw: 0, pitch: 0 });
    expect(onAction).toHaveBeenCalledWith({ type: 'click', object });
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'teleport-denied' }));
  });
  it('forwards parsed cross-world object action for scoped transport without locally applying it', () => {
    const { engine, onAction } = setup({ ...settings(), name: 'Haven' }); const before = engine.getPosition();
    const object: WorldObject = { id: 10, owner: 1, model: 'test.rwx', description: '', action: 'activate teleport Other 9W 6S', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
    const root = new THREE.Group(); root.userData.worldObject = object;
    Reflect.get(engine, 'objects').set(object.id, { root, actions: parseActions(object.action), object });
    vi.spyOn(Reflect.get(engine, 'ray'), 'intersectObjects').mockReturnValue([{ object: root }]);
    Reflect.get(engine, 'selectAt').call(engine, 400, 300);
    expect(engine.getPosition()).toEqual(before);
    expect(onAction).toHaveBeenCalledWith({ type: 'teleport', value: 'Other 9W 6S', object });
  });
  it('does not react or notify after disposal', () => {
    const { engine, onAction, onPosition } = setup(); engine.dispose(); onAction.mockClear(); onPosition.mockClear();
    expect(engine.teleport(target)).toBe(false); expect(engine.applyServerPosition(target)).toBe(false);
    expect(onAction).not.toHaveBeenCalled(); expect(onPosition).not.toHaveBeenCalled();
  });
});

describe('normalized and legacy navigation settings', () => {
  it('trusts an explicit normalized permission rather than inferring identity rights', () => {
    expect(localTeleportAllowed({ ...settings(), canTeleport: false, caretaker: true })).toBe(false);
    expect(localTeleportAllowed({ ...settings(), canTeleport: true, caretaker: false })).toBe(true);
    expect(localTeleportAllowed({ ...settings(), canTeleport: undefined, caretaker: true })).toBe(true);
    expect(localTeleportAllowed({ ...settings(), canTeleport: undefined })).toBe(false);
    expect(localTeleportAllowed(undefined)).toBe(true);
  });
  it('compares user-entered world names without case or whitespace bypasses', () => {
    expect(sameWorld('  HAVEN ', 'Haven')).toBe(true); expect(sameWorld('Elsewhere', 'Haven')).toBe(false);
  });
});
