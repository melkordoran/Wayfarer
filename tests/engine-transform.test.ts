import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WorldEngine } from '../src/renderer/engine';
import { selectionCentre, transformObjects, TransformTools, type TransformChange, type TransformEntry } from '../src/renderer/engine/transform-tools';
import { createDemoWorld } from '../src/renderer/engine/demo';
import type { WorldObject } from '../src/shared/types';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    shadowMap = {}; capabilities = { getMaxAnisotropy: () => 1 }; info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  } };
});
const object = (id = 1, x = 0): WorldObject => ({ id, owner: 2, model: 'wayfarer:cube', description: 'Original', action: '', x, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 });
const quaternion = (object: WorldObject) => new THREE.Quaternion().setFromEuler(new THREE.Euler(object.pitch, object.yaw, object.roll, 'YXZ'));
interface State { scene: THREE.Scene; camera: THREE.PerspectiveCamera; objects: Map<number, TransformEntry>; transformTools: TransformTools; selectedId: number | null; selectedIds: Set<number>; keys: Set<string>; move(dt: number): void; selectionHelpers: Map<number, THREE.BoxHelper> }
const inspect = (engine: WorldEngine) => engine as unknown as State;
const engines: WorldEngine[] = [];
function make(onTransform = vi.fn<(changes: TransformChange[]) => Promise<boolean>>(async () => false)) {
  const captures = new Set<number>();
  const canvas = Object.assign(new EventTarget(), {
    style: {}, clientWidth: 800, clientHeight: 600,
    focus() { Object.assign(document, { activeElement: canvas }); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture(id: number) { captures.add(id); },
    hasPointerCapture(id: number) { return captures.has(id); },
    releasePointerCapture(id: number) { captures.delete(id); canvas.dispatchEvent(Object.assign(new Event('lostpointercapture'), { pointerId: id })); },
  }) as unknown as HTMLCanvasElement;
  const onSelect = vi.fn(), onAction = vi.fn();
  const engine = new WorldEngine(canvas, { asset: vi.fn(), onSelect, onTransform, onAction, onPosition: vi.fn(), onStats: vi.fn() });
  engines.push(engine); engine.setWorld(createDemoWorld().settings);
  engine.setObjects([object(1, -1), object(2, 1)]); engine.setSelection([1, 2]); engine.setBuildMode(true);
  engine.setTransformEnabled(true); engine.setTransformMode('translate');
  const state = inspect(engine);
  state.camera.position.set(8, 7, 12); state.camera.lookAt(0, 0, 0); state.camera.updateMatrixWorld(true); state.scene.updateMatrixWorld(true);
  return { engine, state, canvas, captures, onTransform, onSelect, onAction };
}
type Fixture = ReturnType<typeof make>;
function event(f: Fixture, type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  f.canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointermove' ? 1 : 0, pointerId: 1, pointerType: 'mouse', movementX: 0, movementY: 0, ...extra }));
}
function handlePoint(f: Fixture, axis = 'X') {
  f.state.camera.updateMatrixWorld(true); f.state.scene.updateMatrixWorld(true);
  const gizmo = Reflect.get(f.state.transformTools.controls, '_gizmo');
  const picker = gizmo.picker[f.state.transformTools.controls.mode] as THREE.Object3D;
  const handle = picker.children.find(child => child.name === axis && child.visible)!;
  expect(handle).toBeTruthy();
  if (f.state.transformTools.controls.mode !== 'rotate') {
    const point = new THREE.Box3().setFromObject(handle).getCenter(new THREE.Vector3()).project(f.state.camera);
    f.state.transformTools.controls.pointerHover({ x: point.x, y: point.y, button: 0 } as unknown as PointerEvent);
    if (f.state.transformTools.controls.axis === axis) return { x: (point.x + 1) * 400, y: (1 - point.y) * 300 };
  }
  {
    const geometry = (handle as THREE.Mesh).geometry, positions = geometry.getAttribute('position'), index = geometry.getIndex();
    for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
      const point = new THREE.Vector3();
      for (let corner = 0; corner < 3; corner++) point.add(new THREE.Vector3().fromBufferAttribute(positions, index ? index.getX(i + corner) : i + corner));
      point.multiplyScalar(1 / 3).applyMatrix4(handle.matrixWorld).project(f.state.camera);
      f.state.transformTools.controls.pointerHover({ x: point.x, y: point.y, button: 0 } as unknown as PointerEvent);
      if (f.state.transformTools.controls.axis === axis) return { x: (point.x + 1) * 400, y: (1 - point.y) * 300 };
    }
    throw new Error(`No visible ${axis} ${f.state.transformTools.controls.mode} handle could be raycast`);
  }
}
function start(f: Fixture) {
  const point = handlePoint(f);
  event(f, 'pointerdown', point.x, point.y);
  expect(f.state.transformTools.controls.dragging).toBe(true);
  expect(f.state.transformTools.controls.axis).toBe('X');
  return point;
}
function drag(f: Fixture, pixels = 45) {
  const point = start(f);
  event(f, 'pointermove', point.x + pixels, point.y - 8);
  expect(f.state.objects.get(1)!.root.position.x).not.toBe(-1);
  return { x: point.x + pixels, y: point.y - 8 };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const position = (o: WorldObject) => new THREE.Vector3(o.x, o.y, o.z);
function local(f: Fixture) {
  const originals = [
    { ...object(1, -1.13), y: 0.27, z: -0.61, pitch: 0.4, yaw: 0.7, roll: -0.2 },
    { ...object(2, 1.57), y: 0.39, z: 0.27, pitch: -0.35, yaw: 0.6, roll: 0.25 },
  ];
  f.engine.setObjects(originals); f.engine.setSelection([1, 2], 2); f.engine.setTransformSpace('local');
  return { originals, centre: selectionCentre(originals), frame: quaternion(originals[1]) };
}
function startAxis(f: Fixture, axis: string) {
  const point = handlePoint(f, axis); event(f, 'pointerdown', point.x, point.y);
  expect(f.state.transformTools.controls.dragging).toBe(true); expect(f.state.transformTools.controls.axis).toBe(axis);
  return point;
}
beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('AW world-space transform mathematics', () => {
  it('translates around the three-dimensional origin centroid without changing rotations or object metadata', () => {
    const objects = [{ ...object(1, -2), y: 2, yaw: 8 * Math.PI, action: 'create scale 2', data: 'AQI=' }, { ...object(2, 2), y: 4 }];
    const centre = selectionCentre(objects); expect(centre.toArray()).toEqual([0, 3, 0]);
    const changes = transformObjects(objects, centre, centre.clone().add(new THREE.Vector3(3, -1, 5)), new THREE.Quaternion());
    expect(changes[0]).toEqual({ before: objects[0], after: { ...objects[0], x: 1, y: 1, z: 5 } });
    expect(changes[0].before).not.toBe(objects[0]); expect(changes[0].after).not.toBe(objects[0]);
    expect(objects[0].x).toBe(-2);
  });
  it.each([
    [new THREE.Vector3(0, 1, 0), Math.PI / 2],
    [new THREE.Vector3(1, 0, 0), Math.PI / 4],
    [new THREE.Vector3(0, 0, 1), -Math.PI / 3],
    [new THREE.Vector3(1, 2, 3).normalize(), Math.PI],
  ])('preserves compound YXZ orientations under a world-space rotation (%j, %s)', (axis, angle) => {
    const objects = [{ ...object(1, -2), pitch: 0.4, yaw: 0.8, roll: -0.3 }, { ...object(2, 2), pitch: Math.PI / 2, yaw: -1, roll: 0.2 }];
    const centre = selectionCentre(objects), delta = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    const changes = transformObjects(objects, centre, centre, delta);
    for (let i = 0; i < changes.length; i++) {
      expect(quaternion(changes[i].after).angleTo(quaternion(objects[i]).premultiply(delta))).toBeLessThan(1e-7);
      const expected = new THREE.Vector3(objects[i].x, 0, 0).applyQuaternion(delta);
      expect(new THREE.Vector3(changes[i].after.x, changes[i].after.y, changes[i].after.z).distanceTo(expected)).toBeLessThan(1e-8);
    }
  });
  it('rejects invalid or oversized selections, nonfinite transforms, and out-of-world results', () => {
    expect(() => selectionCentre([])).toThrow();
    expect(() => selectionCentre([object(), object()])).toThrow();
    expect(() => selectionCentre(Array.from({ length: 257 }, (_, id) => object(id)))).toThrow();
    expect(() => transformObjects([object()], new THREE.Vector3(), new THREE.Vector3(Infinity, 0, 0), new THREE.Quaternion())).toThrow();
    expect(() => transformObjects([object()], new THREE.Vector3(), new THREE.Vector3(), new THREE.Quaternion(0, 0, 0, 0))).toThrow();
    expect(() => transformObjects([object()], new THREE.Vector3(), new THREE.Vector3(21474837, 0, 0), new THREE.Quaternion())).toThrow('world coordinates');
  });
});

describe('Primary-authored local frames with real Three raycasts', () => {
  it('uses the explicit primary property quaternion and 3D property centroid, immune to visual animation and nonuniform action scale', () => {
    const f = make(), { originals, centre, frame } = local(f);
    f.engine.setObjects([{ ...originals[1], action: 'create scale 2 3 4' }]);
    const root = f.state.objects.get(2)!.root;
    root.quaternion.setFromEuler(new THREE.Euler(1.1, -0.9, 0.6));
    f.state.transformTools.sync();
    expect(f.state.transformTools.pivot.quaternion.angleTo(frame)).toBeLessThan(1e-7);
    expect(f.state.transformTools.pivot.position.distanceTo(centre)).toBeLessThan(1e-10);
    expect(root.scale.toArray()).toEqual([2, 3, 4]);
    expect(f.state.transformTools.pivot.scale.toArray()).toEqual([1, 1, 1]);
    expect(f.state.transformTools.controls.space).toBe('local');
    f.engine.setTransformSpace('world');
    expect(f.state.transformTools.pivot.quaternion.toArray()).toEqual([0, 0, 0, 1]);
  });
  it.each(['X', 'Y', 'Z', 'XY', 'XZ', 'YZ', 'XYZ'])('snaps %s displacement in the frozen local basis, not the rotated absolute world grid', async axis => {
    const f = make(), { originals, centre, frame } = local(f);
    f.state.camera.position.copy(new THREE.Vector3(8, 7, 12).applyQuaternion(frame).add(centre)); f.state.camera.lookAt(centre);
    f.engine.setTransformSnap({ translation: 0.5, rotation: Math.PI / 12 });
    expect(f.state.transformTools.controls.translationSnap).toBeNull();
    const point = startAxis(f, axis);
    event(f, 'pointermove', point.x, point.y);
    expect(f.state.transformTools.pivot.position.distanceTo(centre)).toBeLessThan(1e-10);
    event(f, 'pointermove', point.x + 48, point.y - 38);
    const delta = f.state.transformTools.pivot.position.clone().sub(centre);
    expect(delta.length()).toBeGreaterThan(0.1);
    const localDelta = delta.clone().applyQuaternion(frame.clone().invert());
    for (const component of ['x', 'y', 'z'] as const) {
      if (axis.includes(component.toUpperCase())) expect(localDelta[component] / 0.5).toBeCloseTo(Math.round(localDelta[component] / 0.5), 10);
      else expect(localDelta[component]).toBeCloseTo(0, 10);
    }
    for (const original of originals) {
      const entry = f.state.objects.get(original.id)!;
      expect(entry.root.position.distanceTo(position(original).add(delta))).toBeLessThan(1e-8);
      expect(entry.root.quaternion.angleTo(quaternion(original))).toBeLessThan(1e-7);
      expect(entry.object).toEqual(original);
    }
    event(f, 'pointerup', point.x + 48, point.y - 38);
    expect(f.onTransform).toHaveBeenCalledTimes(1);
    for (const change of f.onTransform.mock.calls[0][0]) {
      expect(position(change.after).distanceTo(position(change.before).add(delta))).toBeLessThan(1e-8);
      expect([change.after.pitch, change.after.yaw, change.after.roll]).toEqual([change.before.pitch, change.before.yaw, change.before.roll]);
    }
    await flush();
  });
  it.each(['X', 'Y', 'Z'])('snaps incremental local %s rotation and applies one identical world delta to group positions, visual previews and commit', async axis => {
    const f = make(), { originals, centre, frame } = local(f);
    f.engine.setObjects([{ ...originals[0], action: 'create scale 2 3 4' }]);
    const animated = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.8, -0.6, 0.7, 'YXZ'));
    f.state.objects.get(1)!.root.quaternion.copy(animated);
    f.engine.setTransformMode('rotate'); f.engine.setTransformSnap({ translation: 0, rotation: Math.PI / 12 });
    const point = startAxis(f, axis);
    event(f, 'pointermove', point.x + 65, point.y + 37);
    const delta = f.state.transformTools.pivot.quaternion.clone().multiply(frame.clone().invert());
    const worldAxis = new THREE.Vector3(axis === 'X' ? 1 : 0, axis === 'Y' ? 1 : 0, axis === 'Z' ? 1 : 0).applyQuaternion(frame);
    expect(worldAxis.clone().applyQuaternion(delta).distanceTo(worldAxis)).toBeLessThan(1e-8);
    const angle = delta.angleTo(new THREE.Quaternion());
    expect(angle).toBeGreaterThan(0.01); expect(angle / (Math.PI / 12)).toBeCloseTo(Math.round(angle / (Math.PI / 12)), 7);
    for (const original of originals) {
      const entry = f.state.objects.get(original.id)!;
      const expectedPosition = position(original).sub(centre).applyQuaternion(delta).add(centre);
      expect(entry.root.position.distanceTo(expectedPosition)).toBeLessThan(1e-8);
      expect(entry.root.quaternion.angleTo((original.id === 1 ? animated.clone() : quaternion(original)).premultiply(delta))).toBeLessThan(1e-7);
    }
    expect(f.state.objects.get(1)!.root.scale.toArray()).toEqual([2, 3, 4]);
    event(f, 'pointerup', point.x + 65, point.y + 37);
    const changes = f.onTransform.mock.calls[0][0];
    for (const change of changes) {
      expect(quaternion(change.after).angleTo(quaternion(change.before).premultiply(delta))).toBeLessThan(1e-7);
      expect(position(change.after).distanceTo(position(change.before).sub(centre).applyQuaternion(delta).add(centre))).toBeLessThan(1e-8);
    }
    expect(position(changes[0].after).distanceTo(position(changes[1].after))).toBeCloseTo(position(originals[0]).distanceTo(position(originals[1])), 10);
    await flush();
    expect(f.state.objects.get(1)!.root.quaternion.angleTo(animated)).toBeLessThan(1e-7);
  });
  it.each(['X', 'Y', 'Z'].flatMap(axis => [1, -1].flatMap(cameraSign => [0, Math.PI / 12].map(snap => ({ axis, cameraSign, snap })))))('uses the authored ring axis when it points exactly toward/away from the camera (%j)', async ({ axis: axisName, cameraSign, snap }) => {
    const f = make();
    const orientation = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(0.5, 0.5, 0.5, 0.5), 'YXZ');
    const originals = [{ ...object(1, -1.2), y: 0.6, z: 0.3 }, { ...object(2, 1.6), y: 0.2, z: -0.1, pitch: orientation.x, yaw: orientation.y, roll: orientation.z }];
    f.engine.setObjects(originals); f.engine.setSelection([1, 2], 2); f.engine.setTransformSpace('local'); f.engine.setTransformMode('rotate');
    f.engine.setTransformSnap({ translation: 0, rotation: snap });
    const centre = selectionCentre(originals), frame = quaternion(originals[1]), axis = new THREE.Vector3(axisName === 'X' ? 1 : 0, axisName === 'Y' ? 1 : 0, axisName === 'Z' ? 1 : 0).applyQuaternion(frame);
    f.state.camera.position.copy(centre).addScaledVector(axis, cameraSign * 15);
    f.state.camera.up.copy(Math.abs(axis.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)); f.state.camera.lookAt(centre);
    const point = startAxis(f, axisName);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, centre);
    const startPoint = f.state.transformTools.controls.getRaycaster().ray.intersectPlane(plane, new THREE.Vector3())!;
    const desired = new THREE.Quaternion().setFromAxisAngle(axis, cameraSign * 0.71);
    const endPoint = startPoint.clone().sub(centre).applyQuaternion(desired).add(centre).project(f.state.camera);
    event(f, 'pointermove', (endPoint.x + 1) * 400, (1 - endPoint.y) * 300);
    const expected = new THREE.Quaternion().setFromAxisAngle(axis, cameraSign * (snap ? Math.PI / 4 : 0.71));
    const actual = f.state.transformTools.pivot.quaternion.clone().multiply(frame.clone().invert());
    expect(actual.angleTo(expected)).toBeLessThan(1e-7);
    event(f, 'pointerup', (endPoint.x + 1) * 400, (1 - endPoint.y) * 300);
    expect(f.onTransform).toHaveBeenCalledTimes(1);
    for (const change of f.onTransform.mock.calls[0][0]) expect(quaternion(change.after).angleTo(quaternion(change.before).premultiply(expected))).toBeLessThan(1e-7);
    await flush();
  });
  it('returns to the exact drag origin through repeated local snapped pointer moves without cumulative drift', () => {
    const f = make(), { centre, originals } = local(f); f.engine.setTransformSnap({ translation: 0.25, rotation: 0 });
    const point = startAxis(f, 'X');
    for (const pixels of [30, -50, 10, 75, -30, 0]) event(f, 'pointermove', point.x + pixels, point.y - pixels / 2);
    expect(f.state.transformTools.pivot.position.distanceTo(centre)).toBeLessThan(1e-9);
    event(f, 'pointerup', point.x, point.y); expect(f.onTransform).not.toHaveBeenCalled();
    for (const original of originals) expect(f.state.objects.get(original.id)!.root.position.distanceTo(position(original))).toBeLessThan(1e-9);
  });
  it('validates transform spaces and lets standalone adapters explicitly fall back to first-entry primary', () => {
    const f = make(), { frame, originals } = local(f);
    expect(() => f.state.transformTools.setSpace('screen' as 'world')).toThrow('Unsupported transform space');
    const entries = [...f.state.objects.values()].reverse();
    const tools = new TransformTools(new THREE.Scene(), f.state.camera, f.canvas, {
      entries: () => entries, current: id => entries.find(entry => entry.object.id === id), commit: vi.fn(async () => false), started: vi.fn(), changed: vi.fn(), error: vi.fn(),
    });
    try {
      tools.setBuilding(true); tools.setEnabled(true); tools.setMode('translate'); tools.setSpace('local');
      expect(tools.controls.enabled).toBe(true); expect(tools.pivot.quaternion.angleTo(frame)).toBeLessThan(1e-7);
      expect(tools.pivot.position.distanceTo(selectionCentre(originals))).toBeLessThan(1e-10);
    } finally { tools.dispose(); }
  });
  it.each(['translate', 'rotate'] as const)('does not apply the initial local frame or snap an off-grid origin on a %s click', mode => {
    const f = make(), { originals } = local(f); f.engine.setTransformMode(mode); f.engine.setTransformSnap({ translation: 0.5, rotation: Math.PI / 12 });
    const point = startAxis(f, 'X'); event(f, 'pointermove', point.x, point.y); event(f, 'pointerup', point.x, point.y);
    expect(f.onTransform).not.toHaveBeenCalled(); expect(f.onSelect).not.toHaveBeenCalled();
    expect(f.state.transformTools.busy).toBe(false);
    for (const original of originals) expect(f.state.objects.get(original.id)!.root.position.distanceTo(position(original))).toBeLessThan(1e-10);
  });
  it.each(['space', 'translation-snap', 'rotation-snap', 'mode', 'primary', 'frame', 'null-primary'])('restores local previews and suppresses release after a %s change', reason => {
    const f = make(), { originals } = local(f), point = startAxis(f, 'X');
    event(f, 'pointermove', point.x + 45, point.y - 8);
    expect(f.state.transformTools.busy).toBe(true);
    if (reason === 'space') f.engine.setTransformSpace('world');
    if (reason === 'translation-snap') f.engine.setTransformSnap({ translation: 0.5, rotation: 0 });
    if (reason === 'rotation-snap') f.engine.setTransformSnap({ translation: 0, rotation: Math.PI / 12 });
    if (reason === 'mode') f.engine.setTransformMode('rotate');
    if (reason === 'primary') f.engine.setSelection([1, 2], 1);
    if (reason === 'frame') f.engine.setObjects([{ ...originals[1], yaw: 0.9 }]);
    if (reason === 'null-primary') f.engine.setSelection([1, 2], null);
    expect(f.state.transformTools.busy).toBe(false); expect(f.captures.size).toBe(0);
    for (const original of originals) expect(f.state.objects.get(original.id)!.root.position.distanceTo(position(original))).toBeLessThan(1e-8);
    event(f, 'pointerup', point.x + 45, point.y - 8); expect(f.onTransform).not.toHaveBeenCalled(); expect(f.onSelect).not.toHaveBeenCalled();
    if (reason === 'primary') expect(f.state.transformTools.pivot.quaternion.angleTo(quaternion(originals[0]))).toBeLessThan(1e-7);
    if (reason === 'frame') expect(f.state.transformTools.pivot.quaternion.angleTo(quaternion({ ...originals[1], yaw: 0.9 }))).toBeLessThan(1e-7);
    if (reason === 'null-primary') expect(f.state.transformTools.controls.enabled).toBe(false);
  });
  it('retains the local frame and active drag across identical options and selection reorder with the same primary', () => {
    const f = make(), { frame } = local(f), point = startAxis(f, 'X');
    event(f, 'pointermove', point.x + 45, point.y - 8);
    const preview = f.state.transformTools.pivot.position.clone();
    f.engine.setTransformSpace('local'); f.engine.setTransformSnap({ translation: 0, rotation: 0 }); f.engine.setSelection([2, 1], 2);
    expect(f.state.transformTools.controls.dragging).toBe(true);
    expect(f.state.transformTools.pivot.position.distanceTo(preview)).toBeLessThan(1e-8);
    expect(f.state.transformTools.pivot.quaternion.angleTo(frame)).toBeLessThan(1e-7);
  });
  it('retains a nonfirst primary and local drag when an additive 257th selection is refused; explicit null still disables local handles', () => {
    const f = make();
    const objects = Array.from({ length: 257 }, (_, i) => ({ ...object(i + 1, i % 2 ? 1 : -1), pitch: 0.2, yaw: i === 127 ? 0.6 : -0.3, roll: 0.1 }));
    f.engine.setObjects(objects, true); f.engine.setSelection(objects.slice(0, 256).map(o => o.id), 128); f.engine.setTransformSpace('local');
    const point = startAxis(f, 'X'); event(f, 'pointermove', point.x + 45, point.y - 8);
    const preview = f.state.transformTools.pivot.position.clone(), frame = f.state.transformTools.pivot.quaternion.clone();
    f.engine.setSelection(objects.map(o => o.id), 257);
    expect(f.state.selectedId).toBe(128); expect(f.state.selectedIds.size).toBe(256); expect(f.state.selectedIds.has(257)).toBe(false);
    expect(f.state.transformTools.controls.dragging).toBe(true); expect(f.captures.has(1)).toBe(true);
    expect(f.state.transformTools.pivot.position.distanceTo(preview)).toBeLessThan(1e-8); expect(f.state.transformTools.pivot.quaternion.angleTo(frame)).toBeLessThan(1e-7);
    f.engine.setSelection([...f.state.selectedIds], null);
    expect(f.state.selectedId).toBeNull(); expect(f.state.transformTools.busy).toBe(false); expect(f.state.transformTools.controls.enabled).toBe(false);
    f.engine.setTransformSpace('world'); expect(f.state.transformTools.controls.enabled).toBe(true);
  });
  it('hands immutable local changes to canonical history and never overwrites partial acceptance on late failure', async () => {
    let finish!: (accepted: boolean) => void;
    const f = make(vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }))), { originals } = local(f);
    const point = startAxis(f, 'X'); event(f, 'pointermove', point.x + 45, point.y - 8); event(f, 'pointerup', point.x + 45, point.y - 8);
    const changes = f.onTransform.mock.calls[0][0]; expect(changes.map(change => change.before)).toEqual(originals);
    const canonical = { ...changes[0].after, x: Math.round(changes[0].after.x * 100) / 100, yaw: Math.round(changes[0].after.yaw * 1800 / Math.PI) * Math.PI / 1800, owner: 7 };
    f.engine.setObjects([canonical]); finish(false); await flush();
    expect(f.state.objects.get(1)!.object).toEqual(canonical); expect(f.state.objects.get(1)!.root.position.distanceTo(position(canonical))).toBeLessThan(1e-8);
    expect(f.state.objects.get(2)!.object).toEqual(originals[1]); expect(f.state.objects.get(2)!.root.position.distanceTo(position(originals[1]))).toBeLessThan(1e-8);
    expect(changes[0].before).toEqual(originals[0]); expect(changes[0].after.owner).toBe(2);
  });
});

