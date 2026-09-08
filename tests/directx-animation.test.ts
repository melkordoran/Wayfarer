import { describe, expect, it, vi } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { parseDirectX } from '../src/renderer/engine/directx';
import { avatarAssetUrls, loadAvatarCatalog, loadAvatarSequence, parseAvatarSequence, sampleAvatarSequence } from '../src/renderer/engine/avatar-assets';
import { decodeModelAsset } from '../src/renderer/engine/assets';
import { directXMatrixReferenceText, directXQuaternionReferenceText, directXReferenceOracle as oracle } from './fixtures/directx-animation-oracles';

const bytes = strToU8;
const x = (body: string) => `xof 0303txt 0032\n${body}`;
const key = (type: number, records: Array<[number, number[]]>) => `AnimationKey {${type};${records.length};${records.map(([tick, values]) => `${tick};${values.length};${values.join(',')};;`).join(',')}}`;
const rotations = key(0, [[0, [1, 0, 0, 0]], [30, [Math.SQRT1_2, 0, 0, -Math.SQRT1_2]]]);
const animation = (blocks = rotations, target = 'aw_lfelbow', options = '') => `Animation { {${target}} ${options} ${blocks} }`;
const file = (blocks = rotations, target = 'aw_lfelbow', settings = '') => x(`AnimationSet Original {${settings}${animation(blocks, target)}}`);
const parse = (source: string) => parseAvatarSequence(bytes(source));
const qNear = (actual: Quaternion, values: readonly number[]) => expect(actual.angleTo(new Quaternion(...values as [number, number, number, number]))).toBeLessThan(5e-7);

/** Independent little-endian typed-record emitter, never fed by the X lexer. */
function binary(bits: 32 | 64, type: 0 | 3 | 4 = 0): Uint8Array {
  const chunks: Uint8Array[] = [bytes(`xof 0303bin 00${bits}`)];
  const word = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); chunks.push(b); };
  const dword = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); chunks.push(b); };
  const name = (value: string) => { word(1); const b = bytes(value); dword(b.length); chunks.push(b); };
  const integers = (...values: number[]) => { word(6); dword(values.length); values.forEach(dword); };
  const floats = (values: readonly number[]) => {
    word(7); dword(values.length); const b = new Uint8Array(values.length * bits / 8), view = new DataView(b.buffer);
    values.forEach((value, index) => bits === 32 ? view.setFloat32(index * 4, value, true) : view.setFloat64(index * 8, value, true)); chunks.push(b);
  };
  const open = (value: string) => { name(value); word(10); };
  open('AnimationSet'); open('AnimTicksPerSecond'); integers(30); word(11);
  open('Animation'); word(10); name(oracle.target); word(11);
  const block = (kind: number, keys: readonly { tick: number; values: readonly number[] }[]) => {
    open('AnimationKey'); integers(kind, keys.length);
    for (const k of keys) { integers(k.tick, k.values.length); floats(k.values); }
    word(11);
  };
  if (type === 0) { block(0, oracle.rotationKeys); block(2, oracle.translationKeys); }
  else block(type, oracle.matrixKeys);
  word(11); word(11);
  const result = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0)); let at = 0;
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
  return result;
}

function mszip(source: Uint8Array): Uint8Array {
  const body = source.subarray(16), deflated = deflateRawSync(body);
  const result = new Uint8Array(26 + deflated.length), view = new DataView(result.buffer);
  result.set(source.subarray(0, 16)); result.set(bytes(source[8] === 98 ? 'bzip' : 'tzip'), 8);
  view.setUint32(16, source.length, true); view.setUint16(20, body.length, true); view.setUint16(22, deflated.length + 2, true);
  result.set([67, 75], 24); result.set(deflated, 26); return result;
}

