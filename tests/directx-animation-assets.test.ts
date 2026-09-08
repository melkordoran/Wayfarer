import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { Quaternion, SkinnedMesh, Vector3 } from 'three';
import {
  checkDirectXAnimationStudioBundle, directXAnimationAssets, directXAnimationContentType,
  directXAnimationExpectations, directXAnimationStudioBundle, directXAnimationStudioJson, withDirectXAnimationCatalog,
} from '../scripts/directx-animation-assets.mjs';
import { directXFixtureAssets, studioDirectXFixtureAssets } from '../scripts/directx-fixture-assets.mjs';
import bundle from '../src/renderer/engine/studio-directx-animation-data.json';
import { directXJointName, loadAvatarSequence, parseAvatarCatalog, parseAvatarSequence, sampleAvatarSequence } from '../src/renderer/engine/avatar-assets';
import { parseDirectX } from '../src/renderer/engine/directx';
import { createDirectXInstance } from '../src/renderer/engine/directx-mesh';
import { boundedUnzip } from '../src/renderer/engine/zip';

const project = resolve(import.meta.dirname, '..');
const generator = resolve(project, 'scripts/directx-animation-assets.mjs');
const studioPath = resolve(project, 'src/renderer/engine/studio-directx-animation-data.json');
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const unzip = (bytes: Uint8Array) => boundedUnzip(bytes, { maxBytes: 100_000, maxEntries: 16 });
const near = (actual: readonly number[], expected: readonly number[], precision = 6) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], precision));
};

/** Independent byte-level reader, not the production X parser. */
function binaryAudit(bytes: Uint8Array) {
  const bits = Number(text(bytes.subarray(12, 16))), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 16, depth = 0;
  const names: string[] = [], integers: number[] = [], floats: number[][] = [];
  while (offset < bytes.length) {
    const token = view.getUint16(offset, true); offset += 2;
    if (token === 1) {
      const length = view.getUint32(offset, true); offset += 4;
      names.push(text(bytes.subarray(offset, offset + length))); offset += length;
    } else if (token === 3) { integers.push(view.getUint32(offset, true)); offset += 4; }
    else if (token === 7) {
      const count = view.getUint32(offset, true); offset += 4;
      expect(count).toBe(4);
      const values: number[] = [];
      for (let i = 0; i < count; i++) { values.push(bits === 32 ? view.getFloat32(offset, true) : view.getFloat64(offset, true)); offset += bits / 8; }
      floats.push(values);
    } else if (token === 10) depth++;
    else if (token === 11) depth--;
    else throw new Error(`Unexpected original fixture token ${token}`);
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0); expect(offset).toBe(bytes.length);
  return { bits, names, integers, floats };
}

/** Independent Node-zlib envelope probe; does not call production decompression. */
function compressedAudit(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), expected = view.getUint32(16, true);
  let offset = 20, body = Buffer.alloc(0), chunks = 0;
  while (offset < bytes.length) {
    const outputSize = view.getUint16(offset, true), inputSize = view.getUint16(offset + 2, true); offset += 4;
    expect([...bytes.subarray(offset, offset + 2)]).toEqual([0x43, 0x4b]);
    const decoded = inflateRawSync(bytes.subarray(offset + 2, offset + inputSize), { dictionary: body.subarray(Math.max(0, body.length - 32768)) });
    expect(decoded.length).toBe(outputSize);
    body = Buffer.concat([body, decoded]); offset += inputSize; chunks++;
  }
  expect(body.length + 16).toBe(expected); expect(offset).toBe(bytes.length); expect(chunks).toBeGreaterThan(1);
  return body;
}

