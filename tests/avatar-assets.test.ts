import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { Mesh, MeshBasicMaterial, BufferGeometry, Float32BufferAttribute, Quaternion, Vector3 } from 'three';
import {
  applyAvatarPose, avatarAssetUrls, loadAvatarCatalog, loadAvatarRwx, loadAvatarSequence,
  parseAvatarCatalog, parseAvatarRwx, parseAvatarSequence, sampleAvatarSequence,
} from '../src/renderer/engine/avatar-assets';

// Entirely original fixtures; no AW model, animation or catalog is redistributed.
const catalogText = `# Original Wayfarer format fixture
version 3
avatar
 name="Wanderer #1"
 geometry=wanderer.rwx
 autolook
 autowalk
 beginimp
  walk=stride
  idle=rest
 endimp
 beginexp
  group=Greetings
  Wave=hello
  group=Dance
  Wave=turn
  group=
  Bow=bow
 endexp
endavatar
avatar
 name=More people
endavatar
avatar
 name=Future geometry
 geometry=future.x
endavatar`;

class Writer {
  data: number[] = [];
  u16(n: number) { this.data.push(n >>> 8 & 255, n & 255); return this; }
  u32(n: number) { this.data.push(n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255); return this; }
  f32(n: number) { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setFloat32(0, n); this.data.push(...bytes); return this; }
  str(value: string) { const bytes = strToU8(value); this.u16(bytes.length + 1); this.data.push(...bytes, 0); return this; }
  bytes() { return Uint8Array.from(this.data); }
}
function binarySequence(options: { magic?: number; extras?: boolean; unknown?: boolean } = {}) {
  const writer = new Writer().u32(options.magic ?? 0x7f7f7f7a).u16(31).u32(1).str('original-avatar').str('pelvis');
  writer.str('back').u32(16).u32(2);
  writer.u32(1).f32(1).f32(0).f32(0).f32(0);
  writer.u32(31).f32(0).f32(0).f32(0).f32(1); // 180 degrees around Z.
  if (options.extras !== false) {
    writer.u32(options.unknown ? 4 : 3);
    for (const axis of [2, 4, 6]) writer.u32(4).u32(2).u32(1).f32(0).u32(31).f32(axis);
    if (options.unknown) writer.u32(16).u32(1).u32(1).f32(1).f32(0).f32(0).f32(0);
  }
  return writer.bytes();
}
const textSequence = `AWSQ Version=1 Limbs=2 Duration=1000
pelvis frames=2
0 0 0 1 0 0 0 0
1000 0 0 1 0 .2 .4 .6
back frames=2
0 0 0 1 0 0 0 0
1000 0 0 1 180 .1 0 0`;

