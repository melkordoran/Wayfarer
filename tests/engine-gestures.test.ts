import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AVATAR_GESTURE_LIMITS, WorldEngine, type GesturePlaybackState } from '../src/renderer/engine';
import { createDemoWorld } from '../src/renderer/engine/demo';
import * as avatarAssets from '../src/renderer/engine/avatar-assets';
import { fetchStudioAvatarAsset, STUDIO_AVATAR_PATH } from '../src/renderer/engine/studio-avatar-assets';
import type { Avatar } from '../src/shared/types';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    shadowMap = {}; capabilities = { getMaxAnisotropy: () => 1 }; info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  } };
});

function fakeCanvas() {
  return Object.assign(new EventTarget(), {
    style: {}, clientWidth: 800, clientHeight: 600, width: 800, height: 600,
    getContext: () => ({ measureText: () => ({ width: 80 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} }),
  }) as unknown as HTMLCanvasElement;
}
type Entry = {
  avatar: Avatar; root: THREE.Group; body: THREE.Group; rig?: avatarAssets.AvatarRig; definition?: avatarAssets.AvatarDefinition;
  sequence?: avatarAssets.AvatarSequence; sequenceName?: string; sequenceStarted: number;
  gesture?: { index: number; requestId: number; requestedAt: number; deadline: number; phase: 'loading' | 'playing' };
};
type Internals = { avatars: Map<number, Entry>; animateAvatar(entry: Entry, time: number, moving: boolean): void };
const localSession = -2147483647;
const engines: WorldEngine[] = [];
const inspect = (engine: WorldEngine) => engine as unknown as Internals;
let now = 1000;
const avatar: Avatar = { session: 12, citizen: 1, name: 'Explorer', type: 0, gesture: 0, state: 0, x: 0, y: 0, z: 0, yaw: 0 };
function makeEngine(options: Partial<ConstructorParameters<typeof WorldEngine>[1]> = {}) {
  const states: GesturePlaybackState[] = [], asset = vi.fn().mockRejectedValue(new Error('No network permitted'));
  const engine = new WorldEngine(fakeCanvas(), { asset, onPosition: vi.fn(), onSelect: vi.fn(), onStats: vi.fn(), onGestureState: value => states.push(value), ...options });
  engines.push(engine); engine.setWorld(createDemoWorld().settings);
  return { engine, states, asset };
}
async function ready(engine: WorldEngine, session = localSession) {
  if (session === localSession) engine.setCameraMode('third-person');
  const entry = inspect(engine).avatars.get(session)!;
  await vi.waitFor(() => expect(entry.rig?.joints.size).toBe(16));
  return entry;
}
function animate(engine: WorldEngine, entry: Entry, time = now, moving = false) {
  now = time; inspect(engine).animateAvatar(entry, time, moving);
}
async function playing(engine: WorldEngine, entry: Entry) {
  animate(engine, entry);
  await vi.waitFor(() => expect(entry.gesture?.phase).toBe('playing'));
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null, createElement: fakeCanvas }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('explicit avatar gesture lifecycle', () => {
  it('loads original studio rigs and gestures without the network adapter or a demo object path', async () => {
    const { engine, asset, states } = makeEngine(), entry = await ready(engine);
    const id = engine.setGesture(1);
    expect(states.at(-1)).toEqual({ gesture: 1, requestId: id, phase: 'loading' });
    await playing(engine, entry);
    expect(entry.sequenceName).toBe('wf-wave'); expect(states.at(-1)).toEqual({ gesture: 1, requestId: id, phase: 'playing' });
    expect(createDemoWorld().settings.objectPath).toBe(''); expect(asset).not.toHaveBeenCalled();
    animate(engine, entry, entry.sequenceStarted + 700);
    const shoulder = entry.rig!.joints.get('lfshoulder')!;
    expect(shoulder.group.quaternion.angleTo(shoulder.bindRotation)).toBeCloseTo(145 * Math.PI / 180);
  });

  it('keeps first-person playback hidden, preserves it through camera changes, then returns to locomotion', async () => {
    const { engine, states } = makeEngine();
    const id = engine.setGesture(2), entry = inspect(engine).avatars.get(localSession)!;
    expect(entry.root.visible).toBe(false);
    await vi.waitFor(() => expect(entry.rig?.joints.size).toBe(16));
    await playing(engine, entry);
    const started = entry.sequenceStarted;
    engine.setCameraMode('third-person'); expect(inspect(engine).avatars.get(localSession)).toBe(entry); expect(entry.root.visible).toBe(true);
    engine.setCameraMode('first-person'); expect(entry.root.visible).toBe(false); expect(entry.sequenceStarted).toBe(started);
    const duration = entry.sequence!.durationMs;
    animate(engine, entry, started + duration, true);
    expect(states.at(-1)).toEqual({ gesture: 2, requestId: id, phase: 'idle', reason: 'completed' });
    expect(entry.avatar.gesture).toBe(0); expect(entry.gesture).toBeUndefined(); expect(entry.sequenceName).toBe('wf-walk');
    await vi.waitFor(() => expect(entry.sequence?.format).toBe('binary'));
    animate(engine, entry, now + 100);
    expect(entry.sequenceName).toBe('wf-idle');
    expect(states.filter(state => state.reason === 'completed')).toHaveLength(1);
  });

  it('explicitly repeats the same local gesture from its beginning without disturbing another avatar', async () => {
    const { engine, states } = makeEngine(); engine.setAvatar(avatar);
    const local = await ready(engine), remote = await ready(engine, avatar.session);
    const first = engine.setGesture(1); await playing(engine, local);
    animate(engine, local, now + 700);
    const id = engine.setGesture(1); expect(id).toBeGreaterThan(first); expect(local.sequence).toBeUndefined();
    expect(local.rig!.joints.get('lfshoulder')!.group.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0);
    await playing(engine, local); expect(local.sequenceStarted).toBe(now);
    expect(remote.gesture).toBeUndefined(); expect(remote.rig!.joints.get('lfshoulder')!.group.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0);
    expect(states.filter(state => state.phase === 'playing').map(state => state.requestId)).toEqual([first, id]);
  });

  it('does not replay remote gestures on repeated movement packets, but recognizes a neutral-to-positive edge', async () => {
    const { engine, states } = makeEngine(); engine.setAvatar(avatar);
    const entry = await ready(engine, avatar.session);
    engine.setAvatar({ ...avatar, gesture: 1 }); await playing(engine, entry);
    const id = entry.gesture!.requestId, started = entry.sequenceStarted, duration = entry.sequence!.durationMs;
    engine.setAvatar({ ...avatar, gesture: 1, x: 1 });
    expect(entry.gesture!.requestId).toBe(id); expect(entry.sequenceStarted).toBe(started);
    animate(engine, entry, started + duration);
    engine.setAvatar({ ...avatar, gesture: 1, x: 2 }); animate(engine, entry);
    expect(entry.gesture).toBeUndefined(); expect(entry.sequenceName).toBe('wf-idle');
    engine.setAvatar({ ...avatar, gesture: 0 }); engine.setAvatar({ ...avatar, gesture: 1 }); await playing(engine, entry);
    expect(entry.gesture!.requestId).toBeGreaterThan(id); expect(states).toEqual([]);
  });

  it('clones incoming state so caller mutation cannot bypass the gesture edge detector', async () => {
    const { engine } = makeEngine(), incoming = { ...avatar };
    engine.setAvatar(incoming); const entry = await ready(engine, avatar.session);
    incoming.gesture = 1; engine.setAvatar(incoming); await playing(engine, entry);
    expect(entry.avatar).not.toBe(incoming); expect(entry.gesture!.index).toBe(1);
  });

  it('stops immediately, resets the pose, and invalidates delayed sequence loads', async () => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    const wave = await avatarAssets.loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-wave', fetchStudioAvatarAsset);
    const pending = deferred<avatarAssets.AvatarSequence>();
    vi.spyOn(avatarAssets, 'loadAvatarSequence').mockImplementation(() => pending.promise);
    const first = engine.setGesture(1); animate(engine, entry); await Promise.resolve();
    const stop = engine.stopGesture(); pending.resolve(wave); await Promise.resolve(); await Promise.resolve();
    expect(stop).toBeGreaterThan(first); expect(entry.sequence).toBeUndefined(); expect(entry.gesture).toBeUndefined();
    expect(states.at(-1)).toEqual({ gesture: 0, requestId: stop, phase: 'idle', reason: 'stopped' });
    expect(states.some(state => state.phase === 'playing')).toBe(false);
  });

  it('accepts only the latest same-name request when an earlier load resolves after repeat', async () => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    const wave = await avatarAssets.loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-wave', fetchStudioAvatarAsset), pending = deferred<avatarAssets.AvatarSequence>();
    const loader = vi.spyOn(avatarAssets, 'loadAvatarSequence').mockImplementation(() => pending.promise);
    const first = engine.setGesture(1); animate(engine, entry); await Promise.resolve();
    const latest = engine.setGesture(1); animate(engine, entry); pending.resolve(wave);
    await vi.waitFor(() => expect(entry.gesture?.phase).toBe('playing'));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(states.filter(state => state.phase === 'playing').map(state => state.requestId)).toEqual([latest]);
    expect(states.some(state => state.requestId === first && state.phase === 'idle')).toBe(false);
  });

  it('does not let a delayed gesture replace a newer different gesture', async () => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    const wave = await avatarAssets.loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-wave', fetchStudioAvatarAsset);
    const bow = await avatarAssets.loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-bow', fetchStudioAvatarAsset), pending = deferred<avatarAssets.AvatarSequence>();
    vi.spyOn(avatarAssets, 'loadAvatarSequence').mockImplementation((_path, name) => name === 'wf-wave' ? pending.promise : Promise.resolve(bow));
    const first = engine.setGesture(1); animate(engine, entry); await Promise.resolve();
    const latest = engine.setGesture(2); await playing(engine, entry);
    pending.resolve(wave); await Promise.resolve(); await Promise.resolve();
    expect(entry.sequenceName).toBe('wf-bow'); expect(entry.sequence).toBe(bow);
    expect(states.filter(state => state.phase === 'playing').map(state => state.requestId)).toEqual([latest]);
    expect(states.some(state => state.requestId === first && state.phase === 'error')).toBe(false);
  });

  it.each(['world', 'avatar', 'assets', 'dispose'] as const)('cancels delayed loads on %s changes without late playback callbacks', async operation => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    const wave = await avatarAssets.loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-wave', fetchStudioAvatarAsset), pending = deferred<avatarAssets.AvatarSequence>();
    vi.spyOn(avatarAssets, 'loadAvatarSequence').mockImplementation(() => pending.promise);
    const id = engine.setGesture(1); animate(engine, entry); await Promise.resolve();
    if (operation === 'world') engine.setWorld({ ...createDemoWorld().settings, name: 'Next' });
    if (operation === 'avatar') engine.setAvatarType(1);
    if (operation === 'assets') engine.updateWorld({ ...createDemoWorld().settings, objectPath: 'https://different.invalid/' });
    if (operation === 'dispose') engine.dispose();
    const terminal = states.at(-1)!;
    expect(terminal).toMatchObject({ requestId: id, phase: 'idle', reason: { world: 'world-changed', avatar: 'avatar-changed', assets: 'asset-changed', dispose: 'disposed' }[operation] });
    pending.resolve(wave); await Promise.resolve(); await Promise.resolve();
    expect(entry.sequence).toBeUndefined(); expect(entry.gesture).toBeUndefined(); expect(states.at(-1)).toBe(terminal);
  });

  it('has a finite timer even when the renderer is not receiving frames or an asset never settles', async () => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    vi.useFakeTimers(); vi.spyOn(avatarAssets, 'loadAvatarSequence').mockImplementation(() => new Promise(() => {}));
    const id = engine.setGesture(1); animate(engine, entry); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(AVATAR_GESTURE_LIMITS.loadMs);
    expect(states.at(-1)).toMatchObject({ requestId: id, phase: 'error', reason: 'timeout' });
    expect(entry.gesture).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    animate(engine, entry, now + 100000);
    expect(entry.body.children[5].rotation.z).toBe(0);
  });

  it('does not revive a timed-out request when its sequence eventually downloads', async () => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    const wave = await avatarAssets.loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-wave', fetchStudioAvatarAsset), pending = deferred<avatarAssets.AvatarSequence>();
    vi.spyOn(avatarAssets, 'loadAvatarSequence').mockImplementation(() => pending.promise);
    const id = engine.setGesture(1); animate(engine, entry); await Promise.resolve();
    animate(engine, entry, now + AVATAR_GESTURE_LIMITS.loadMs);
    pending.resolve(wave); await Promise.resolve(); await Promise.resolve();
    expect(entry.gesture).toBeUndefined(); expect(entry.sequenceName).toBe('wf-idle');
    expect(states.at(-1)).toMatchObject({ requestId: id, phase: 'error', reason: 'timeout' });
    expect(states.some(state => state.phase === 'playing')).toBe(false);
  });

  it('finishes playing on its timer without waiting for another render frame', async () => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    vi.useFakeTimers();
    const id = engine.setGesture(2); animate(engine, entry); await vi.advanceTimersByTimeAsync(0);
    expect(entry.gesture?.phase).toBe('playing');
    const duration = entry.sequence!.durationMs;
    await vi.advanceTimersByTimeAsync(duration);
    expect(states.at(-1)).toMatchObject({ requestId: id, phase: 'idle', reason: 'completed' });
    expect(entry.gesture).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an overlong sequence and preserves a neutral fallback instead of pretending to wave', async () => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    const wave = await avatarAssets.loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-wave', fetchStudioAvatarAsset);
    vi.spyOn(avatarAssets, 'loadAvatarSequence').mockResolvedValue({ ...wave, durationMs: AVATAR_GESTURE_LIMITS.playbackMs + 1 });
    const id = engine.setGesture(1); animate(engine, entry);
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ requestId: id, phase: 'error', reason: 'unavailable' }));
    expect(entry.gesture).toBeUndefined(); expect(entry.body.children[5].rotation.z).toBe(0);
  });

  it('removes rejected sequence promises so an explicit retry can recover', async () => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    const wave = await avatarAssets.loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-wave', fetchStudioAvatarAsset);
    const loader = vi.spyOn(avatarAssets, 'loadAvatarSequence').mockRejectedValueOnce(new Error('Transient failure')).mockResolvedValue(wave);
    engine.setGesture(1); animate(engine, entry);
    await vi.waitFor(() => expect(states.at(-1)?.phase).toBe('error'));
    engine.setGesture(1); await playing(engine, entry);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('rejects missing explicit entries and unsupported rigs without an invented fallback wave', async () => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    const id = engine.setGesture(3); animate(engine, entry);
    expect(states.at(-1)).toMatchObject({ requestId: id, phase: 'error', reason: 'unavailable' });
    vi.spyOn(avatarAssets, 'loadAvatarModel').mockRejectedValue(new Error('Unsupported bind shear'));
    engine.setAvatarType(1); const failed = inspect(engine).avatars.get(localSession)!;
    const next = engine.setGesture(1);
    await vi.waitFor(() => expect(failed.root.userData.avatarAssetError).toContain('Unsupported bind shear'));
    animate(engine, failed);
    expect(states.at(-1)).toMatchObject({ requestId: next, phase: 'error', reason: 'unavailable' });
    expect(failed.body.visible).toBe(true); expect(failed.body.children[5].rotation.z).toBe(0);
  });

  it.each(['', '   ', '\t\n'])('rejects a blank explicit sequence %j instead of reporting idle as a successful gesture', async sequence => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    entry.definition = { ...entry.definition!, explicit: [{ name: 'Wave', sequence }] };
    const id = engine.setGesture(1); animate(engine, entry);
    expect(states.at(-1)).toMatchObject({ requestId: id, phase: 'error', reason: 'unavailable' });
    expect(entry.gesture).toBeUndefined(); expect(entry.sequenceName).toBe('wf-idle');
    await vi.waitFor(() => expect(entry.sequence?.format).toBe('binary'));
    animate(engine, entry, now + 10_000);
    expect(states.filter(state => state.phase === 'playing' || state.reason === 'completed')).toEqual([]);
    expect(entry.avatar.gesture).toBe(0);
  });

  it('disposes timers and prevents a deleted avatar receiving its outstanding animation', async () => {
    const { engine } = makeEngine(); engine.setAvatar(avatar);
    const entry = await ready(engine, avatar.session), pending = deferred<avatarAssets.AvatarSequence>();
    const wave = await avatarAssets.loadAvatarSequence(STUDIO_AVATAR_PATH, 'wf-wave', fetchStudioAvatarAsset);
    vi.useFakeTimers(); vi.spyOn(avatarAssets, 'loadAvatarSequence').mockImplementation(() => pending.promise);
    engine.setAvatar({ ...avatar, gesture: 1 }); animate(engine, entry); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1); engine.deleteAvatar(avatar.session);
    pending.resolve(wave); await Promise.resolve(); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0); expect(entry.sequence).toBeUndefined(); expect(entry.root.parent).toBeNull();
  });

  it.each([-1, 1.5, 256, NaN, Infinity])('rejects invalid local index %s without a pending animation or timer', async value => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    const id = engine.setGesture(value);
    expect(states.at(-1)).toMatchObject({ requestId: id, gesture: 0, phase: 'error', reason: 'invalid' });
    expect(entry.gesture).toBeUndefined();
  });

  it('does not borrow studio gestures for a network world whose catalog is unavailable', async () => {
    const { engine, states, asset } = makeEngine();
    engine.setWorld({ ...createDemoWorld().settings, demo: false, objectPath: '' });
    const id = engine.setGesture(1), entry = inspect(engine).avatars.get(localSession)!;
    animate(engine, entry);
    expect(states.at(-1)).toMatchObject({ requestId: id, phase: 'error', reason: 'unavailable' });
    expect(entry.rig).toBeUndefined(); expect(entry.body.visible).toBe(true); expect(asset).not.toHaveBeenCalled();
  });

  it('treats a same-name studio-to-network transition as a new source and cancels its local playback', async () => {
    const { engine, states } = makeEngine(), entry = await ready(engine);
    const id = engine.setGesture(1); await playing(engine, entry);
    engine.updateWorld({ ...createDemoWorld().settings, demo: false });
    expect(states.at(-1)).toMatchObject({ requestId: id, phase: 'idle', reason: 'world-changed' });
    const next = inspect(engine).avatars.get(localSession)!;
    expect(next).not.toBe(entry); expect(next.rig).toBeUndefined(); expect(next.avatar.gesture).toBe(0);
  });
});
