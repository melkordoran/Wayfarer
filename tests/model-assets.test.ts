import { describe, expect, it, vi } from 'vitest';
import { deflateSync, gzipSync, strToU8, zipSync } from 'fflate';
import { directXFixtureAssets } from '../scripts/directx-fixture-assets.mjs';
import {
  assetUrls, decodeModelAsset, decodeRwx, firstAvailable, modelAssetNames, unpackAsset,
} from '../src/renderer/engine/assets';
import {
  avatarAssetUrls, directXJointName, loadAvatarModel, loadAvatarRwx, loadAvatarSequence, parseAvatarSequence,
} from '../src/renderer/engine/avatar-assets';

// Deliberately tiny original source fixtures; no vendor assets or downloaded models.
const rwx = 'ModelBegin\nClumpBegin\nTag 1\nVertex 0 0 0\nVertex 1 0 0\nVertex 0 1 0\nTriangle 1 2 3\nClumpEnd\nModelEnd';
const x = 'xof 0303txt 0032\nFrame aw_pelvis { Mesh Original { 3; 0;0;0;, 1;0;0;, 0;1;0;; 1; 3;0,1,2;; } }';
const bytesOf = strToU8;

// Original, single-chunk MSZIP envelope; larger/history cases have an independent
// node:zlib encoder and hand-authored bitstreams in directx-compression.test.ts.
function internalX(bytes: Uint8Array): Uint8Array {
  const raw = deflateSync(bytes.subarray(16)), out = new Uint8Array(26 + raw.length);
  out.set(bytes.subarray(0, 16));
  out.set(bytesOf(bytes[8] === 0x74 ? 'tzip' : 'bzip'), 8);
  const view = new DataView(out.buffer);
  view.setUint32(16, bytes.length, true);
  view.setUint16(20, bytes.length - 16, true);
  view.setUint16(22, raw.length + 2, true);
  out.set(bytesOf('CK'), 24); out.set(raw, 26);
  return out;
}

describe('explicit and automatic model asset addressing', () => {
  it.each([
    ['shape.rwx', ['shape.zip', 'shape.rwx']],
    ['shape.x', ['shape.zip', 'shape.x']],
    ['shape', ['shape.zip', 'shape.rwx', 'shape.x']],
    ['shape.zip', ['shape.zip', 'shape.rwx', 'shape.x']],
    ['Shape.X', ['Shape.zip', 'Shape.x']],
  ])('preserves format intent for %s', (name, expected) => {
    expect(modelAssetNames(name as string)).toEqual(expected);
    expect(assetUrls('https://assets.invalid/base/', name as string, 'models')).toEqual((expected as string[]).map(file => `https://assets.invalid/base/models/${file}`));
    expect(avatarAssetUrls('https://assets.invalid/base/', name as string, 'geometry')).toEqual((expected as string[]).map(file => `https://assets.invalid/base/avatars/${file}`));
  });
  it('keeps HTTP model URLs literal and does not reinterpret texture extensions', () => {
    expect(assetUrls('', 'https://assets.invalid/model.x?token=not-a-secret', 'models')).toEqual(['https://assets.invalid/model.x?token=not-a-secret']);
    expect(assetUrls('https://assets.invalid/', 'skin.png', 'textures')[0]).toBe('https://assets.invalid/textures/skin.png');
  });
  it.each(['model.cob', 'model.awcav', 'model.cav'])('does not label %s DirectX support', name => {
    expect(() => avatarAssetUrls('https://assets.invalid/', name, 'geometry')).toThrow(/not supported/);
  });
  it('returns the actual fallback URL without parsing or swallowing fetch failures', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (!url.endsWith('.x')) throw new Error('Not found');
      return { bytes: bytesOf(x), contentType: 'application/octet-stream' };
    });
    const result = await firstAvailable(fetcher, assetUrls('https://assets.invalid/', 'shape', 'models'));
    expect(result.url).toBe('https://assets.invalid/models/shape.x');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await decodeModelAsset(result.bytes, 'shape', result.url)).format).toBe('x');
  });
});

