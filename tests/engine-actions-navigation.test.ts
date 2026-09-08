import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WorldEngine } from '../src/renderer/engine';
import { ACTION_LIMITS, BumpContacts, parseActions, parseTeleport } from '../src/renderer/engine/actions';
import { createDemoWorld } from '../src/renderer/engine/demo';
import type { WorldObject } from '../src/shared/types';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    shadowMap = {}; capabilities = { getMaxAnisotropy: () => 1 }; info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  } };
});

const position = { x: 17, y: 8, z: -35, yaw: Math.PI / 2, pitch: .2 };
describe('documented relative teleport grammar', () => {
  it('resolves signed pairs in world north/west axes, not avatar orientation', () => {
    expect(parseTeleport('+2 -3', position)).toEqual({ world: undefined, position: { ...position, z: -15, x: -13 } });
    expect(parseTeleport('+.25 +.5', { ...position, yaw: -3 })).toEqual({ world: undefined, position: { ...position, yaw: -3, z: -32.5, x: 22 } });
  });
  it('implements the official +0 +0 +10a example and relative heading', () => {
    expect(parseTeleport('+0 +0 +10a -90', position)).toEqual({ world: undefined, position: { ...position, y: 108, yaw: 0 } });
    expect(parseTeleport('+0 +0 10a 180', position)).toEqual({ world: undefined, position: { ...position, y: 100, yaw: Math.PI } });
  });
  it('allows independent signed altitude/heading and case-insensitive absolute cardinal order', () => {
    expect(parseTeleport('3e 4s -.5A +45', position)).toEqual({ world: undefined, position: { ...position, x: -30, z: -40, y: 3, yaw: Math.PI * .75 } });
  });
  it('supports named world relative destinations and world-only ground zero without changing heading', () => {
    expect(parseTeleport('Haven +1 +2', position)).toEqual({ world: 'Haven', position: { ...position, z: -25, x: 37 } });
    expect(parseTeleport('Haven', position)).toEqual({ world: 'Haven', position: { x: 0, y: 0, z: 0, yaw: position.yaw, pitch: .2 } });
  });
  it.each(['+1 2W', '1N +2', '+1 2', '1 +2', '+1', '1N', '1N 2S', '1W 2E', '+1 +2 3N', '+1 +2 +3a +4a', '+1 +2 90 1a', '+1 +2 ""', '+1 +2 NaN', '+1 +2 Infinity', '+1 +2 0x10', '+1 +2 1e9', '+1 +2 1 2', 'Haven 10A', 'Haven +1', '+1 +2 +999999999999A', '+99999999999 +0', 'NaN'])('rejects invalid/mixed/unbounded destination %j', value => {
    expect(parseTeleport(value, position)).toBeNull();
  });
  it('rejects overflow in the resolved destination, not just the individual offset', () => {
    expect(parseTeleport('+0 +.1', { ...position, x: 21474836 })).toBeNull();
    expect(parseTeleport('+0 +0', { ...position, y: NaN })).toBeNull();
    expect(parseTeleport('x'.repeat(1025), position)).toBeNull();
  });
  it('rejects oversized scripts as a whole instead of executing a truncated command chain', () => {
    expect(parseActions('activate teleport 1N 2W' + ' '.repeat(ACTION_LIMITS.sourceCharacters))).toEqual([]);
    expect(parseActions('activate ' + new Array(ACTION_LIMITS.commands + 1).fill('teleport 1N 2W').join(','))).toEqual([]);
    expect(parseActions('activate ' + new Array(ACTION_LIMITS.commands).fill('teleport 1N 2W').join(','))).toHaveLength(ACTION_LIMITS.commands);
  });
});

describe('bounded bump contact lifecycle', () => {
  it('fires one contact edge, never repeats held contact, and rearms after leaving', () => {
    const contacts = new BumpContacts();
    expect(contacts.update([3, 3, 4], 0)).toBe(3);
    expect(contacts.update([3, 4], 2000)).toBeUndefined();
    contacts.update([], 2001); expect(contacts.update([4], 2002)).toBe(4);
  });
  it('consumes edges during cooldown or suspension instead of replaying later', () => {
    const contacts = new BumpContacts(); contacts.update([1], 0);
    expect(contacts.update([2], 500)).toBeUndefined(); expect(contacts.update([2], 1500)).toBeUndefined();
    expect(contacts.update([3], 2000, false)).toBeUndefined(); expect(contacts.update([3], 3000)).toBeUndefined();
  });
  it('suppresses newly loaded/replaced geometry until exit and resets quietly on navigation', () => {
    const contacts = new BumpContacts(); contacts.suppress(8);
    expect(contacts.update([8], 2000)).toBeUndefined(); contacts.update([], 2001); expect(contacts.update([8], 2002)).toBe(8);
    contacts.reset(3000); expect(contacts.update([9], 3500)).toBeUndefined(); expect(contacts.update([9], 5000)).toBeUndefined();
  });
  it('bounds retained contacts and rejects invalid clocks/IDs', () => {
    const contacts = new BumpContacts();
    expect(contacts.update([NaN, Infinity], 0)).toBeUndefined(); expect(contacts.update([1], NaN)).toBeUndefined();
    contacts.update(Array.from({ length: 10000 }, (_, i) => i), 2000, false);
    expect(Reflect.get(contacts, 'previous').size).toBe(ACTION_LIMITS.contacts);
  });
});