describe('Real Three transform handles and engine lifecycle', () => {
  it('raycasts a real handle, previews without mutating properties, and commits exactly once on release', async () => {
    let finish!: (accepted: boolean) => void;
    const callback = vi.fn<(changes: TransformChange[]) => Promise<boolean>>(() => new Promise(resolve => { finish = resolve; }));
    const f = make(callback), originals = [...f.state.objects.values()].map(entry => entry.object);
    originals.forEach(Object.freeze);
    const point = drag(f);
    expect(callback).not.toHaveBeenCalled();
    expect(f.captures.has(1)).toBe(true);
    expect(f.state.objects.get(1)!.object).toBe(originals[0]);
    expect(f.state.objects.get(1)!.root.userData.worldObject).toBe(originals[0]);
    const delta = f.state.objects.get(1)!.root.position.x + 1;
    expect(f.state.objects.get(2)!.root.position.x).toBeCloseTo(1 + delta);
    event(f, 'pointerup', point.x, point.y);
    expect(callback).toHaveBeenCalledTimes(1); expect(f.onSelect).not.toHaveBeenCalled();
    expect(callback.mock.calls[0][0].map(change => change.before)).toEqual(originals);
    expect(callback.mock.calls[0][0][0].after.x).toBeCloseTo(-1 + delta);
    expect(f.captures.size).toBe(0); expect(f.state.transformTools.busy).toBe(true);
    finish(false); await flush();
    expect(f.state.objects.get(1)!.root.position.x).toBe(-1); expect(f.state.objects.get(2)!.root.position.x).toBe(1);
    expect(f.state.transformTools.busy).toBe(false);
  });
  it('uses real Three translation snapping and leaves action scale intact', async () => {
    const f = make();
    f.engine.setObjects([{ ...object(1, -1), action: 'create scale 2 3 4' }]);
    f.engine.setTransformSnap({ translation: 0.5, rotation: Math.PI / 12 });
    const point = drag(f, 38), delta = f.state.objects.get(1)!.root.position.x + 1;
    expect(delta / 0.5).toBeCloseTo(Math.round(delta / 0.5));
    expect(f.state.objects.get(1)!.root.scale.toArray()).toEqual([2, 3, 4]);
    event(f, 'pointerup', point.x, point.y); await flush();
    expect(f.state.objects.get(1)!.root.scale.toArray()).toEqual([2, 3, 4]);
  });
  it('raycasts a rotation ring, snaps world-axis rotation, and commits compound object orientations', async () => {
    let finish!: (accepted: boolean) => void;
    const f = make(vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })));
    const originals = [{ ...object(1, -1), pitch: 0.4, yaw: 0.7, roll: -0.2 }, { ...object(2, 1), pitch: -0.3, roll: 0.6 }];
    f.engine.setObjects(originals); f.engine.setTransformMode('rotate');
    f.engine.setTransformSnap({ translation: 0, rotation: Math.PI / 12 });
    const point = handlePoint(f, 'Y');
    event(f, 'pointerdown', point.x, point.y);
    expect(f.state.transformTools.controls.axis).toBe('Y');
    expect(f.state.transformTools.controls.dragging).toBe(true);
    event(f, 'pointermove', point.x + 65, point.y + 20);
    const delta = f.state.transformTools.pivot.quaternion.clone(), angle = delta.angleTo(new THREE.Quaternion());
    expect(angle).toBeGreaterThan(0.01);
    expect(angle / (Math.PI / 12)).toBeCloseTo(Math.round(angle / (Math.PI / 12)));
    for (const original of originals) {
      const entry = f.state.objects.get(original.id)!;
      expect(entry.root.quaternion.angleTo(quaternion(original).premultiply(delta))).toBeLessThan(1e-7);
      expect(entry.object).toEqual(original);
    }
    event(f, 'pointerup', point.x + 65, point.y + 20);
    const changes = f.onTransform.mock.calls[0][0];
    for (let i = 0; i < changes.length; i++) expect(quaternion(changes[i].after).angleTo(quaternion(originals[i]).premultiply(delta))).toBeLessThan(1e-7);
    finish(false); await flush();
    for (const original of originals) expect(f.state.objects.get(original.id)!.root.quaternion.angleTo(quaternion(original))).toBeLessThan(1e-7);
  });
  it('does not select underlying objects or submit a no-op when a handle is clicked', () => {
    const f = make(), point = start(f);
    event(f, 'pointerup', point.x, point.y);
    expect(f.onTransform).not.toHaveBeenCalled(); expect(f.onSelect).not.toHaveBeenCalled();
    expect(f.state.transformTools.busy).toBe(false);
  });
  it('consumes the original pointer-up after Escape even if the canceled handle did not move', () => {
    const f = make(), point = start(f);
    window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'Escape' }));
    event(f, 'pointerup', point.x, point.y);
    expect(f.onTransform).not.toHaveBeenCalled(); expect(f.onSelect).not.toHaveBeenCalled();
    event(f, 'pointerdown', 5, 5); event(f, 'pointerup', 5, 5);
    expect(f.onSelect).toHaveBeenCalledTimes(1);
  });
  it('keeps a drag alive across unrelated updates and identical metadata-only refreshes', () => {
    const f = make(), point = drag(f), preview = f.state.objects.get(1)!.root.position.clone();
    f.engine.setObjects([object(3, 20)]);
    f.engine.setObjects([{ ...object(1, -1), cellX: -1, cellZ: 0 }]);
    expect(f.state.transformTools.controls.dragging).toBe(true);
    expect(f.state.objects.get(1)!.root.position.distanceTo(preview)).toBeLessThan(1e-8);
    event(f, 'pointercancel', point.x, point.y);
    expect(f.state.objects.get(1)!.root.position.x).toBe(-1);
    expect(f.state.objects.get(1)!.object.cellX).toBe(-1);
  });
  it('tolerates the parent disabling tools for a pending commit without losing its canonical result', async () => {
    let finish!: (accepted: boolean) => void;
    const f = make(vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }))), point = drag(f);
    event(f, 'pointerup', point.x, point.y);
    f.engine.setTransformEnabled(false);
    expect(f.state.transformTools.busy).toBe(true);
    const canonical = f.onTransform.mock.calls[0][0].map(change => ({ ...change.after, x: Math.round(change.after.x * 100) / 100 }));
    f.engine.setObjects(canonical);
    finish(true); await flush();
    expect([...f.state.objects.values()].map(entry => entry.object)).toEqual(canonical);
    expect([...f.state.objects.values()].map(entry => entry.root.position.x)).toEqual(canonical.map(object => object.x));
    expect(f.state.transformTools.controls.getHelper().visible).toBe(false);
    f.engine.setTransformEnabled(true); expect(f.state.transformTools.controls.getHelper().visible).toBe(true);
  });
  it('leaves right-drag camera input available and does not capture right clicks with the gizmo', () => {
    const f = make(), point = handlePoint(f), before = f.engine.getPosition();
    event(f, 'pointerdown', point.x, point.y, { button: 2 });
    expect(f.state.transformTools.controls.dragging).toBe(false);
    event(f, 'pointermove', point.x + 20, point.y, { button: -1, buttons: 2, movementX: 20 });
    expect(f.engine.getPosition().yaw).not.toBe(before.yaw);
    event(f, 'pointerup', point.x + 20, point.y, { button: 2 });
    expect(f.onTransform).not.toHaveBeenCalled();
  });
  it.each(['pointercancel', 'lostpointercapture'])('stops camera rotation and releases right capture on %s', cancellation => {
    const f = make(), before = f.engine.getPosition();
    event(f, 'pointerdown', 400, 300, { button: 2 });
    event(f, 'pointermove', 420, 300, { buttons: 2, movementX: 20 });
    expect(f.engine.getPosition().yaw).not.toBe(before.yaw);
    event(f, cancellation, 420, 300);
    const stopped = f.engine.getPosition();
    expect(f.captures.size).toBe(0);
    event(f, 'pointermove', 440, 310, { buttons: 0, movementX: 20, movementY: 10 });
    expect(f.engine.getPosition()).toEqual(stopped);
  });
  it('ignores movement and cancellation belonging to a different captured pointer', () => {
    const f = make(), before = f.engine.getPosition();
    event(f, 'pointerdown', 400, 300, { button: 2 });
    event(f, 'pointermove', 430, 310, { pointerId: 2, buttons: 2, movementX: 30, movementY: 10 });
    expect(f.engine.getPosition()).toEqual(before);
    event(f, 'lostpointercapture', 430, 310, { pointerId: 2 });
    event(f, 'pointerup', 430, 310, { pointerId: 2, button: 2 });
    expect(f.captures.has(1)).toBe(true);
    event(f, 'pointermove', 420, 300, { buttons: 2, movementX: 20 });
    expect(f.engine.getPosition().yaw).not.toBe(before.yaw);
    event(f, 'pointerup', 420, 300, { button: 2 });
    expect(f.captures.size).toBe(0);
  });
  it.each(['blur', 'teleport', 'world-reset', 'dispose'])('releases right-camera capture on %s', reason => {
    const f = make(); event(f, 'pointerdown', 400, 300, { button: 2 });
    if (reason === 'blur') f.canvas.dispatchEvent(new Event('blur'));
    if (reason === 'teleport') f.engine.teleport({ x: 0, y: 0, z: -10, yaw: 0 });
    if (reason === 'world-reset') f.engine.setWorld(createDemoWorld().settings);
    if (reason === 'dispose') f.engine.dispose();
    const stopped = f.engine.getPosition();
    expect(f.captures.size).toBe(0);
    event(f, 'pointermove', 430, 310, { buttons: 0, movementX: 30, movementY: 10 });
    expect(f.engine.getPosition()).toEqual(stopped);
  });
  it('blocks keyboard movement and camera rotation throughout a drag', () => {
    const f = make(), point = start(f), before = f.engine.getPosition();
    window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyW' }));
    event(f, 'pointerdown', point.x, point.y, { button: 2, pointerId: 2 });
    event(f, 'pointermove', point.x + 30, point.y, { movementX: 40, movementY: 20 });
    f.state.move(0.05);
    expect(f.engine.getPosition()).toEqual(before); expect(f.state.keys.size).toBe(0);
  });
  it.each(['escape', 'pointercancel', 'lostcapture', 'blur', 'disabled', 'select-mode', 'build-off', 'teleport', 'delete', 'remote-change', 'reload', 'world-reset', 'dispose'])('cancels without a commit on %s', reason => {
    const f = make(), point = drag(f);
    if (reason === 'escape') window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'Escape' }));
    if (reason === 'pointercancel') event(f, 'pointercancel', point.x, point.y);
    if (reason === 'lostcapture') event(f, 'lostpointercapture', point.x, point.y);
    if (reason === 'blur') window.dispatchEvent(new Event('blur'));
    if (reason === 'disabled') f.engine.setTransformEnabled(false);
    if (reason === 'select-mode') f.engine.setTransformMode('select');
    if (reason === 'build-off') f.engine.setBuildMode(false);
    if (reason === 'teleport') f.engine.teleport({ x: 5, y: 0, z: -10, yaw: 0 });
    if (reason === 'delete') f.engine.deleteObject(1);
    if (reason === 'remote-change') f.engine.setObjects([{ ...object(1, 20), description: 'Remote' }]);
    if (reason === 'reload') f.engine.setObjects([object(1, -1), object(2, 1)], true);
    if (reason === 'world-reset') f.engine.setWorld(createDemoWorld().settings);
    if (reason === 'dispose') f.engine.dispose();
    expect(f.state.transformTools.busy).toBe(false); expect(f.captures.size).toBe(0);
    if (f.state.objects.has(2)) expect(f.state.objects.get(2)!.root.position.x).toBe(1);
    if (reason === 'remote-change') expect(f.state.objects.get(1)!.root.position.x).toBe(20);
    event(f, 'pointerup', point.x, point.y);
    expect(f.onTransform).not.toHaveBeenCalled(); expect(f.onSelect).not.toHaveBeenCalled();
  });
  it('keeps accepted canonical broadcasts and restores only unaccepted previews after a partial rejection', async () => {
    let finish!: (accepted: boolean) => void;
    const f = make(vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }))), point = drag(f);
    event(f, 'pointerup', point.x, point.y);
    const accepted = { ...f.onTransform.mock.calls[0][0][0].after, x: 3.14, owner: 7 };
    f.engine.setObjects([accepted]);
    expect(f.state.objects.get(1)!.root.position.x).toBe(3.14);
    expect(f.state.objects.get(2)!.root.position.x).toBe(1);
    finish(false); await flush();
    expect(f.state.objects.get(1)!.object).toEqual(accepted);
    expect(f.state.objects.get(1)!.root.position.x).toBe(3.14);
    expect(f.state.objects.get(2)!.root.position.x).toBe(1);
  });
  it('treats success without canonical properties as unconfirmed, never writes optimistic objects', async () => {
    const f = make(vi.fn(async () => true)), point = drag(f);
    event(f, 'pointerup', point.x, point.y); await flush();
    expect(f.state.objects.get(1)!.object.x).toBe(-1); expect(f.state.objects.get(1)!.root.position.x).toBe(-1);
  });
  it('restores a failed callback and contains errors without retrying', async () => {
    const f = make(vi.fn(async () => { throw new Error('Permission denied'); })), point = drag(f);
    event(f, 'pointerup', point.x, point.y); await flush();
    expect(f.state.objects.get(1)!.root.position.x).toBe(-1);
    expect(f.onAction).toHaveBeenCalledWith({ type: 'transform-error', value: 'Permission denied' });
    expect(f.onTransform).toHaveBeenCalledTimes(1);
  });
  it('does not overwrite a new world when an old commit resolves late', async () => {
    let finish!: (accepted: boolean) => void;
    const f = make(vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }))), point = drag(f);
    event(f, 'pointerup', point.x, point.y);
    f.engine.setWorld(createDemoWorld().settings); f.engine.setObjects([object(1, 80)]);
    finish(true); await flush();
    expect(f.state.objects.get(1)!.root.position.x).toBe(80);
    expect(f.state.objects.get(1)!.object.x).toBe(80);
  });
  it('hides unavailable tools, rejects invalid snapping, and disposes helper resources/listeners', () => {
    const f = make(), tools = f.state.transformTools, helper = tools.controls.getHelper();
    f.engine.setTransformEnabled(false); expect(helper.visible).toBe(false);
    expect(() => f.engine.setTransformSnap({ translation: NaN, rotation: 0 })).toThrow();
    expect(() => f.engine.setTransformSnap({ translation: 1, rotation: -1 })).toThrow();
    f.engine.setTransformSnap({ translation: 0, rotation: 0 });
    expect(tools.controls.translationSnap).toBeNull(); expect(tools.controls.rotationSnap).toBeNull();
    f.engine.setTransformEnabled(true); expect(helper.visible).toBe(true);
    const dispose = vi.spyOn(tools.controls, 'dispose');
    f.engine.dispose(); f.engine.dispose(); expect(dispose).toHaveBeenCalledTimes(1);
    expect(helper.parent).toBeNull(); expect(tools.pivot.parent).toBeNull();
    const down = vi.spyOn(tools, 'pointerDown'); event(f, 'pointerdown', 400, 300); expect(down).not.toHaveBeenCalled();
  });
});