describe('bounded model wrapper and header dispatch', () => {
  it.each([
    ['raw RWX', bytesOf(rwx), 'original.rwx', 'rwx'],
    ['raw X', bytesOf(x), 'original.x', 'x'],
    ['ZIP RWX', zipSync({ 'models/original.rwx': bytesOf(rwx) }), 'original.rwx', 'rwx'],
    ['ZIP X', zipSync({ 'models/original.x': bytesOf(x) }), 'original.x', 'x'],
    ['GZIP RWX', gzipSync(bytesOf(rwx)), 'original.rwx', 'rwx'],
    ['GZIP X', gzipSync(bytesOf(x)), 'original.x', 'x'],
    ['GZIP ZIP X', gzipSync(zipSync({ 'original.x': bytesOf(x) })), 'original.x', 'x'],
    ['internal tzip X', internalX(bytesOf(x)), 'original.x', 'x'],
    ['ZIP internal tzip X', zipSync({ 'original.x': internalX(bytesOf(x)) }), 'original.x', 'x'],
    ['GZIP ZIP internal tzip X', gzipSync(zipSync({ 'original.x': internalX(bytesOf(x)) })), 'original.x', 'x'],
  ])('decodes %s', async (_label, bytes, name, format) => {
    const decoded = await decodeModelAsset(bytes as Uint8Array, name as string);
    expect(decoded.format).toBe(format);
    expect(decoded.source).toEqual(format === 'x' ? bytesOf(x) : rwx);
  });
  it('selects exact basename and explicit format in a mixed archive', async () => {
    const bytes = zipSync({ 'other.x': bytesOf('wrong'), 'models/original.x': bytesOf(x), 'original.rwx': bytesOf(rwx), 'readme.txt': bytesOf('Original fixture') });
    expect((await decodeModelAsset(bytes, 'original.x')).format).toBe('x');
    expect((await decodeModelAsset(bytes, 'original.rwx')).source).toBe(rwx);
    await expect(decodeModelAsset(bytes, 'original')).rejects.toThrow(/ambiguous/);
  });
  it('selects a lone matching automatic X without choosing a differently named RWX', async () => {
    const bytes = zipSync({ 'unrelated.rwx': bytesOf(rwx), 'folder/Original.X': bytesOf(x) });
    expect(await decodeModelAsset(bytes, 'original.zip')).toMatchObject({ format: 'x', filename: 'folder/Original.X' });
  });
  it.each([
    ['explicit X from RWX', bytesOf(rwx), 'original.x', undefined],
    ['explicit RWX from X', bytesOf(x), 'original.rwx', undefined],
    ['raw fallback RWX from X', bytesOf(x), 'original', 'https://assets.invalid/original.rwx'],
    ['raw fallback X from RWX', bytesOf(rwx), 'original', 'https://assets.invalid/original.x?version=1'],
    ['ZIP X member from RWX', zipSync({ 'original.x': bytesOf(rwx) }), 'original', undefined],
    ['ZIP RWX member from X', zipSync({ 'original.rwx': bytesOf(x) }), 'original', undefined],
  ])('rejects filename/header disagreement: %s', async (_label, bytes, name, source) => {
    await expect(decodeModelAsset(bytes as Uint8Array, name as string, source as string | undefined)).rejects.toThrow(/mismatch/);
  });
  it.each(['tzip', 'bzip'])('does not mistake internal %s compression for an outer ZIP', async encoding => {
    await expect(decodeModelAsset(bytesOf(`xof 0303${encoding}0032`), 'original.x')).rejects.toThrow(/MSZIP.*truncated/);
  });
  it.each(['other.x', 'original.rwx'])('never substitutes %s for an explicit original.x request', async name => {
    await expect(decodeModelAsset(zipSync({ [name]: bytesOf(name.endsWith('.x') ? x : rwx) }), 'original.x')).rejects.toThrow(/matching the requested/);
  });
  it('rejects ambiguous unnamed legacy archives instead of choosing alphabetically', () => {
    expect(() => unpackAsset(zipSync({ 'a.rwx': bytesOf(rwx), 'b.rwx': bytesOf(rwx) }), 'model')).toThrow(/ambiguous/);
  });
  it.each(['../original.x', '/original.x', 'C:/original.x', 'models/../original.x', 'models/./original.x', 'models\\original.x', 'original\0.x'])('rejects unsafe ZIP path %s', async path => {
    await expect(decodeModelAsset(zipSync({ [path]: bytesOf(x) }), 'original.x')).rejects.toThrow(/Invalid path/);
  });
  it('rejects case-folded duplicate and matching basenames in multiple directories', async () => {
    await expect(decodeModelAsset(zipSync({ 'original.x': bytesOf(x), 'ORIGINAL.X': bytesOf(x) }), 'original.x')).rejects.toThrow(/Duplicate/);
    await expect(decodeModelAsset(zipSync({ 'a/original.x': bytesOf(x), 'b/original.x': bytesOf(x) }), 'original.x')).rejects.toThrow(/ambiguous/);
  });
  it('bounds archive entry count even when all but one entry are irrelevant', async () => {
    const files = Object.fromEntries(Array.from({ length: 1024 }, (_, i) => [`readme${i}.txt`, bytesOf('x')]));
    await expect(decodeModelAsset(zipSync({ ...files, 'original.x': bytesOf(x) }), 'original.x')).rejects.toThrow(/1024/);
  });
  it('bounds incoming, ZIP-expanded and GZIP-expanded sizes', async () => {
    await expect(decodeModelAsset(new Uint8Array(30_000_001))).rejects.toThrow(/30 MB/);
    const zip = zipSync({ 'original.x': bytesOf(x) });
    const directory = zip.findIndex((_value, i) => zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 1 && zip[i + 3] === 2);
    new DataView(zip.buffer).setUint32(directory + 24, 30_000_001, true);
    new DataView(zip.buffer).setUint32(22, 30_000_001, true);
    await expect(decodeModelAsset(zip, 'original.x')).rejects.toThrow(/expanded size/);
    const gzip = gzipSync(bytesOf(x));
    new DataView(gzip.buffer).setUint32(gzip.length - 4, 30_000_001, true);
    await expect(decodeModelAsset(gzip, 'original.x')).rejects.toThrow(/expanded size/);
  });
  it('validates the GZIP checksum rather than trusting its filename', async () => {
    const corrupt = gzipSync(bytesOf(x)); corrupt[corrupt.length - 8] ^= 0xff;
    await expect(decodeModelAsset(corrupt, 'original.x')).rejects.toThrow();
  });
  it('keeps the synchronous legacy RWX wrapper explicit', () => {
    expect(decodeRwx(zipSync({ 'original.rwx': bytesOf(rwx) }))).toBe(rwx);
    expect(() => decodeRwx(bytesOf(x))).toThrow(/DirectX model loader/);
    expect(() => decodeRwx(zipSync({ 'original.x': bytesOf(x) }))).toThrow(/DirectX model loader/);
  });
});