function fakeCanvas() {
  return Object.assign(new EventTarget(), {
    style: {}, clientWidth: 800, clientHeight: 600, width: 800, height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getContext: () => ({ measureText: () => ({ width: 80 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} }),
  }) as unknown as HTMLCanvasElement;
}
const engines: WorldEngine[] = [];
let now = 0;
const portal = (action = 'bump teleport +0 +2', id = 1): WorldObject => ({ id, owner: 1, model: 'wayfarer:cube', action: 'create scale 1 2 1; ' + action, description: '', x: 0, y: 0, z: 1, yaw: 0, pitch: 0, roll: 0 });
function setup(objects = [portal()]) {
  const onAction = vi.fn(), onPosition = vi.fn(), canvas = fakeCanvas();
  const engine = new WorldEngine(canvas, { onAction, onPosition, onStats: vi.fn(), onSelect: vi.fn(), asset: vi.fn().mockRejectedValue(new Error('No network')) });
  engines.push(engine);
  engine.setWorld({ ...createDemoWorld().settings, name: 'Haven', entry: { x: 0, y: 0, z: 0, yaw: 0 }, terrainEnabled: false, canTeleport: false, allowTeleport: false, demo: false });
  engine.setObjects(objects); now = 1500;
  const move = (dt = .05) => Reflect.get(engine, 'move').call(engine, dt);
  move(0); onAction.mockClear(); onPosition.mockClear();
  return { engine, onAction, onPosition, canvas, move, keys: Reflect.get(engine, 'keys') as Set<string> };
}
function activate(engine: WorldEngine, id = 1) {
  const root = Reflect.get(engine, 'objects').get(id).root;
  vi.spyOn(Reflect.get(engine, 'ray'), 'intersectObjects').mockReturnValue([{ object: root }]);
  Reflect.get(engine, 'selectAt').call(engine, 400, 300);
}
beforeEach(() => {
  now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null, createElement: fakeCanvas }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('real geometry authored navigation', () => {
  it('bumps a solid portal and performs its relative teleport despite menu teleport restrictions', () => {
    const { engine, keys, move, onPosition, onAction } = setup(); keys.add('KeyW'); move();
    expect(engine.getPosition()).toMatchObject({ x: 20, y: 0, z: 0 }); expect(onPosition).toHaveBeenCalledOnce(); expect(keys.size).toBe(0);
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }));
    now = 1600; move(); expect(onPosition).toHaveBeenCalledOnce();
  });
  it('finds non-solid and invisible portal geometry independently of blocking collisions', () => {
    const { engine, keys, move } = setup([portal('create solid off, visible off; bump teleport +0 +2')]); keys.add('KeyW'); move();
    expect(engine.getPosition().x).toBe(20); expect(engine.getPosition().z).toBeCloseTo(.21);
  });
  it('still detects bump when flying through a non-solid portal', () => {
    const { engine, keys, move } = setup([portal('create solid off; bump teleport +0 +2')]); engine.setFlying(true); keys.add('KeyW'); move();
    expect(engine.getPosition().x).toBe(20);
  });
  it('keeps model-level non-solid parts eligible for bump without making them block movement', () => {
    const { engine, keys, move } = setup();
    const root = Reflect.get(engine, 'objects').get(1).root as THREE.Group;
    root.traverse(node => { if (node instanceof THREE.Mesh) node.userData.solid = false; }); Reflect.set(engine, 'collisionDirty', true);
    keys.add('KeyW'); move(); expect(engine.getPosition().x).toBe(20); expect(engine.getPosition().z).toBeCloseTo(.21);
  });
  it('does not reach a portal behind a nearer solid wall', () => {
    const wall = { ...portal('', 2), z: .8 };
    const { engine, keys, move, onPosition } = setup([wall, { ...portal(), z: 1.2 }]); keys.add('KeyW'); move();
    expect(engine.getPosition().x).toBe(0); expect(onPosition).not.toHaveBeenCalled();
  });
  it('does not manufacture activation clicks, URL requests or unsupported media from bump', () => {
    const { keys, move, onAction } = setup([portal('bump url https://example.test, media unwanted.mp4')]); keys.add('KeyW'); move(); expect(onAction).not.toHaveBeenCalled();
  });
  it('forwards one scoped cross-world teleport, suppressing repeated contact and later commands', () => {
    const { engine, keys, move, onAction } = setup([portal('bump teleport Elsewhere +0 +2, teleport Another 0N 0W')]); keys.add('KeyW'); move();
    expect(onAction).toHaveBeenCalledOnce(); expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'teleport', value: 'Elsewhere +0 +2' }));
    now += 500; move(0); now += 1000; keys.add('KeyW'); move(); expect(onAction).toHaveBeenCalledOnce(); expect(engine.getPosition().x).toBe(0);
  });
  it('gates navigation during UI suspension/building and clears held keys without replay', () => {
    const { engine, keys, move, onPosition } = setup(); keys.add('KeyW'); engine.setNavigationActionsEnabled(false); expect(keys.size).toBe(0);
    keys.add('KeyW'); move(); expect(onPosition).not.toHaveBeenCalled(); engine.setNavigationActionsEnabled(true); now += 2000; move(); expect(onPosition).not.toHaveBeenCalled();
    engine.setBuildMode(true); keys.add('KeyW'); move(); expect(onPosition).not.toHaveBeenCalled();
  });
  it('suppresses portals replaced underneath a touching avatar and removes deleted triggers', () => {
    const { engine, keys, move, onAction } = setup([portal('bump teleport Elsewhere +0 +2')]); keys.add('KeyW'); move();
    engine.setObjects([portal('bump teleport Other +0 +2')]); now += 2000; keys.add('KeyW'); move(); expect(onAction).toHaveBeenCalledOnce();
    engine.deleteObject(1); now += 2000; keys.add('KeyW'); move(); expect(onAction).toHaveBeenCalledOnce();
  });
  it('activates relative teleport once and stops after unsupported lock conditions', () => {
    const first = setup([portal('activate teleport +1 -2 +.5a +90, teleport +99 +99')]); activate(first.engine);
    expect(first.engine.getPosition()).toMatchObject({ x: -20, z: 10, y: 5, yaw: Math.PI / 2 });
    vi.restoreAllMocks();
    const second = setup([portal('activate lock owners=9, teleport +1 +2')]); activate(second.engine); expect(second.engine.getPosition().x).toBe(0);
  });
  it('invalidates activation if its click callback replaces the world', () => {
    const { engine, onAction, onPosition } = setup([portal('activate teleport +99 +99')]);
    onAction.mockImplementation(action => { if (action.type === 'click') engine.setWorld({ ...createDemoWorld().settings, entry: { x: 7, y: 0, z: 9, yaw: 0 } }); });
    activate(engine); expect(engine.getPosition()).toMatchObject({ x: 7, z: 9 }); expect(onPosition).toHaveBeenCalledOnce();
  });
  it('blocks activation while suspended and makes no callbacks after disposal', () => {
    const { engine, onAction, onPosition } = setup([portal('activate teleport +1 +2')]);
    engine.setNavigationActionsEnabled(false); activate(engine); expect(onAction).not.toHaveBeenCalled(); expect(onPosition).not.toHaveBeenCalled();
    engine.dispose(); Reflect.get(engine, 'selectAt').call(engine, 400, 300); expect(onAction).not.toHaveBeenCalled();
  });
  it('detects a non-solid overhead portal along upward flight, not just horizontal walking', () => {
    const overhead = { ...portal('bump teleport +0 +2'), z: 0, y: 1.8, action: 'create scale 2 .1 2, solid off; bump teleport +0 +2' };
    const { engine, keys, move } = setup([overhead]); keys.add('PageUp'); move();
    expect(engine.getPosition().x).toBe(20); expect(engine.getPosition().y).toBeCloseTo(.21);
  });
  it('excludes distant trigger meshes from raycasts and bounds a densely overlapping portal set', () => {
    const distant = Array.from({ length: 300 }, (_, i) => ({ ...portal('bump teleport +0 +2', i + 2), x: 100 + i }));
    const { engine, keys, move } = setup([portal(), ...distant]);
    expect(Reflect.get(engine, 'bumpMeshes').length).toBe(1); keys.add('KeyW'); move(); expect(engine.getPosition().x).toBe(20);
    engine.setObjects(distant.map(item => ({ ...item, x: 20, z: 0 }))); move(0);
    expect(Reflect.get(engine, 'bumpMeshes').length).toBe(ACTION_LIMITS.bumpMeshes);
  });
});
