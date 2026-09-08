import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WorldEngine } from '../src/renderer/engine';
import { createDemoWorld } from '../src/renderer/engine/demo';
import { parseRwx, type RwxModel } from '../src/renderer/engine/rwx';
import type { WorldObject } from '../src/shared/types';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    shadowMap = {}; capabilities = { getMaxAnisotropy: () => 1 }; info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  } };
});

interface InspectEngine {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera;
  objects: Map<number, { root: THREE.Group; ready: boolean }>;
  selectedIds: Set<number>; selectedId: number | null;
  selectionHelpers: Map<number, THREE.BoxHelper>;
  loadRwx(name: string): Promise<RwxModel>;
}
const inspect = (engine: WorldEngine) => engine as unknown as InspectEngine;
const instances: WorldEngine[] = [];
function make() {
  const canvas = Object.assign(new EventTarget(), {
    style: {}, clientWidth: 800, clientHeight: 600, focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  }) as unknown as HTMLCanvasElement;
  const onSelect = vi.fn();
  const engine = new WorldEngine(canvas, { asset: vi.fn(), onSelect, onPosition: vi.fn(), onStats: vi.fn() });
  engine.setWorld(createDemoWorld().settings); instances.push(engine);
  return { engine, canvas, onSelect };
}
function cube(id: number, x = id * 2): WorldObject {
  return { id, owner: 1, model: 'wayfarer:cube', description: '', action: '', x, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
}
function click(canvas: HTMLCanvasElement, x: number, y: number, additive = false) {
  canvas.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0, clientX: x, clientY: y, shiftKey: additive }));
  canvas.dispatchEvent(Object.assign(new Event('pointerup'), { button: 0, clientX: x, clientY: y, shiftKey: additive }));
}

beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { instances.splice(0).forEach(engine => engine.dispose()); vi.unstubAllGlobals(); });