describe('avatar catalogs and object-path assets', () => {
  it('preserves declaration ordinals, headings, implicit slots, duplicate gesture labels and groups', () => {
    const catalog = parseAvatarCatalog(catalogText);
    expect(catalog.version).toBe(3);
    expect(catalog.entries.map(entry => entry.index)).toEqual([0, 1, 2]);
    expect(catalog.entries[0]).toMatchObject({ name: 'Wanderer #1', geometry: 'wanderer.rwx', autoLook: true, autoWalk: true, implicit: { walk: 'stride', idle: 'rest' } });
    expect(catalog.entries[0].explicit).toEqual([
      { name: 'Wave', sequence: 'hello', group: 'Greetings' },
      { name: 'Wave', sequence: 'turn', group: 'Dance' },
      { name: 'Bow', sequence: 'bow' },
    ]);
    expect(catalog.entries[1].geometry).toBeUndefined();
    expect(catalog.entries[2].geometry).toBe('future.x');
    expect(catalog.warnings).toEqual([]);
  });
  it('keeps unknown metadata visible and treats prototype property names as ordinary keys', () => {
    const catalog = parseAvatarCatalog('version=3\navatar\nname=One\nunknown=on\nbeginimp\n__proto__=pose\nendimp\nendavatar');
    expect(catalog.entries[0].implicit.__proto__).toBe('pose');
    expect(catalog.warnings).toEqual(['Unknown avatar property: unknown']);
  });
  it.each([
    'avatar\nname=A\navatar', 'avatar\nname=A', 'avatar\nendavatar',
    'avatar\nname=A\nbeginimp\nendexp', 'avatar\nname=A\nbeginexp\nendavatar',
  ])('rejects structurally incomplete catalogs', source => expect(() => parseAvatarCatalog(source)).toThrow());
  it('uses distinct avatars and seqs folders with ZIP-first fallback', () => {
    expect(avatarAssetUrls('https://example.invalid/world', 'avatars.dat', 'catalog')).toEqual(['https://example.invalid/world/avatars/avatars.zip', 'https://example.invalid/world/avatars/avatars.dat']);
    expect(avatarAssetUrls('https://example.invalid/world/', 'wave.seq', 'sequence')[0]).toBe('https://example.invalid/world/seqs/wave.zip');
    expect(avatarAssetUrls('https://example.invalid/world/', 'person.rwx', 'geometry')[1]).toBe('https://example.invalid/world/avatars/person.rwx');
    expect(() => avatarAssetUrls('https://example.invalid/', '../secret', 'sequence')).toThrow('Invalid');
    expect(() => avatarAssetUrls('file:///tmp/', 'wave', 'sequence')).toThrow('HTTP');
    expect(avatarAssetUrls('https://example.invalid/', 'person.x', 'geometry')).toEqual(['https://example.invalid/avatars/person.zip', 'https://example.invalid/avatars/person.x']);
  });
  it('loads one catalog through the injected fetcher, ignoring unrelated archive entries', async () => {
    const fetcher = vi.fn(async () => ({ bytes: zipSync({ 'avatars.dat': strToU8(catalogText), 'readme.txt': strToU8('Original test') }), contentType: 'application/zip' }));
    expect((await loadAvatarCatalog('https://example.invalid/', fetcher)).entries).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledWith('https://example.invalid/avatars/avatars.zip');
  });
  it('rejects oversized expanded archives and ambiguous sequences', async () => {
    const fetcher = async () => ({ bytes: zipSync({ 'a.seq': binarySequence(), 'b.seq': binarySequence() }), contentType: 'application/zip' });
    await expect(loadAvatarSequence('https://example.invalid/', 'wave', fetcher)).rejects.toThrow('exactly one');
    const oversized = async () => ({ bytes: zipSync({ 'avatars.dat': new Uint8Array(4_000_001) }), contentType: 'application/zip' });
    await expect(loadAvatarCatalog('https://example.invalid/', oversized)).rejects.toThrow('expanded size');
  });
});

