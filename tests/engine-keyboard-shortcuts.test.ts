// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WorldEngine } from '../src/renderer/engine';
import type { TransformEntry, TransformTools } from '../src/renderer/engine/transform-tools';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    shadowMap = {}; capabilities = { getMaxAnisotropy: () => 1 }; info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  } };
});
interface State {
  keys: Set<string>; move(dt: number): void; transformTools: TransformTools;
  camera: THREE.PerspectiveCamera; scene: THREE.Scene; objects: Map<number, TransformEntry>;
}
const engines: WorldEngine[] = [];
function make(onTransform = vi.fn(async () => false)) {
  const canvas = document.createElement('canvas'), captures = new Set<number>();
  Object.defineProperties(canvas, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  canvas.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, bottom: 600, right: 800, width: 800, height: 600, toJSON() {} });
  canvas.setPointerCapture = id => { captures.add(id); };
  canvas.hasPointerCapture = id => captures.has(id);
  canvas.releasePointerCapture = id => { captures.delete(id); pointer(canvas, 'lostpointercapture', { pointerId: id }); };
  canvas.requestPointerLock = vi.fn(async () => {});
  document.body.append(canvas);
  const onAction = vi.fn();
  const engine = new WorldEngine(canvas, { asset: vi.fn(), onAction, onTransform, onPosition: vi.fn(), onSelect: vi.fn(), onStats: vi.fn() });
  engines.push(engine); canvas.focus();
  return { engine, canvas, state: engine as unknown as State, onAction, onTransform, captures };
}
function key(code: string, options: KeyboardEventInit = {}, type = 'keydown') {
  const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...options });
  (document.activeElement ?? window).dispatchEvent(event);
  return event;
}
function pointer(canvas: HTMLCanvasElement, type: string, options: MouseEventInit & { pointerId?: number; movementX?: number; movementY?: number } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 400, clientY: 300, ...options });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 }, movementX: { value: options.movementX ?? 0 }, movementY: { value: options.movementY ?? 0 },
  });
  canvas.dispatchEvent(event); return event;
}
function startTransform(f: ReturnType<typeof make>) {
  f.engine.setObjects([{ id: 1, owner: 2, model: 'wayfarer:cube', description: '', action: '', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 }]);
  f.engine.setSelected(1); f.engine.setBuildMode(true); f.engine.setTransformMode('translate'); f.engine.setTransformEnabled(true);
  f.state.camera.position.set(8, 7, 12); f.state.camera.lookAt(0, 0, 0);
  f.state.camera.updateMatrixWorld(true); f.state.scene.updateMatrixWorld(true);
  const picker = Reflect.get(f.state.transformTools.controls, '_gizmo').picker.translate as THREE.Object3D;
  const handle = picker.children.find(child => child.name === 'X' && child.visible)!;
  const point = new THREE.Box3().setFromObject(handle).getCenter(new THREE.Vector3()).project(f.state.camera);
  const clientX = (point.x + 1) * 400, clientY = (1 - point.y) * 300;
  pointer(f.canvas, 'pointerdown', { clientX, clientY });
  expect(f.state.transformTools.controls.dragging).toBe(true);
  pointer(f.canvas, 'pointermove', { clientX: clientX + 45, clientY: clientY - 8, button: -1, buttons: 1 });
  expect(f.state.objects.get(1)!.root.position.x).not.toBe(0);
  return { clientX: clientX + 45, clientY: clientY - 8 };
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: null, writable: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible', writable: true });
  document.exitPointerLock = vi.fn(() => { Object.assign(document, { pointerLockElement: null }); });
});
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Actual engine keyboard listeners preserve system and editor shortcuts', () => {
  it.each(['metaKey', 'ctrlKey', 'altKey'] as const)('passes every movement/flight chord through with %s, without movement or actions', modifier => {
    const f = make(), before = f.engine.getPosition();
    for (const code of ['KeyQ', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyF', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown']) {
      expect(key(code, { [modifier]: true }).defaultPrevented, code).toBe(false);
      expect(key(code, { [modifier]: true, repeat: true }).defaultPrevented, `${code} repeat`).toBe(false);
      f.state.move(0.05);
      expect(f.engine.getPosition(), code).toEqual(before);
      expect(f.state.keys.size, code).toBe(0);
      expect(key(code, { [modifier]: true }, 'keyup').defaultPrevented, `${code} keyup`).toBe(false);
    }
    expect(f.onAction).not.toHaveBeenCalled(); expect(f.canvas.requestPointerLock).not.toHaveBeenCalled();
  });
  it('reproduces pointer-lock Escape then Command-Q without blocking quit or strafing over two minutes', () => {
    const f = make(); Object.assign(document, { pointerLockElement: f.canvas });
    expect(key('Escape').defaultPrevented).toBe(false);
    Object.assign(document, { pointerLockElement: null }); document.dispatchEvent(new Event('pointerlockchange'));
    const before = f.engine.getPosition();
    expect(key('KeyQ', { metaKey: true }).defaultPrevented).toBe(false);
    key('MetaLeft', {}, 'keyup'); // Chromium may omit Q's keyup while Command is held.
    for (let i = 0; i < 2400; i++) f.state.move(0.05);
    expect(f.engine.getPosition()).toEqual(before); expect(f.state.keys.size).toBe(0);
  });
  it.each(['MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight'])('clears held movement when %s starts, even before shortcut flags are present', code => {
    const f = make(); key('KeyW'); key('ShiftLeft'); f.state.move(0.05);
    const before = f.engine.getPosition();
    expect(key(code).defaultPrevented).toBe(false); expect(f.state.keys.size).toBe(0);
    key(code, {}, 'keyup');
    expect(key('KeyW', { repeat: true }).defaultPrevented).toBe(false);
    f.state.move(0.05); expect(f.engine.getPosition()).toEqual(before);
    key('KeyW', {}, 'keyup'); expect(key('KeyW').defaultPrevented).toBe(true);
    f.state.move(0.05); expect(f.engine.getPosition().z - before.z).toBeCloseTo(0.21);
  });
  it.each(['metaKey', 'ctrlKey', 'altKey'] as const)('clears earlier held keys on a %s chord even if its modifier-down event was missed', modifier => {
    const f = make(); key('KeyA'); key('PageUp');
    const before = f.engine.getPosition();
    expect(key('KeyQ', { [modifier]: true }).defaultPrevented).toBe(false);
    f.state.move(0.05); expect(f.engine.getPosition()).toEqual(before); expect(f.state.keys.size).toBe(0);
  });
  it.each(['MetaLeft', 'ControlRight', 'AltLeft'])('clears held movement on %s keyup if the modifier-down event was missed', code => {
    const f = make(); key('KeyQ'); key('KeyW');
    expect(key(code, {}, 'keyup').defaultPrevented).toBe(false);
    const before = f.engine.getPosition(); f.state.move(0.05);
    expect(f.engine.getPosition()).toEqual(before); expect(f.state.keys.size).toBe(0);
  });
  it('preserves ordinary walking, Q strafe, repeat, Shift sprint, key release, and one-shot flight', () => {
    const f = make(), before = f.engine.getPosition();
    expect(key('KeyW').defaultPrevented).toBe(true); f.state.move(0.05);
    expect(key('KeyW', { repeat: true }).defaultPrevented).toBe(true); f.state.move(0.05);
    expect(f.engine.getPosition().z - before.z).toBeCloseTo(0.42);
    key('KeyW', {}, 'keyup'); key('KeyQ'); key('ShiftRight'); f.state.move(0.05);
    expect(f.engine.getPosition().x - before.x).toBeCloseTo(0.5);
    key('KeyQ', {}, 'keyup'); key('ShiftRight', {}, 'keyup');
    const stopped = f.engine.getPosition(); f.state.move(0.05); expect(f.engine.getPosition()).toEqual(stopped);
    expect(key('KeyF').defaultPrevented).toBe(true); key('KeyF', { repeat: true }); key('KeyF', {}, 'keyup');
    expect(f.onAction).toHaveBeenCalledExactlyOnceWith({ type: 'fly', value: 'true' });
  });
  it('does not move while a text field owns focus and clears a prior chord outside the canvas', () => {
    const f = make(); key('KeyW'); const input = document.createElement('input'); document.body.append(input); input.focus();
    const before = f.engine.getPosition();
    expect(key('KeyA').defaultPrevented).toBe(false); expect(key('KeyW', { metaKey: true }).defaultPrevented).toBe(false);
    f.state.move(0.05); expect(f.engine.getPosition()).toEqual(before);
    f.canvas.focus(); key('KeyW', { repeat: true }); f.state.move(0.05); expect(f.engine.getPosition()).toEqual(before);
  });
  it.each(['window-blur', 'canvas-blur', 'pointer-unlock', 'hidden'])('clears keys on %s and cannot resume from stale key repeats', boundary => {
    const f = make(); key('KeyW'); key('KeyQ'); key('ShiftLeft'); f.state.move(0.05);
    if (boundary === 'window-blur') window.dispatchEvent(new Event('blur'));
    if (boundary === 'canvas-blur') f.canvas.dispatchEvent(new Event('blur'));
    if (boundary === 'pointer-unlock') document.dispatchEvent(new Event('pointerlockchange'));
    if (boundary === 'hidden') { Object.assign(document, { visibilityState: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }
    expect(f.state.keys.size).toBe(0);
    Object.assign(document, { visibilityState: 'visible' }); document.dispatchEvent(new Event('visibilitychange'));
    const stopped = f.engine.getPosition(); key('KeyW', { repeat: true }); key('KeyQ', { repeat: true }); f.state.move(0.05);
    expect(f.engine.getPosition()).toEqual(stopped);
    key('KeyW', {}, 'keyup'); key('KeyQ', {}, 'keyup'); key('KeyW'); f.state.move(0.05);
    expect(f.engine.getPosition().z - stopped.z).toBeCloseTo(0.21);
  });
  it('passes modified and unrelated keys through an actual transform drag but retains plain Escape cancellation', () => {
    const f = make(); startTransform(f); const before = f.engine.getPosition();
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) for (const code of ['KeyQ', 'KeyW', 'KeyA', 'KeyF', 'Space', 'Escape']) {
      expect(key(code, { [modifier]: true }).defaultPrevented, `${modifier} ${code}`).toBe(false);
      expect(f.state.transformTools.busy).toBe(true);
    }
    for (const code of ['Tab', 'F12', 'KeyC']) expect(key(code).defaultPrevented, code).toBe(false);
    expect(key('KeyW').defaultPrevented).toBe(true); f.state.move(0.05);
    expect(f.engine.getPosition()).toEqual(before); expect(f.state.keys.size).toBe(0);
    expect(key('Escape').defaultPrevented).toBe(true);
    expect(f.state.transformTools.busy).toBe(false); expect(f.captures.size).toBe(0);
    expect(f.state.objects.get(1)!.root.position.x).toBe(0); expect(f.onTransform).not.toHaveBeenCalled();
  });
  it('leaves shortcuts unconsumed during a pending transform commit and does not replay movement afterward', async () => {
    let finish!: (accepted: boolean) => void;
    const f = make(vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }))), point = startTransform(f);
    pointer(f.canvas, 'pointerup', point); expect(f.onTransform).toHaveBeenCalledTimes(1);
    expect(f.state.transformTools.busy).toBe(true);
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) expect(key('KeyQ', { [modifier]: true }).defaultPrevented).toBe(false);
    expect(key('Tab').defaultPrevented).toBe(false); expect(key('KeyW').defaultPrevented).toBe(true);
    finish(false); await Promise.resolve(); await Promise.resolve();
    const before = f.engine.getPosition(); key('KeyW', { repeat: true }); f.state.move(0.05);
    expect(f.engine.getPosition()).toEqual(before); expect(f.state.keys.size).toBe(0); expect(f.state.transformTools.busy).toBe(false);
  });
  it('releases camera capture and cancels an actual transform preview when hidden, without committing', () => {
    const f = make(); pointer(f.canvas, 'pointerdown', { button: 2 }); expect(f.captures.size).toBe(1);
    Object.assign(document, { visibilityState: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
    expect(f.captures.size).toBe(0); const before = f.engine.getPosition();
    pointer(f.canvas, 'pointermove', { movementX: 30, movementY: 20 }); expect(f.engine.getPosition()).toEqual(before);
    Object.assign(document, { visibilityState: 'visible' }); document.dispatchEvent(new Event('visibilitychange'));
    const point = startTransform(f);
    Object.assign(document, { visibilityState: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
    expect(f.captures.size).toBe(0); expect(f.state.transformTools.busy).toBe(false);
    expect(f.state.objects.get(1)!.root.position.x).toBe(0);
    pointer(f.canvas, 'pointerup', point); expect(f.onTransform).not.toHaveBeenCalled();
  });
  it('removes keyboard and visibility listeners on disposal', () => {
    const f = make(), cancel = vi.spyOn(f.state.transformTools, 'cancel'); f.engine.dispose(); cancel.mockClear();
    expect(key('KeyQ').defaultPrevented).toBe(false); expect(key('KeyF').defaultPrevented).toBe(false);
    Object.assign(document, { visibilityState: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
    expect(cancel).not.toHaveBeenCalled(); expect(f.state.keys.size).toBe(0); expect(f.onAction).not.toHaveBeenCalled();
  });
});