describe('explicit DirectX AW-reference animation profile', () => {
  it.each([
    ['quaternion/translation', bytes(directXQuaternionReferenceText)],
    ['matrix3', bytes(directXMatrixReferenceText(3))],
    ['matrix4', bytes(directXMatrixReferenceText(4))],
    ['binary32 rotation', binary(32)], ['binary64 rotation', binary(64)],
    ['binary32 matrix3', binary(32, 3)], ['binary64 matrix4', binary(64, 4)],
    ['tzip text', mszip(bytes(directXQuaternionReferenceText))], ['bzip binary', mszip(binary(32))],
  ])('preserves independently authored noncommuting reference oracles: %s', (_name, source) => {
    const sequence = parseAvatarSequence(source as Uint8Array);
    expect(sequence).toMatchObject({ format: 'directx', durationMs: 1000, rootJoint: 'pelvis' });
    expect(sequence.joints).toHaveLength(1);
    const first = sampleAvatarSequence(sequence, 0).get(oracle.canonicalJoint)!;
    qNear(first.rotation, [0, 0, 0, 1]); expect(first.translation.length()).toBeLessThan(1e-8);
    const last = sampleAvatarSequence(sequence, 1000).get(oracle.canonicalJoint)!;
    qNear(last.rotation, oracle.relativeThreeQuaternion); expect(last.translation.toArray()).toEqual([...oracle.translationDelta]);
    const binding = new Quaternion(...oracle.firstThreeQuaternion);
    const point = new Vector3(...oracle.testPoint).applyQuaternion(binding.multiply(last.rotation)).add(new Vector3(...oracle.geometryBindPosition)).add(last.translation);
    expect(point.distanceTo(new Vector3(...oracle.expectedLastRetargetedPoint))).toBeLessThan(1e-6);
    expect(sequence.warnings.join(' ')).toMatch(/historical AW exporter parity is not yet verified/);
  });
  it('matches quaternion and matrix samples between differently oriented reference keys', () => {
    const q = parse(directXQuaternionReferenceText), m = parse(directXMatrixReferenceText(4));
    for (const time of [0, 125, 250, 500, 875, 1000]) {
      const a = sampleAvatarSequence(q, time).get('lfelbow')!, b = sampleAvatarSequence(m, time).get('lfelbow')!;
      expect(a.rotation.angleTo(b.rotation)).toBeLessThan(5e-7); expect(a.translation.distanceTo(b.translation)).toBeLessThan(1e-9);
    }
  });
  it('keeps different channel time sets synchronized and applies the caller root-motion policy', () => {
    const source = x(`AnimTicksPerSecond {60;} AnimationSet Original {
      ${animation(key(2, [[0, [8, 4, 2]], [120, [10, 6, 4]]]), 'aw_pelvis')}
      ${animation(key(0, [[30, [1, 0, 0, 0]], [90, [0, 0, 0, -1]]]) + key(2, [[0, [1, 2, 3]], [60, [4, 2, 3]], [120, [7, 2, 3]]]))}}`);
    const sequence = parse(source);
    expect(sequence.durationMs).toBe(2000);
    const a = sampleAvatarSequence(sequence, 1000, { rootMotion: false });
    expect(a.get('pelvis')!.translation.length()).toBe(0); expect(a.get('lfelbow')!.translation.x).toBe(3);
    qNear(a.get('lfelbow')!.rotation, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    expect(sampleAvatarSequence(sequence, 1000).get('pelvis')!.translation.toArray()).toEqual([1, 1, 1]);
    qNear(sampleAvatarSequence(sequence, 250).get('lfelbow')!.rotation, [0, 0, 0, 1]);
    expect(sequence.warnings.join(' ')).toMatch(/starts after tick zero/);
  });
  it('retains existing loop, clamp and negative-time semantics without mutating keys', () => {
    const sequence = parse(file()), before = sequence.joints[0].rotations.map(k => k.rotation.toArray());
    qNear(sampleAvatarSequence(sequence, -20).get('lfelbow')!.rotation, [0, 0, 0, 1]);
    expect(sampleAvatarSequence(sequence, 2000).get('lfelbow')!.rotation.angleTo(sampleAvatarSequence(sequence, 1000).get('lfelbow')!.rotation)).toBeLessThan(1e-7);
    expect(sampleAvatarSequence(sequence, -250, { loop: true }).get('lfelbow')!.rotation.angleTo(sampleAvatarSequence(sequence, 750).get('lfelbow')!.rotation)).toBeLessThan(1e-7);
    expect(sequence.joints[0].rotations.map(k => k.rotation.toArray())).toEqual(before);
  });
  it('reads document or nested-set ticks, and defaults to thirty without shifting key times', () => {
    expect(parse(file()).durationMs).toBe(1000);
    expect(parse(file(rotations, 'aw_lfelbow', 'AnimTicksPerSecond {60;}')).durationMs).toBe(500);
    expect(parse(x('AnimTicksPerSecond {15;}' + file().slice(17))).durationMs).toBe(2000);
  });
  it('does not turn geometry loading into automatic embedded-set playback', () => {
    const source = file() + '\nMesh Original {3;0;0;0;,1;0;0;,0;1;0;;1;3;0,1,2;;}';
    const model = parseDirectX(source);
    expect(model.meshes).toHaveLength(1); expect(model.animationSets).toBeUndefined();
    expect(model.warnings.join(' ')).toMatch(/Embedded DirectX animation is not played/);
    expect(parse(source).durationMs).toBe(1000);
  });
  it('resolves a UUID-only animation reference against named original Frames', () => {
    const uuid = '<12345678-1234-5678-9abc-123456789abc>';
    const source = x(`Frame aw_lfelbow {${uuid}} AnimationSet Original {${animation(rotations, uuid)}}`);
    expect(parse(source).joints[0].name).toBe('lfelbow');
  });
  it('warns about unknown joints but never fabricates an all-unmapped gesture', () => {
    const sequence = parse(x(`AnimationSet Original {${animation()}${animation(rotations, 'other_exporter_bone')}}`));
    expect(sequence.joints).toHaveLength(1); expect(sequence.warnings.join(' ')).toMatch(/Unrecognized.*other_exporter_bone/);
    expect(() => parse(file(rotations, 'other_exporter_bone'))).toThrow(/no supported motion tracks/);
  });
  it('retains the geometry bind scale when the source reference scale is constant', () => {
    const scale = key(1, [[0, [2, 3, 4]], [30, [2, 3, 4]]]);
    const sequence = parse(file(rotations + scale));
    expect(sequence.warnings.join(' ')).toMatch(/retains its own bind scale/);
    expect(sampleAvatarSequence(sequence, 1000).get('lfelbow')).not.toHaveProperty('scale');
  });
  it.each([
    ['empty set', x('AnimationSet {}'), /no tracks/],
    ['no set', x('Frame A {}'), /exactly one/],
    ['multiple sets', file() + 'AnimationSet Other {}', /exactly one/],
    ['duplicate canonical tracks', x(`AnimationSet Original {${animation()}${animation(rotations, 'aw_elbow_l')}}`), /same AW joint/],
    ['two targets', file().replace('{aw_lfelbow}', '{aw_lfelbow}{aw_back}'), /more than one target/],
    ['empty target', file().replace('{aw_lfelbow}', '{}'), /empty target/],
    ['zero quaternion', file(key(0, [[0, [0, 0, 0, 0]], [30, [1, 0, 0, 0]]])), /zero quaternion/],
    ['repeated times', file(key(0, [[0, [1, 0, 0, 0]], [0, [1, 0, 0, 0]]])), /strictly increasing/],
    ['descending times', file(key(0, [[30, [1, 0, 0, 0]], [0, [1, 0, 0, 0]]])), /strictly increasing/],
    ['fractional time', file(key(0, [[0, [1, 0, 0, 0]], [0.5, [1, 0, 0, 0]]])), /animation time/],
    ['negative time', file(key(0, [[-1, [1, 0, 0, 0]], [30, [1, 0, 0, 0]]])), /animation time/],
    ['wrong arity', file(key(0, [[0, [1, 0, 0]], [30, [1, 0, 0]]])), /value count/],
    ['unknown type', file(key(5, [[0, [1]], [30, [1]]])), /key type/],
    ['duplicate key block', file(rotations + rotations), /duplicate animation key/],
    ['empty block', file('AnimationKey {0;0;}'), /empty/],
    ['empty track', file(''), /requires a target and key/],
    ['zero duration', file(key(0, [[0, [1, 0, 0, 0]]])), /positive duration/],
    ['excess duration', file(key(0, [[0, [1, 0, 0, 0]], [0xffffffff, [1, 0, 0, 0]]])), /24 hours/],
    ['changing scale', file(rotations + key(1, [[0, [1, 1, 1]], [30, [2, 2, 2]]])), /changing scale/],
    ['changing tiny scale', file(rotations + key(1, [[0, [1e-6, 1e-6, 1e-6]], [30, [1e-5, 1e-5, 1e-5]]])), /changing scale/],
    ['scale-only', file(key(1, [[0, [1, 1, 1]], [30, [1, 1, 1]]])), /no supported motion/],
    ['negative scale', file(rotations + key(1, [[0, [-1, 1, 1]], [30, [-1, 1, 1]]])), /negative reference scale/],
    ['unknown track metadata', file(rotations + 'UnknownExtension {}'), /unsupported animation-track/],
    ['unknown set metadata', file(rotations, 'aw_lfelbow', 'UnknownExtension {}'), /unsupported animation-set/],
    ['misplaced track', x(animation()), /misplaced animation/],
    ['compressed animation set', x('CompressedAnimationSet {}'), /unsupported or misplaced/],
    ['duplicate nested ticks', file(rotations, 'aw_lfelbow', 'AnimTicksPerSecond {30;} AnimTicksPerSecond {30;}'), /duplicate.*tick rate/],
    ['document and set ticks', x('AnimTicksPerSecond {30;}' + file(rotations, 'aw_lfelbow', 'AnimTicksPerSecond {30;}').slice(17)), /ambiguous.*tick rates/],
    ['unknown target UUID', file(rotations, '<12345678-1234-5678-9abc-123456789abc>'), /UUID is unresolved/],
    ['key budget', file('AnimationKey {0;100001;}'), /animation key/],
  ] as const)('rejects %s without claiming playable animation', (_name, source, message) => {
    expect(() => parse(source)).toThrow(message);
  });
  it.each([0, 1, 201, 0xffffffff])('rejects out-of-profile tick rate %s', ticks => expect(() => parse(file(rotations, 'aw_lfelbow', `AnimTicksPerSecond {${ticks};}`))).toThrow(/2–200/));
  it.each([
    ['shear', [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], /sheared/],
    ['tiny shear', [1e-6, 0, 0, 0, 1e-6, 1e-6, 0, 0, 0, 0, 1e-6, 0, 0, 0, 0, 1], /sheared/],
    ['reflection', [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], /reflected/],
    ['singular', [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], /singular/],
    ['perspective', [1, 0, 0, 0.1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], /affine/],
  ] as const)('rejects %s matrix transforms', (_name, values, message) => {
    expect(() => parse(file(key(4, [[0, [...values]], [30, [...values]]])))).toThrow(message);
  });
  it('rejects changing tiny matrix scale and mixed matrix/component channels', () => {
    const a = new Matrix4().makeScale(1e-6, 1e-6, 1e-6).toArray(), b = new Matrix4().makeScale(1e-5, 1e-5, 1e-5).toArray();
    expect(() => parse(file(key(4, [[0, a], [30, b]])))).toThrow(/changing matrix scale/);
    expect(() => parse(file(key(4, [[0, a], [30, a]]) + rotations))).toThrow(/cannot be mixed/);
  });
  it('rejects explicit spline translation but allows rotation-only linear-independent options', () => {
    const translation = key(2, [[0, [0, 0, 0]], [30, [1, 0, 0]]]);
    expect(() => parse(x(`AnimationSet Original {${animation(translation, 'aw_back', 'AnimationOptions {1;0;}')}}`))).toThrow(/spline/);
    expect(parse(x(`AnimationSet Original {${animation(rotations, 'aw_back', 'AnimationOptions {1;0;}')}}`)).joints).toHaveLength(1);
  });
  it('rejects excessive sets/tracks and bounds decompressed animation bytes separately from geometry', () => {
    expect(() => parse(x('AnimationSet {} '.repeat(65)))).toThrow(/set budget/);
    expect(() => parse(x(`AnimationSet Original {${animation().repeat(257)}}`))).toThrow(/track budget/);
    const compressed = mszip(bytes(file())); new DataView(compressed.buffer).setUint32(16, 16_000_001, true);
    expect(() => parseAvatarSequence(compressed)).toThrow(/expanded byte limit/);
    expect(() => parseAvatarSequence(new Uint8Array(16_000_001))).toThrow(/16 MB/);
  });
  it('rejects every truncated binary prefix instead of playing a partial track', () => {
    const source = binary(64);
    for (let end = 0; end < source.length; end++) expect(() => parseAvatarSequence(source.subarray(0, end))).toThrow();
  });
});

describe('format-aware bounded sequence asset loading', () => {
  it.each(['sequence', 'catalog', 'model'] as const)('rejects a forged ZIP expansion even when its truncated %s prefix and prefix CRC are valid', async kind => {
    const content = kind === 'sequence' ? file() : kind === 'catalog' ? 'version 3\navatar\nname=Original\ngeometry=original.rwx\nendavatar\n' : 'ModelBegin\nClumpBegin\nVertex 0 0 0\nVertex 1 0 0\nVertex 0 1 0\nTriangle 1 2 3\nClumpEnd\nModelEnd\n';
    const prefix = bytes(content), filename = kind === 'sequence' ? 'wave.x' : kind === 'catalog' ? 'avatars.dat' : 'original.rwx';
    const corrupt = zipSync({ [filename]: bytes(content + 'invalid-hidden-trailer'.repeat(5000)) });
    let crc = 0xffffffff;
    for (const byte of prefix) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    crc = (crc ^ 0xffffffff) >>> 0;
    const view = new DataView(corrupt.buffer);
    let central = -1;
    for (let i = 0; i < corrupt.length - 4; i++) if (view.getUint32(i, true) === 0x02014b50) { central = i; break; }
    expect(central).toBeGreaterThan(0);
    view.setUint32(14, crc, true); view.setUint32(22, prefix.length, true);
    view.setUint32(central + 16, crc, true); view.setUint32(central + 24, prefix.length, true);
    const fetcher = async () => ({ bytes: corrupt, contentType: 'application/zip' });
    if (kind === 'sequence') await expect(loadAvatarSequence('https://original.invalid/', 'wave.x', fetcher)).rejects.toThrow(/expansion exceeds/);
    else if (kind === 'catalog') await expect(loadAvatarCatalog('https://original.invalid/', fetcher)).rejects.toThrow(/expansion exceeds/);
    else await expect(decodeModelAsset(corrupt, 'original.rwx')).rejects.toThrow(/expansion exceeds/);
  });
  it.each([
    ['wave.x', ['wave.zip', 'wave.x']], ['wave.seq', ['wave.zip', 'wave.seq']],
    ['wave', ['wave.zip', 'wave.seq', 'wave.x']], ['wave.zip', ['wave.zip', 'wave.seq', 'wave.x']],
  ])('preserves explicit versus automatic lookup for %s', (name, expected) => expect(avatarAssetUrls('https://original.invalid/', name as string, 'sequence')).toEqual((expected as string[]).map(file => 'https://original.invalid/seqs/' + file)));
  it.each([
    ['raw X', bytes(directXQuaternionReferenceText), 'wave.x'],
    ['X named SEQ', bytes(directXQuaternionReferenceText), 'wave.seq'],
    ['raw binary X', binary(64), 'wave.x'],
    ['ZIP X', zipSync({ 'wave.x': binary(32) }), 'wave.x'],
    ['nested ZIP X', zipSync({ 'seqs/wave.x': binary(32), 'unrelated.seq': bytes('ignored') }), 'wave.x'],
    ['ZIP X-as-SEQ', zipSync({ 'wave.seq': binary(64) }), 'wave.seq'],
    ['GZIP ZIP tzip X', gzipSync(zipSync({ 'wave.x': mszip(bytes(directXQuaternionReferenceText)) })), 'wave.x'],
  ])('loads %s through the real dispatcher', async (_kind, content, name) => {
    const fetcher = vi.fn(async () => ({ bytes: content as Uint8Array, contentType: 'application/octet-stream' }));
    expect((await loadAvatarSequence('https://original.invalid/', name as string, fetcher)).format).toBe('directx');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('selects only the requested matching format and rejects ambiguous automatic selection', async () => {
    const content = zipSync({ 'wave.x': binary(32), 'wave.seq': bytes('not selected'), 'other.x': bytes('not selected') });
    const fetcher = async () => ({ bytes: content, contentType: '' });
    expect((await loadAvatarSequence('https://original.invalid/', 'wave.x', fetcher)).format).toBe('directx');
    await expect(loadAvatarSequence('https://original.invalid/', 'wave', fetcher)).rejects.toThrow(/exactly one/);
  });
  it('tries raw X after ZIP/SEQ misses, but does not hide a present malformed response', async () => {
    const fetcher = vi.fn(async (url: string) => { if (!url.endsWith('.x')) throw new Error('Missing'); return { bytes: binary(32), contentType: '' }; });
    expect((await loadAvatarSequence('https://original.invalid/', 'wave', fetcher)).format).toBe('directx'); expect(fetcher).toHaveBeenCalledTimes(3);
    const malformed = vi.fn(async () => ({ bytes: bytes('invalid body'), contentType: '' }));
    await expect(loadAvatarSequence('https://original.invalid/', 'wave.x', malformed)).rejects.toThrow(/filename\/header/); expect(malformed).toHaveBeenCalledTimes(1);
  });
  it.each(['../wave.x', '/wave.x', 'C:wave.x', 'wave\u0001.x', '.x', 'wave.x.zip'])('rejects unsafe or ambiguous sequence name %s before fetch', async name => {
    const fetcher = vi.fn(); await expect(loadAvatarSequence('https://original.invalid/', name, fetcher)).rejects.toThrow(/Invalid/); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['../wave.x', '/wave.x', 'folder/../wave.x', 'folder\\wave.x', 'wave\u0000.x'])('rejects unsafe archive path %s', async name => {
    await expect(loadAvatarSequence('https://original.invalid/', 'wave.x', async () => ({ bytes: zipSync({ [name]: binary(32) }), contentType: '' }))).rejects.toThrow(/Invalid path/);
  });
  it('rejects duplicate names and more than 1024 ZIP entries before selected decompression', async () => {
    const fetcher = async (value: Uint8Array) => loadAvatarSequence('https://original.invalid/', 'wave.x', async () => ({ bytes: value, contentType: '' }));
    await expect(fetcher(zipSync({ 'wave.x': binary(32), 'WAVE.X': binary(32) }))).rejects.toThrow(/Duplicate/);
    const empty = Object.fromEntries(Array.from({ length: 1024 }, (_, i) => [`metadata/${i}.txt`, new Uint8Array()]));
    await expect(fetcher(zipSync({ ...empty, 'wave.x': binary(32) }))).rejects.toThrow(/1024/);
  });
});