describe('original SEQ and AWSQ parsing/interpolation', () => {
  it.each([0x7f7f7f79, 0x7f7f7f7a])('reads BE version %s and converts WXYZ, frames and metres', magic => {
    const sequence = parseAvatarSequence(binarySequence({ magic }));
    expect(sequence).toMatchObject({ format: 'binary', durationMs: 1000, frameCount: 31, modelName: 'original-avatar', rootJoint: 'pelvis' });
    const pose = sampleAvatarSequence(sequence, 500);
    expect(pose.get('pelvis')!.translation.toArray()).toEqual([1, 2, 3]);
    expect(pose.get('back')!.rotation.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2))).toBeLessThan(1e-7);
  });
  it('supports legacy sequences without additional blocks and skips unexplained blocks explicitly', () => {
    expect(parseAvatarSequence(binarySequence({ extras: false })).rootTranslation).toBeUndefined();
    expect(parseAvatarSequence(binarySequence({ unknown: true })).warnings).toEqual(['1 legacy auxiliary blocks are not animated']);
  });
  it('clamps, loops, samples backwards, and optionally suppresses root motion', () => {
    const sequence = parseAvatarSequence(binarySequence());
    expect(sampleAvatarSequence(sequence, 5000).get('pelvis')!.translation.x).toBe(2);
    expect(sampleAvatarSequence(sequence, -500).get('pelvis')!.translation.x).toBe(0);
    expect(sampleAvatarSequence(sequence, 1500, { loop: true }).get('pelvis')!.translation.x).toBe(1);
    expect(sampleAvatarSequence(sequence, -250, { loop: true }).get('pelvis')!.translation.x).toBe(1.5);
    expect(sampleAvatarSequence(sequence, 500, { rootMotion: false }).has('pelvis')).toBe(false);
    expect(() => sampleAvatarSequence(sequence, NaN)).toThrow('Invalid');
  });
  it('parses AWSQ axis-angle with per-limb decametre translations', () => {
    const sequence = parseAvatarSequence(strToU8(textSequence));
    const pose = sampleAvatarSequence(sequence, 500);
    expect(pose.get('pelvis')!.translation.toArray()).toEqual([1, 2, 3]);
    expect(pose.get('back')!.translation.toArray()).toEqual([0.5, 0, 0]);
    expect(pose.get('back')!.rotation.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2))).toBeLessThan(1e-7);
    expect(sampleAvatarSequence(sequence, 500, { rootMotion: false }).get('pelvis')!.translation.length()).toBe(0);
    expect(sampleAvatarSequence(sequence, 500, { rootMotion: false }).get('back')!.translation.x).toBe(.5);
  });
  it('accepts comments/comma separators and reports optional non-identity scale keys', () => {
    const text = 'AWSQ Version=1 Limbs=1 Duration=10\npelvis frames=2\n// comment\n0,0,1,0,0,0,0,0,1,1,1\n10,0,1,0,0,0,0,0,2,2,2';
    expect(parseAvatarSequence(strToU8(text)).warnings).toEqual(['AWSQ scale keys are ignored, matching the documented legacy format']);
  });
  it('tolerates rounded zero-axis near-identity keys but rejects meaningful axisless rotations', () => {
    const text = 'AWSQ Version=1 Limbs=1 Duration=10\npelvis frames=2\n0 0 0 0 0.000008 0 0 0\n10 0 0 0 360 0 0 0';
    expect(parseAvatarSequence(strToU8(text)).warnings).toEqual(['Zero-axis near-identity rotation keys were normalized to identity']);
    expect(() => parseAvatarSequence(strToU8(text.replace('0.000008', '90')))).toThrow('no axis');
  });
  it('fetches ZIP then raw sequence when absent', async () => {
    const fetcher = vi.fn(async (url: string) => { if (url.endsWith('.zip')) throw new Error('404'); return { bytes: binarySequence(), contentType: 'application/octet-stream' }; });
    expect((await loadAvatarSequence('https://example.invalid/', 'wave', fetcher)).durationMs).toBe(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects all truncations except the explicitly allowed EOF-before-blocks legacy variant', () => {
    const complete = binarySequence(), legacyLength = binarySequence({ extras: false }).length;
    for (let length = 0; length < complete.length; length++) {
      if (length === legacyLength) continue;
      expect(() => parseAvatarSequence(complete.subarray(0, length)), `length ${length}`).toThrow();
    }
  });
  it('rejects count bombs, invalid quaternions, non-finite numbers, bad frame ordering and trailing data', () => {
    const bombs = new Writer().u32(0x7f7f7f7a).u16(31).u32(0xffffffff).bytes();
    expect(() => parseAvatarSequence(bombs)).toThrow('count');
    const header = () => new Writer().u32(0x7f7f7f7a).u16(31).u32(1).str('avatar').str('').str('back').u32(16).u32(1).u32(1);
    expect(() => parseAvatarSequence(header().f32(0).f32(0).f32(0).f32(0).bytes())).toThrow('zero quaternion');
    expect(() => parseAvatarSequence(header().f32(NaN).f32(0).f32(0).f32(0).bytes())).toThrow('Non-finite');
    const extra = Uint8Array.from([...binarySequence(), 0]);
    expect(() => parseAvatarSequence(extra)).toThrow('Trailing');
    expect(() => parseAvatarSequence(strToU8(textSequence.replace('1000 0 0 1 180', '0 0 0 1 180')))).toThrow('frame time');
    expect(() => parseAvatarSequence(strToU8(textSequence.replace('0 0 0 1 0 0 0 0', '1 0 0 1 0 0 0 0')))).toThrow('frame time');
    expect(() => parseAvatarSequence(strToU8(textSequence.replace('.2 .4 .6', '1e308 .4 .6')))).toThrow('frame record');
  });
});