describe('original DirectX salute asset generation', () => {
  it('is import-pure and returns fresh deterministic bounded motion bytes', () => {
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(generator).href)})`], { encoding: 'utf8' })).toBe('');
    const a = directXAnimationAssets(), b = directXAnimationAssets();
    expect(a.size).toBe(12); expect([...a.keys()]).toEqual([...b.keys()]);
    expect([...a.values()].reduce((sum, value) => sum + value.length, 0)).toBeLessThan(20_000);
    for (const [name, bytes] of a) { expect(bytes).toEqual(b.get(name)); expect(name).toMatch(/^seqs\/[a-z0-9A-Z.-]+$/); expect(bytes.length).toBeLessThan(4096); }
    a.get('seqs/wf-x-salute.x')!.fill(0);
    expect(b.get('seqs/wf-x-salute.x')![0]).toBe(0x78);
    expect(text(a.get('seqs/directx-animation-LICENSE.txt')!)).toContain('CC0 1.0 Universal');
  });

  it('contains five exact-name one-member ZIP pairs and a noncolliding raw SEQ alias', () => {
    const assets = directXAnimationAssets(); let count = 0;
    for (const [name, bytes] of assets) if (name.endsWith('.zip')) {
      const raw = name.replace(/\.zip$/, '.x'), members = unzip(bytes); count++;
      expect(Object.keys(members)).toEqual([raw.split('/').at(-1)]);
      expect(Object.values(members)[0]).toEqual(assets.get(raw));
    }
    expect(count).toBe(5);
    expect(assets.get('seqs/wf-x-salute-seq.seq')).toEqual(assets.get('seqs/wf-x-salute.x'));
    expect(assets.has('seqs/wf-x-salute-seq.zip')).toBe(false);
  });

  it.each([32, 64])('serializes binary%i directly from authored records and preserves quaternion signs', bits => {
    const assets = directXAnimationAssets(), audit = binaryAudit(assets.get(`seqs/wf-x-salute-binary${bits}.x`)!);
    expect(audit.bits).toBe(bits); expect(audit.floats).toHaveLength(25);
    expect(audit.names).toContain('AnimTicksPerSecond');
    expect(audit.names).toEqual(expect.arrayContaining(['aw_pelvis', 'aw_shoulder_l', 'aw_elbow_l', 'aw_head']));
    expect(audit.integers[0]).toBe(30);
    const sourceKeys = directXAnimationExpectations().tracks.flatMap(track => track.angles.map(([, angle]) => {
      const half = angle * Math.PI / 360;
      return [Math.cos(half), ...track.axis.map(axis => axis ? -axis * Math.sin(half) : 0)];
    }));
    audit.floats.forEach((values, index) => near(values, sourceKeys[index], bits === 32 ? 7 : 12));
    // Elbow track follows 2 pelvis and 8 shoulder keys; key2 is the 90deg witness.
    near(audit.floats[12], [Math.SQRT1_2, 0, 0, -Math.SQRT1_2], 7);
  });

  it('independently unwraps tzip and bzip envelopes with cross-chunk zlib history', () => {
    const assets = directXAnimationAssets();
    expect(compressedAudit(assets.get('seqs/wf-x-salute-tzip.x')!)).toEqual(Buffer.from(assets.get('seqs/wf-x-salute.x')!.subarray(16)));
    expect(compressedAudit(assets.get('seqs/wf-x-salute-bzip.x')!)).toEqual(Buffer.from(assets.get('seqs/wf-x-salute-binary32.x')!.subarray(16)));
  });

  it.each(['UTC', 'America/Toronto', 'Pacific/Auckland'])('reproduces the14-entry Studio overlay read-only in %s', TZ => {
    const before = readFileSync(studioPath), modified = statSync(studioPath).mtimeMs;
    expect(execFileSync(process.execPath, [generator, '--studio', '--check'], { encoding: 'utf8', env: { ...process.env, TZ } })).toContain('Verified 14 original DirectX animation Studio assets.');
    expect(readFileSync(studioPath)).toEqual(before); expect(statSync(studioPath).mtimeMs).toBe(modified);
    expect(checkDirectXAnimationStudioBundle()).toBe(14);
    expect(directXAnimationStudioBundle()).toEqual(bundle); expect(directXAnimationStudioJson()).toBe(before.toString('utf8'));
  });

  it.each([['studio', studioDirectXFixtureAssets, 3], ['live', directXFixtureAssets, 2]] as const)('appends XSalute only to avatar2 while preserving existing%s catalog ordinals', (_label, make, gestureCount) => {
    const base = make(), before = new Map([...base].map(([name, bytes]) => [name, bytes.slice()]));
    const updated = withDirectXAnimationCatalog(base), repeated = withDirectXAnimationCatalog(updated);
    expect(updated.size).toBe(base.size);
    for (const [name, bytes] of base) { expect(bytes).toEqual(before.get(name)); if (!/^avatars\/avatars\.(?:dat|zip)$/.test(name)) expect(updated.get(name)).toEqual(bytes); }
    expect(updated).toEqual(repeated);
    const oldCatalog = parseAvatarCatalog(text(base.get('avatars/avatars.dat')!)), catalog = parseAvatarCatalog(text(updated.get('avatars/avatars.dat')!));
    expect(catalog.entries.slice(0, 2)).toEqual(oldCatalog.entries.slice(0, 2));
    expect(catalog.entries[2].explicit.slice(0, -1)).toEqual(oldCatalog.entries[2].explicit);
    expect(catalog.entries[2].explicit).toHaveLength(gestureCount);
    expect(catalog.entries[2].explicit.at(-1)).toEqual({ name: 'X Salute', sequence: 'wf-x-salute.x' });
    expect(unzip(updated.get('avatars/avatars.zip')!)['avatars.dat']).toEqual(updated.get('avatars/avatars.dat'));
    const plain = text(base.get('avatars/avatars.dat')!); expect(text(updated.get('avatars/avatars.dat')!).replace('  X Salute=wf-x-salute.x\n', '')).toBe(plain);
    const unchanged = [...base.keys()].find(name => !/^avatars\/avatars\./.test(name))!;
    updated.get(unchanged)!.fill(0); expect(base.get(unchanged)).toEqual(before.get(unchanged));
  });

  it('refuses missing/misidentified/conflicting catalogs without changing their bytes', () => {
    expect(() => withDirectXAnimationCatalog(new Map())).toThrow('catalog');
    for (const replacement of ['geometry=wrong.x', 'geometry=wf-x-voyager.x\n  X Salute=wrong.x']) {
      const base = studioDirectXFixtureAssets(), original = text(base.get('avatars/avatars.dat')!);
      const changed = new TextEncoder().encode(original.replace('geometry=wf-x-voyager.x', replacement));
      base.set('avatars/avatars.dat', changed);
      expect(() => withDirectXAnimationCatalog(base)).toThrow(); expect(base.get('avatars/avatars.dat')).toBe(changed);
    }
  });
});

describe('original salute real decoder and weighted-avatar evidence', () => {
  it('loads every raw/ZIP/compressed form without network and reaches the same known pose', async () => {
    const assets = directXAnimationAssets(), network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const base = 'https://animation-fixture.wayfarer.invalid/';
    const fetcher = async (url: string) => {
      if (!url.startsWith(base)) throw new Error('Outside original fixture');
      const name = url.slice(base.length), bytes = assets.get(name);
      if (!bytes) throw new Error('Missing original fixture');
      return { bytes: bytes.slice(), contentType: directXAnimationContentType(name) };
    };
    try {
      for (const [path, bytes] of assets) if (/\.(?:x|seq)$/.test(path)) {
        const raw = parseAvatarSequence(bytes), loaded = await loadAvatarSequence(base, path.slice(5), fetcher);
        for (const sequence of [raw, loaded]) {
          expect(sequence.format).toBe('directx'); expect(sequence.durationMs).toBe(4000); expect(sequence.joints.map(joint => joint.name)).toEqual(['pelvis', 'lfshoulder', 'lfelbow', 'head']);
          const witness = sampleAvatarSequence(sequence, 1000);
          near(witness.get('lfelbow')!.rotation.toArray(), [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
          near(witness.get('lfshoulder')!.rotation.toArray(), [0, 0, 0, 1]); near(witness.get('head')!.rotation.toArray(), [0, 0, 0, 1]);
          for (const time of [0, 4000, 4500]) for (const pose of sampleAvatarSequence(sequence, time).values()) { near(pose.rotation.toArray(), [0, 0, 0, 1]); near(pose.translation.toArray(), [0, 0, 0]); }
        }
      }
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it('moves the original skin witness exactly, raises the whole arm, and returns both instances to neutral', () => {
    const original = studioDirectXFixtureAssets(), model = parseDirectX(original.get('avatars/wf-x-voyager.x')!);
    const a = createDirectXInstance(model, { jointName: directXJointName }), b = createDirectXInstance(model, { jointName: directXJointName });
    const sequence = parseAvatarSequence(directXAnimationAssets().get('seqs/wf-x-salute-tzip.x')!), oracle = directXAnimationExpectations();
    let mesh: SkinnedMesh | undefined; a.root.traverse(node => { if (node instanceof SkinnedMesh) mesh = node; });
    const positions = mesh!.geometry.getAttribute('position'); let index = -1;
    for (let i = 0; i < positions.count; i++) if (new Vector3().fromBufferAttribute(positions, i).distanceTo(new Vector3(...oracle.witness.sourceSpacePoint)) < 1e-6) { index = i; break; }
    expect(index).toBeGreaterThanOrEqual(0);
    const witness = () => mesh!.localToWorld(mesh!.getVertexPosition(index, new Vector3()));
    const wrist = () => a.joints.get('lfwrist')!.group.getWorldPosition(new Vector3());
    const restWrist = wrist();
    try {
      near(witness().toArray(), oracle.witness.sourceSpacePoint);
      a.applyPose(sampleAvatarSequence(sequence, 1000, { rootMotion: false }));
      near(witness().toArray(), oracle.witness.sourceSpaceResult);
      expect(b.joints.get('lfelbow')!.group.quaternion.angleTo(new Quaternion())).toBeLessThan(1e-8);
      a.applyPose(sampleAvatarSequence(sequence, 1900, { rootMotion: false }));
      expect(wrist().y - restWrist.y).toBeGreaterThan(.75);
      expect(a.joints.get('lfshoulder')!.group.quaternion.angleTo(new Quaternion())).toBeCloseTo(Math.PI / 2);
      expect(a.joints.get('head')!.group.quaternion.angleTo(new Quaternion())).toBeCloseTo(8 * Math.PI / 180);
      for (const instance of [a, b]) {
        instance.applyPose(sampleAvatarSequence(sequence, 4000, { rootMotion: false }));
        for (const joint of instance.joints.values()) { expect(joint.group.quaternion.angleTo(joint.bindRotation)).toBeLessThan(1e-8); expect(joint.group.position.distanceTo(joint.bindPosition)).toBeLessThan(1e-8); }
      }
      near(witness().toArray(), oracle.witness.sourceSpacePoint); near(wrist().toArray(), restWrist.toArray());
    } finally { a.dispose(); b.dispose(); }
  });
});