describe('avatar geometry formats and documented joint aliases', () => {
  it.each([32, 64])('loads original binary%i geometry through raw, ZIP and GZIP wrappers', async bits => {
    const fixtures = directXFixtureAssets();
    const name = `wf-x-voyager-binary${bits}`;
    const raw = fixtures.get(`avatars/${name}.x`)!;
    const variants = [raw, fixtures.get(`avatars/${name}.zip`)!, gzipSync(raw), internalX(raw), gzipSync(zipSync({ [`${name}.x`]: internalX(raw) }))];
    for (const bytes of variants) {
      const model = await loadAvatarModel('https://assets.invalid/', `${name}.x`, async () => ({ bytes, contentType: '' }));
      expect(model.format).toBe('x');
      if (model.format !== 'x') throw new Error('Expected binary X');
      expect(model.encoding).toBe('binary');
      expect(model.floatBits).toBe(bits);
      expect(model.meshes.some(mesh => mesh.skinWeights.length > 1)).toBe(true);
      expect(model.frames.some(frame => directXJointName(frame.name) === 'lfelbow')).toBe(true);
    }
  });
  it('loads text X through only the injected fetcher, retaining source geometry units', async () => {
    const fetcher = vi.fn(async () => ({ bytes: zipSync({ 'original.x': bytesOf(x) }), contentType: 'application/zip' }));
    const model = await loadAvatarModel('https://assets.invalid/', 'original.x', fetcher);
    expect(model.format).toBe('x');
    if (model.format !== 'x') throw new Error('Expected X');
    expect(model.meshes[0].positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(model.frames[0].name).toBe('aw_pelvis');
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://assets.invalid/avatars/original.zip');
  });
  it('preserves RWX tagged rigs and the strict old loader', async () => {
    const fetcher = async () => ({ bytes: bytesOf(rwx), contentType: 'text/plain' });
    const model = await loadAvatarModel('https://assets.invalid/', 'original.rwx', fetcher);
    expect(model.format).toBe('rwx');
    if (model.format !== 'rwx') throw new Error('Expected RWX');
    expect(model.joints.has('pelvis')).toBe(true);
    expect((await loadAvatarRwx('https://assets.invalid/', 'original.rwx', fetcher)).joints.has('pelvis')).toBe(true);
    await expect(loadAvatarRwx('https://assets.invalid/', 'original.x', async () => ({ bytes: bytesOf(x), contentType: '' }))).rejects.toThrow(/loadAvatarModel/);
  });
  it.each([
    ['aw_pelvis', 'pelvis'], ['pelvis', 'pelvis'], ['AW_LFSHOULDER', 'lfshoulder'],
    ['aw_shoulderl', 'lfshoulder'], ['aw_shoulder_l', 'lfshoulder'], ['aw_hip_r', 'rthip'],
    ['aw_lipdownl', 'lfliplower'], ['aw_rt5finger2', 'rt5finger2'], ['aw_chest', 'chest'],
    ['aw_obj', 'obj1'], ['aw_lipupper', 'lips'], ['aw_back2', 'back2'],
  ])('resolves documented %s to the SEQ key %s', (name, expected) => {
    expect(directXJointName(name)).toBe(expected);
  });
  it.each(['RootFrame', 'Armature', 'mixamorig:Hips', 'Bip001 Pelvis', 'aw_littlefinger', '__proto__', 'constructor', ' aw_pelvis', 'aw_liplowerl'])('does not invent a joint for %s', name => {
    expect(directXJointName(name)).toBeUndefined();
  });
  it('rejects empty or non-animation X with an actionable sequence diagnostic', async () => {
    expect(() => parseAvatarSequence(bytesOf('xof 0303txt 0032\nAnimationSet {}'))).toThrow(/AnimationSet has no tracks/);
    const fetcher = vi.fn(async () => ({ bytes: bytesOf(x), contentType: '' }));
    await expect(loadAvatarSequence('https://assets.invalid/', 'wave.x', fetcher)).rejects.toThrow(/exactly one AnimationSet/);
    expect(fetcher).toHaveBeenCalled();
    await expect(loadAvatarSequence('https://assets.invalid/', 'wave.seq', fetcher)).rejects.toThrow(/exactly one AnimationSet/);
  });
});