// Two rigid clumps, authored specifically for this test. The back pivot is 1 m above pelvis.
const rigText = `ModelBegin
ClumpBegin
Translate 0 .1 0
Tag 1
Vertex 0 0 0
Vertex .1 0 0
Vertex 0 .1 0
Triangle 1 2 3
ClumpBegin
Translate 0 .1 0
Tag 2
Vertex 0 0 0
Vertex .1 0 0
Vertex 0 .1 0
Triangle 1 2 3
ClumpEnd
ClumpEnd
ModelEnd`;

describe('tagged RWX rigid-clump avatar prototype', () => {
  it('reconstructs bind pivots and unbakes vertex positions without changing rest geometry', () => {
    const rig = parseAvatarRwx(rigText);
    expect(rig.joints.get('pelvis')!.group.position.toArray()).toEqual([0, 1, 0]);
    expect(rig.joints.get('back')!.group.position.toArray()).toEqual([0, 1, 0]);
    expect(rig.joints.get('back')!.group.parent).toBe(rig.joints.get('pelvis')!.group);
    expect(rig.parts.map(entry => entry.part.positions.slice(0, 3))).toEqual([[0, 0, 0], [0, 0, 0]]);
    applyAvatarPose(rig, new Map());
    expect(rig.joints.get('back')!.group.getWorldPosition(new Vector3()).toArray()).toEqual([0, 2, 0]);
  });
  it('animates an attached rigid mesh and restores bind transforms when tracks disappear', () => {
    const rig = parseAvatarRwx(rigText), backPart = rig.parts[1];
    const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(backPart.part.positions, 3));
    const mesh = new Mesh(geometry, new MeshBasicMaterial()); backPart.parent.add(mesh);
    applyAvatarPose(rig, sampleAvatarSequence(parseAvatarSequence(binarySequence()), 500));
    const vertex = new Vector3(1, 0, 0).applyMatrix4(mesh.matrixWorld);
    expect(vertex.x).toBeCloseTo(1); expect(vertex.y).toBeCloseTo(5); expect(vertex.z).toBeCloseTo(3);
    applyAvatarPose(rig, new Map());
    expect(rig.joints.get('back')!.group.quaternion.angleTo(new Quaternion())).toBe(0);
    expect(rig.joints.get('pelvis')!.group.position.toArray()).toEqual([0, 1, 0]);
    geometry.dispose(); mesh.material.dispose();
  });
  it('supports untagged static models without pretending they have a skeleton', () => {
    const rig = parseAvatarRwx(rigText.replace(/Tag \d\n/g, ''));
    expect(rig.joints.size).toBe(0);
    expect(rig.warnings).toContain('Avatar has no tagged clumps and will remain static');
  });
  it('rejects ambiguous duplicated joints, tagged prototypes and malformed hierarchy', () => {
    expect(() => parseAvatarRwx(rigText.replace('Tag 2', 'Tag 1'))).toThrow('Duplicate');
    expect(() => parseAvatarRwx('ProtoBegin body\nTag 1\nProtoEnd')).toThrow('prototypes');
    expect(() => parseAvatarRwx('ClumpBegin\nTransformEnd')).toThrow('Unbalanced');
    expect(() => parseAvatarRwx('ClumpBegin\nScale 0 0 0\nTag 1\nClumpEnd')).toThrow('singular');
    expect(() => parseAvatarRwx('ClumpBegin\nTranslate 1 2\nTag 1\nClumpEnd')).toThrow('Invalid avatar transform');
  });
  it('loads RWX geometry only through the injected asset fetcher', async () => {
    const fetcher = vi.fn(async () => ({ bytes: zipSync({ 'original.rwx': strToU8(rigText) }), contentType: 'application/zip' }));
    expect((await loadAvatarRwx('https://example.invalid/', 'original.rwx', fetcher)).joints.size).toBe(2);
    expect(fetcher).toHaveBeenCalledWith('https://example.invalid/avatars/original.zip');
  });
  it('detects GZIP by signature even with .zip URLs, including checksum and expansion validation', async () => {
    const bytes = gzipSync(strToU8(rigText));
    const fetcher = async () => ({ bytes, contentType: 'application/octet-stream' });
    expect((await loadAvatarRwx('https://example.invalid/', 'original', fetcher)).joints.size).toBe(2);
    const corrupt = bytes.slice(); corrupt[corrupt.length - 8] ^= 0xff;
    await expect(loadAvatarRwx('https://example.invalid/', 'original', async () => ({ bytes: corrupt, contentType: '' }))).rejects.toThrow();
    const oversized = bytes.slice(); new DataView(oversized.buffer).setUint32(oversized.length - 4, 30_000_001, true);
    await expect(loadAvatarRwx('https://example.invalid/', 'original', async () => ({ bytes: oversized, contentType: '' }))).rejects.toThrow('expanded size');
  });
});

