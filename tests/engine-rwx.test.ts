import { describe, expect, it } from 'vitest';
import { parseRwx } from '../src/renderer/engine/rwx';
import { assetUrls, decodeRwx, unpackAsset } from '../src/renderer/engine/assets';
import { strToU8, zipSync } from 'fflate';

const triangle = `Vertex 0 0 0 UV 0 0\nVertex 1 0 0 UV 1 0\nVertex 0 1 0 UV 0 1\nTriangle 1 2 3`;
describe('RWX asset contract', () => {
  it('preserves inline PRELIGHT colors without losing geometry or UVs', () => {
    const source = 'Vertex 0 0 0 UV 0 0 PRELIGHT 1 0 0\nVertex 1 0 0 prelight 0 1 0 UV 1 0\nVertex 0 1 0 PRELIGHT 0 0 1 UV 0 1\nTriangle 1 2 3';
    const model = parseRwx(source);
    expect(model.parts[0].positions).toEqual(parseRwx(triangle).parts[0].positions);
    expect(model.parts[0].uvs).toEqual(parseRwx(triangle).parts[0].uvs);
    expect(model.parts[0].prelight).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(model.warnings).toEqual([]);
  });
  it('converts modelling units to metres and preserves UV coordinates', () => {
    const model = parseRwx(`ModelBegin\nClumpBegin\n${triangle}\nClumpEnd\nModelEnd`);
    expect(model.parts[0].positions).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    expect(model.parts[0].uvs).toEqual([0, 1, 1, 1, 0, 0]);
    expect(model.warnings).toEqual([]);
  });
  it('instantiates prototypes with independent transform and material state', () => {
    const model = parseRwx(`ProtoBegin leaf\n${triangle}\nProtoEnd\nClumpBegin\nTransformBegin\nTranslate 2 0 0\nScale 2 2 2\nColor 1 0 0\nProtoInstance leaf\nTransformEnd\nProtoInstance leaf\nClumpEnd`, 1);
    expect(model.parts).toHaveLength(2);
    expect(model.parts[0].positions).toEqual([2, 0, 0, 4, 0, 0, 2, 2, 0]);
    expect(model.parts[1].positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(model.parts[0].material.color).toEqual([1, 0, 0]);
    expect(model.parts[1].material.color).toEqual([1, 1, 1]);
  });
  it('does not discard vertices declared within a transform block', () => {
    const model = parseRwx(`ClumpBegin\nVertex 0 0 0\nTransformBegin\nTranslate 1 0 0\nVertex 0 0 0\nTransformEnd\nVertex 0 1 0\nTriangle 1 2 3\nClumpEnd`, 1);
    expect(model.parts[0].positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });
  it('replaces the local transform matrix while preserving prototype instance placement', () => {
    const model = parseRwx(`ProtoBegin part\nTranslate 99 0 0\nTransform 1 0 0 0 0 1 0 0 0 0 1 0 2 0 0 1\n${triangle}\nProtoEnd\nTranslate 3 0 0\nProtoInstance part`, 1);
    expect(model.parts[0].positions.slice(0, 3)).toEqual([5, 0, 0]);
  });
  it('recognises official Double material mode and per-clump collision off', () => {
    const model = parseRwx(`ClumpBegin\nMaterialMode Double\nCollision off\nLightSampling Vertex\n${triangle}\nClumpEnd`);
    expect(model.parts[0].material).toMatchObject({ doubleSided: true, smooth: true });
    expect(model.parts[0].solid).toBe(false);
  });
  it('triangulates a concave polygon without filling its notch', () => {
    const model = parseRwx(`ClumpBegin\nVertex 0 0 0\nVertex 2 0 0\nVertex 2 2 0\nVertex 1 1 0\nVertex 0 2 0\nPolygon 5 1 2 3 4 5\nClumpEnd`, 1);
    const p = model.parts[0].positions;
    expect(p).toHaveLength(27);
    let area = 0;
    for (let i = 0; i < p.length; i += 9) area += Math.abs((p[i + 3] - p[i]) * (p[i + 7] - p[i + 1]) - (p[i + 6] - p[i]) * (p[i + 4] - p[i + 1])) / 2;
    expect(area).toBeCloseTo(3);
  });
  it('triangulates faces with collinear leading vertices', () => {
    const model = parseRwx('Vertex 0 0 0\nVertex 1 0 0\nVertex 2 0 0\nVertex 2 1 0\nVertex 0 1 0\nPolygon 5 1 2 3 4 5', 1);
    expect(model.parts[0].positions.length).toBeGreaterThanOrEqual(18);
    expect(model.warnings).toEqual([]);
  });
  it('handles materials, mask textures, opacity and polygon tags', () => {
    const model = parseRwx(`ClumpBegin\nTexture "bark" mask "barkm"\nOpacity .4\nMaterialMode DoubleSided\nTextureMode Foreshorten\n${triangle} Tag 100\nClumpEnd`);
    expect(model.parts[0].material).toMatchObject({ texture: 'bark', mask: 'barkm', opacity: 0.4, doubleSided: true, unlit: true });
    expect(model.parts[0].tag).toBe(100);
  });
  it('bounds recursive prototypes and reports malformed faces', () => {
    expect(parseRwx('ProtoBegin loop\nProtoInstance loop\nProtoEnd\nProtoInstance loop').warnings).toContain('Prototype recursion limit reached');
    expect(parseRwx('Vertex 0 0 0\nTriangle 1 2 3').warnings[0]).toMatch(/Invalid face/);
  });
  it('loads model archives and rejects archives without RWX content', () => {
    expect(decodeRwx(zipSync({ 'models/test.rwx': strToU8(triangle) }))).toBe(triangle);
    expect(() => unpackAsset(zipSync({ 'note.txt': strToU8('not geometry') }), 'model')).toThrow(/no supported model/);
  });
  it('uses the object path and tries standard compressed then plain model names', () => {
    expect(assetUrls('http://127.0.0.1:17400/assets', '../ground.rwx', 'models')).toEqual(['http://127.0.0.1:17400/assets/models/ground.zip', 'http://127.0.0.1:17400/assets/models/ground.rwx']);
    expect(assetUrls('', 'ground', 'models')).toEqual([]);
  });
});