describe('Multi-object build selection', () => {
  it('highlights every unique existing object and retains the single-selection API', () => {
    const { engine } = make(), state = inspect(engine);
    engine.setObjects([cube(1), cube(2), cube(3)]);
    engine.setSelection([1, 2, 2, 999, NaN], 2);
    expect([...state.selectedIds]).toEqual([1, 2]); expect(state.selectedId).toBe(2);
    expect([...state.selectionHelpers.keys()]).toEqual([1, 2]);
    expect((state.selectionHelpers.get(1)!.material as THREE.LineBasicMaterial).color.getHexString()).toBe('74c5bd');
    expect((state.selectionHelpers.get(2)!.material as THREE.LineBasicMaterial).color.getHexString()).toBe('dfaf58');
    engine.setSelection([1, 2, 3]); expect(state.selectedId).toBe(2);
    engine.setSelected(3); expect([...state.selectedIds]).toEqual([3]);
    engine.setSelected(null); expect(state.selectionHelpers.size).toBe(0); expect(state.selectedId).toBeNull();
  });

  it('caps selections at 256 objects even with oversized duplicate input', () => {
    const { engine } = make(), state = inspect(engine);
    const objects = Array.from({ length: 270 }, (_, i) => cube(i)); engine.setObjects(objects);
    engine.setSelection([0, 0, ...objects.map(object => object.id)], 269);
    expect(state.selectedIds.size).toBe(256); expect(state.selectionHelpers.size).toBe(256);
    expect(state.selectedIds.has(269)).toBe(false); expect(state.selectedId).toBe(0);
  });

  it('keeps all highlights and primary selection across property updates and replacement queries', () => {
    const { engine } = make(), state = inspect(engine);
    engine.setObjects([cube(1), cube(2), cube(3)]); engine.setSelection([1, 2], 2);
    const first = state.selectionHelpers.get(1), second = state.selectionHelpers.get(2);
    engine.setObjects([{ ...cube(1), x: 20 }, { ...cube(2), y: 3 }]);
    expect(state.selectionHelpers.get(1)).toBe(first); expect(state.selectionHelpers.get(2)).toBe(second);
    expect([...state.selectedIds]).toEqual([1, 2]); expect(state.selectedId).toBe(2);
    expect(new THREE.Box3().setFromObject(first!).min.x).toBeCloseTo(19.5);
    engine.setObjects([{ ...cube(1), x: 30 }, cube(2)], true);
    expect(state.selectionHelpers.get(1)).toBe(first); expect(state.selectionHelpers.get(2)).toBe(second);
    expect(new THREE.Box3().setFromObject(first!).min.x).toBeCloseTo(29.5);
    engine.setObjects([cube(2)], true);
    expect([...state.selectedIds]).toEqual([2]); expect(state.selectionHelpers.get(2)).toBe(second);
  });

  it('retargets async model highlights without discarding the rest of the selection', async () => {
    const { engine } = make(), state = inspect(engine);
    let finish!: (value: RwxModel) => void;
    vi.spyOn(state, 'loadRwx').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    engine.setObjects([cube(1), { ...cube(2), model: 'original.rwx' }]); engine.setSelection([1, 2], 2);
    const first = state.selectionHelpers.get(1), second = state.selectionHelpers.get(2);
    finish(parseRwx('Vertex 0 0 0\nVertex 3 0 0\nVertex 0 2 0\nTriangle 1 2 3'));
    await vi.waitFor(() => expect(state.objects.get(2)!.ready).toBe(true));
    expect(state.selectionHelpers.get(1)).toBe(first); expect(state.selectionHelpers.get(2)).toBe(second);
    expect([...state.selectedIds]).toEqual([1, 2]); expect(state.selectedId).toBe(2);
    expect(new THREE.Box3().setFromObject(second!).max.x).toBeCloseTo(34);
  });

  it('toggles membership with Shift-click and keeps additive empty clicks non-destructive', () => {
    const { engine, canvas, onSelect } = make(), state = inspect(engine);
    const left = cube(1, -1.5), right = cube(2, 1.5);
    engine.setObjects([left, right]); engine.setBuildMode(true);
    engine.teleport({ x: 0, y: 0, z: -5, yaw: 0, pitch: -0.2 }); state.camera.updateMatrixWorld(true);
    const point = (object: WorldObject) => { const p = new THREE.Vector3(object.x, 0.5, object.z).project(state.camera); return [(p.x + 1) * 400, (1 - p.y) * 300] as const; };
    click(canvas, ...point(left)); expect([...state.selectedIds]).toEqual([1]);
    click(canvas, ...point(right), true); expect([...state.selectedIds]).toEqual([1, 2]); expect(state.selectedId).toBe(2);
    click(canvas, ...point(left), true); expect([...state.selectedIds]).toEqual([2]);
    expect(onSelect).toHaveBeenLastCalledWith(left, { additive: true });
    click(canvas, 5, 5, true); expect([...state.selectedIds]).toEqual([2]); expect(onSelect).toHaveBeenLastCalledWith(null, { additive: true });
    click(canvas, 5, 5); expect(state.selectedIds.size).toBe(0); expect(onSelect).toHaveBeenLastCalledWith(null, { additive: false });
  });

  it('deletes only the removed selection, and disposes all remaining highlights once on reset', () => {
    const { engine } = make(), state = inspect(engine);
    engine.setObjects([cube(1), cube(2)]); engine.setSelection([1, 2], 1);
    const removed = state.selectionHelpers.get(1)!, remaining = state.selectionHelpers.get(2)!;
    const removedDispose = vi.spyOn(removed.geometry, 'dispose'), remainingDispose = vi.spyOn(remaining.geometry, 'dispose');
    engine.deleteObject(1);
    expect([...state.selectedIds]).toEqual([2]); expect(state.selectedId).toBe(2);
    expect(removedDispose).toHaveBeenCalledTimes(1); expect(remainingDispose).not.toHaveBeenCalled();
    engine.setWorld(createDemoWorld().settings);
    expect(state.selectionHelpers.size).toBe(0); expect(state.selectedIds.size).toBe(0);
    expect(remainingDispose).toHaveBeenCalledTimes(1);
    engine.dispose(); expect(removedDispose).toHaveBeenCalledTimes(1); expect(remainingDispose).toHaveBeenCalledTimes(1);
    engine.setSelection([2]); expect(state.selectionHelpers.size).toBe(0);
  });
});