describe('original Haven avatar fixture round trip', () => {
  const assetRoot = resolve(import.meta.dirname, '../public/assets');
  it('reproduces every generated asset byte for byte without rewriting files', () => {
    const output = execFileSync(process.execPath, [resolve(import.meta.dirname, '../scripts/axis-avatar-assets.mjs'), '--check'], { encoding: 'utf8' });
    expect(output).toContain('Verified: 15 original avatar fixture assets');
  });
  it('loads both rig variants and idle/walk/wave through the same catalog/ZIP pipeline', async () => {
    const fetcher = async (url: string) => ({ bytes: new Uint8Array(readFileSync(resolve(assetRoot, '.' + new URL(url).pathname))), contentType: '' });
    const catalog = await loadAvatarCatalog('https://fixture.invalid/', fetcher);
    expect(catalog.entries.map(avatar => avatar.name)).toEqual(['Wayfarer Voyager', 'Haven Keeper']);
    for (const entry of catalog.entries) {
      const rig = await loadAvatarRwx('https://fixture.invalid/', entry.geometry!, fetcher);
      expect(rig.joints.size).toBe(16);
      expect(rig.parts.length).toBeGreaterThan(20);
      expect(rig.warnings).toEqual([]);
      for (const name of [entry.implicit.idle, entry.implicit.walk, entry.explicit[0].sequence]) {
        const sequence = await loadAvatarSequence('https://fixture.invalid/', name, fetcher);
        expect(sequence.warnings).toEqual([]);
        applyAvatarPose(rig, sampleAvatarSequence(sequence, sequence.durationMs / 4, { rootMotion: false }));
        expect([...rig.joints.values()].every(joint => joint.group.matrixWorld.elements.every(Number.isFinite))).toBe(true);
      }
      const walk = await loadAvatarSequence('https://fixture.invalid/', entry.implicit.walk, fetcher);
      expect(sampleAvatarSequence(walk, 250).get('rthip')!.rotation.angleTo(new Quaternion())).toBeGreaterThan(.3);
      const wave = await loadAvatarSequence('https://fixture.invalid/', entry.explicit[0].sequence, fetcher);
      expect(sampleAvatarSequence(wave, 1000).get('lfshoulder')!.rotation.angleTo(new Quaternion())).toBeGreaterThan(2);
    }
  });
});
