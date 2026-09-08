import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WorldEngine, type GesturePlaybackState } from '../src/renderer/engine';
import { createDemoWorld } from '../src/renderer/engine/demo';
import * as avatarAssets from '../src/renderer/engine/avatar-assets';
import { loadAvatarSequence, parseAvatarSequence, sampleAvatarSequence } from '../src/renderer/engine/avatar-assets';
import { strToU8, zipSync } from 'fflate';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    shadowMap = {}; capabilities = { getMaxAnisotropy: () => 1 }; info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  } };
});

// These are original typed records, not output from the production parser.
const key = (kind: number, records: Array<[number, number[]]>) =>
  `AnimationKey {${kind};${records.length};${records.map(([tick, values]) => `${tick};${values.length};${values.join(',')};;`).join(',')}}`;
const x = (target: string, blocks: string) => strToU8(`xof 0303txt 0032\nAnimationSet Review {
  AnimTicksPerSecond {30;} Animation {{${target}} ${blocks}}}`);
const positionKeys = key(2, [[0, [3, 5, 7]], [30, [3, 6, 7]]]);
const rowMatrix = (y: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, y, 7, 1];
const matrixPositionKeys = key(4, [[0, rowMatrix(5)], [30, rowMatrix(6)]]);

function fakeCanvas() {
  return Object.assign(new EventTarget(), {
    style: {}, clientWidth: 800, clientHeight: 600, width: 800, height: 600,
    getContext: () => ({ measureText: () => ({ width: 80 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} }),
  }) as unknown as HTMLCanvasElement;
}
type Entry = {
  root: THREE.Group; rig?: avatarAssets.AvatarRig; definition?: avatarAssets.AvatarDefinition;
  sequence?: avatarAssets.AvatarSequence; sequenceStarted: number; gesture?: { phase: string };
};
type Internals = { avatars: Map<number, Entry>; animateAvatar(entry: Entry, time: number, moving: boolean): void };
const localSession = -2147483647, engines: WorldEngine[] = [];
let now = 1000;
const inspect = (engine: WorldEngine) => engine as unknown as Internals;

async function readyGesture(source: Uint8Array) {
  const sequence = parseAvatarSequence(source), states: GesturePlaybackState[] = [];
  const network = vi.fn().mockRejectedValue(new Error('No network allowed'));
  const engine = new WorldEngine(fakeCanvas(), {
    asset: network, onPosition: vi.fn(), onSelect: vi.fn(), onStats: vi.fn(), onGestureState: state => states.push(state),
  });
  engines.push(engine); engine.setWorld(createDemoWorld().settings); engine.setAvatarType(2); engine.setCameraMode('third-person');
  const entry = inspect(engine).avatars.get(localSession)!;
  await vi.waitFor(() => expect(entry.rig?.joints.size).toBe(16));
  entry.definition = { ...entry.definition!, explicit: [{ name: 'Original review', sequence: 'wf-review.x' }] };
  const load = avatarAssets.loadAvatarSequence;
  vi.spyOn(avatarAssets, 'loadAvatarSequence').mockImplementation((path, name, fetcher) => name === 'wf-review.x' ? Promise.resolve(sequence) : load(path, name, fetcher));
  const requestId = engine.setGesture(1);
  inspect(engine).animateAvatar(entry, now, false);
  return { engine, entry, sequence, requestId, states, network };
}

beforeEach(() => {
  now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null, createElement: fakeCanvas }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('independent DirectX animation review regressions', () => {
  it.each([
    ['position channel', positionKeys],
    ['matrix channel with synthesized identity rotations', matrixPositionKeys],
  ])('does not report a gesture playing when root-motion policy suppresses its only motion: %s', async (_name, blocks) => {
    const { entry, sequence, requestId, states, network } = await readyGesture(x('aw_pelvis', blocks));
    // Prove this is real authored motion and that the current caller discards it.
    expect(sampleAvatarSequence(sequence, 500).get('pelvis')!.translation.toArray()).toEqual([0, .5, 0]);
    const filtered = sampleAvatarSequence(sequence, 500, { rootMotion: false }).get('pelvis')!;
    expect(filtered.translation.length()).toBe(0); expect(filtered.rotation.angleTo(new THREE.Quaternion())).toBe(0);
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ requestId, phase: 'error', reason: 'unavailable' }));
    expect(states.some(state => state.phase === 'playing')).toBe(false);
    expect(entry.gesture).toBeUndefined(); expect(network).not.toHaveBeenCalled();
  });

  it.each([
    ['position channel', positionKeys],
    ['matrix channel', matrixPositionKeys],
  ])('retains genuine nonroot translation gestures without requiring rotation: %s', async (_name, blocks) => {
    const { engine, entry, requestId, states, network } = await readyGesture(x('aw_head', blocks));
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ requestId, phase: 'playing' }));
    now = entry.sequenceStarted + 500; inspect(engine).animateAvatar(entry, now, false);
    const head = entry.rig!.joints.get('head')!;
    expect(head.group.position.clone().sub(head.bindPosition).distanceTo(new THREE.Vector3(0, .5, 0))).toBeLessThan(1e-12);
    expect(head.group.quaternion.angleTo(head.bindRotation)).toBe(0); expect(network).not.toHaveBeenCalled();
  });

  it('holds independent nonzero channel references and preserves a noncommuting delta across ZIP dispatch', async () => {
    const s = Math.SQRT1_2;
    // Source WXYZ: conjugated Rx(90) to Ry(90), starting at one second.
    const rotation = key(0, [[30, [s, -s, 0, 0]], [90, [s, 0, -s, 0]]]);
    // Translation does not begin until two seconds, and finishes at four.
    const translation = key(2, [[60, [3, 5, 7]], [120, [5, 8, 11]]]);
    const source = x('aw_elbow_l', rotation + translation), requests: string[] = [];
    const sequence = await loadAvatarSequence('https://review.invalid/', 'review.x', async url => {
      requests.push(url);
      expect(url).toBe('https://review.invalid/seqs/review.zip');
      return { bytes: zipSync({ 'original/review.x': source }), contentType: 'application/zip' };
    });
    expect(requests).toHaveLength(1); expect(sequence.durationMs).toBe(4000);
    for (const time of [-1000, 0, 500, 1000]) {
      const pose = sampleAvatarSequence(sequence, time).get('lfelbow')!;
      expect(pose.rotation.angleTo(new THREE.Quaternion())).toBe(0); expect(pose.translation.length()).toBe(0);
    }
    const atTwo = sampleAvatarSequence(sequence, 2000).get('lfelbow')!;
    expect(atTwo.rotation.angleTo(new THREE.Quaternion())).toBeCloseTo(Math.PI / 3);
    expect(atTwo.translation.length()).toBe(0);
    const atThree = sampleAvatarSequence(sequence, 3000).get('lfelbow')!;
    expect(atThree.rotation.angleTo(new THREE.Quaternion(-.5, .5, -.5, .5))).toBeLessThan(1e-7);
    expect(atThree.translation.toArray()).toEqual([1, 1.5, 2]);
    const atFour = sampleAvatarSequence(sequence, 4000).get('lfelbow')!;
    expect(atFour.rotation.angleTo(atThree.rotation)).toBe(0); expect(atFour.translation.toArray()).toEqual([2, 3, 4]);
    const beforeLoop = sampleAvatarSequence(sequence, -1000, { loop: true }).get('lfelbow')!;
    expect(beforeLoop.rotation.angleTo(atThree.rotation)).toBe(0); expect(beforeLoop.translation.toArray()).toEqual([1, 1.5, 2]);
  });
});
