import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { parseRwx, rwxLine } from '../src/renderer/engine/rwx';
import { createRwxGroup, disposeModelTree, RwxPrelightMaterial } from '../src/renderer/engine/rwx-mesh';
import { applyAvatarPose, parseAvatarRwx } from '../src/renderer/engine/avatar-assets';
import { ModelPreviewSession } from '../src/renderer/engine/model-preview';
import { EnvironmentAssetSession } from '../src/renderer/engine/environment-assets';

const triangle = 'Vertex 0 0 0 UV 0 0\nVertex 1 0 0 UV 1 0\nVertex 0 1 0 UV 0 1\nTriangle 1 2 3';
const prelit = triangle.replace('UV 0 0', 'UV 0 0 PRELIGHT .2 .4 .6');
const roots: THREE.Group[] = [];
function mesh(source = prelit) {
  const root = createRwxGroup(parseRwx(source, 1)); roots.push(root);
  return root.children[0] as THREE.Mesh<THREE.BufferGeometry, RwxPrelightMaterial>;
}
function shader(material: RwxPrelightMaterial) {
  const result = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(result); return result;
}
afterEach(() => { roots.splice(0).forEach(root => disposeModelTree(root)); vi.restoreAllMocks(); });

describe('documented Vertex PRELIGHT syntax and scope', () => {
  it('accepts VertexExt, arbitrary UV/prelight order, scientific notation and #! inline extensions', () => {
    const model = parseRwx('VertexExt 0 0 0 UV 0 0 #!PRELIGHT 1e-1 .2 +.3 # ignored\nVertex 1 0 0 prelight .4 .5 .6 UV 1 0\nVertex 0 1 0 UV 0 1\nTriangle 1 2 3', 1);
    expect(model.parts[0].positions).toEqual(parseRwx(triangle, 1).parts[0].positions);
    expect(model.parts[0].uvs).toEqual([0, 1, 1, 1, 0, 0]);
    expect(model.parts[0].prelight).toEqual([.1, .2, .3, .4, .5, .6, .4, .5, .6]);
    expect(model.warnings).toEqual([]);
  });
  it('uses black before the first explicit value, and carries later colors through the clump', () => {
    const model = parseRwx(triangle.replace('UV 1 0', 'UV 1 0 PRELIGHT 1 0 0'));
    expect(model.parts[0].prelight).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0]);
  });
  it('promotes faces emitted before a later clump prelight declaration without losing array alignment', () => {
    const model = parseRwx(`${triangle}\nVertex 2 2 0 PRELIGHT .3 .5 .7\nTriangle 2 4 3`, 1);
    const part = model.parts[0];
    expect(part.prelight!.slice(0, 9)).toEqual(new Array(9).fill(0));
    expect(part.prelight!.length).toBe(part.positions.length);
    expect(part.prelight!.filter(value => value === .7)).toHaveLength(1);
  });
  it('resets child/sibling clumps to black and restores parent carry-forward state', () => {
    const model = parseRwx(`ClumpBegin\nTag 1\n${prelit}\nClumpBegin\nTag 2\n${triangle}\nClumpEnd\nVertex 0 2 0\nTriangle 1 2 4\nClumpEnd\nClumpBegin\nTag 3\n${triangle}\nClumpEnd`, 1);
    expect(model.parts.find(part => part.tag === 1)!.prelight).toEqual(Array.from({ length: 6 }, () => [.2, .4, .6]).flat());
    expect(model.parts.find(part => part.tag === 2)!.prelight).toBeUndefined(); expect(model.parts.find(part => part.tag === 3)!.prelight).toBeUndefined();
  });
  it('keeps carry-forward clump-local across transform and attribute scopes', () => {
    const model = parseRwx('ClumpBegin\nVertex 0 0 0 PRELIGHT 1 0 0\nTransformBegin\nTranslate 1 0 0\nAttributeBegin\nVertex 0 0 0 PRELIGHT 0 1 0\nAttributeEnd\nTransformEnd\nVertex 0 1 0\nTriangle 1 2 3\nClumpEnd', 1);
    expect(model.parts[0].positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(model.parts[0].prelight).toEqual([1, 0, 0, 0, 1, 0, 0, 1, 0]);
  });
  it('instantiates prototypes with isolated carried light colors while preserving transforms/material tint', () => {
    const model = parseRwx(`ProtoBegin lit\nTag 2\n${triangle.replace('UV 1 0', 'UV 1 0 PRELIGHT 0 0 1')}\nProtoEnd\nClumpBegin\nTag 1\n${prelit}\nTransformBegin\nTranslate 2 0 0\nScale 2 2 2\nColor .5 .6 .7\nProtoInstance lit\nTransformEnd\nProtoInstance lit\nVertex 0 2 0\nTriangle 1 2 4\nClumpEnd`, 1);
    const transformed = model.parts.find(part => part.material.color[0] === .5)!;
    expect(transformed.positions).toEqual([2, 0, 0, 4, 0, 0, 2, 2, 0]);
    expect(transformed.prelight).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 1]);
    expect(model.parts.find(part => part.tag === 1)!.prelight).toEqual(Array.from({ length: 6 }, () => [.2, .4, .6]).flat());
  });
  it('preserves vertex-color associations when triangulating concave polygons and reversed winding', () => {
    const source = 'Vertex 0 0 0 PRELIGHT 1 0 0\nVertex 2 0 0 PRELIGHT 0 1 0\nVertex 2 2 0 PRELIGHT 0 0 1\nVertex 1 1 0 PRELIGHT .5 .5 .5\nVertex 0 2 0 PRELIGHT 1 1 1\nPolygon 5 5 4 3 2 1';
    const part = parseRwx(source, 1).parts[0];
    const colors = new Map([['0,0,0', [1, 0, 0]], ['2,0,0', [0, 1, 0]], ['2,2,0', [0, 0, 1]], ['1,1,0', [.5, .5, .5]], ['0,2,0', [1, 1, 1]]]);
    for (let i = 0; i < part.positions.length; i += 3) expect(part.prelight!.slice(i, i + 3)).toEqual(colors.get(part.positions.slice(i, i + 3).join(',')));
  });
  it.each(['', '1 0', 'NaN 0 0', 'Infinity 0 0', '-.1 0 0', '1.1 0 0', '"" 0 0', "'' 0 0", '0x0 0 0', '0x1 0 0', '1 0 0 0', '1 0 0 PRELIGHT 0 0 0'])('rejects malformed RGB %j without resetting the safe prior clump color', invalid => {
    const source = `Vertex 0 0 0 PRELIGHT .25 .5 .75\nVertex 1 0 0 PRELIGHT ${invalid}\nVertex 0 1 0\nTriangle 1 2 3`;
    const model = parseRwx(source);
    expect(model.warnings).toHaveLength(1); expect(model.warnings[0]).toContain('Invalid RWX PRELIGHT');
    expect(model.parts[0].prelight).toEqual([.25, .5, .75, .25, .5, .75, .25, .5, .75]);
  });
  it('does not execute ordinary comments and keeps quoted hashes while honoring extension markers', () => {
    expect(rwxLine('Texture "stripe#1" # comment #! Prelight 1 1 1')).toBe('Texture "stripe#1"');
    expect(rwxLine('Vertex 0 0 0 #! PRELIGHT 1 0 0 #! UV 0 1 # hidden')).toBe('Vertex 0 0 0   PRELIGHT 1 0 0   UV 0 1');
    expect(parseRwx(`${triangle}\n# Vertex 0 0 0 PRELIGHT 1 1 1`).parts[0].prelight).toBeUndefined();
  });
  it('retains execution/prototype budgets when PRELIGHT uses extension spelling', () => {
    expect(() => parseRwx(`#! ${prelit.replaceAll('\n', '\n#! ')}`, 1, { maxCommands: 3 })).toThrow('source command budget');
    expect(() => parseRwx(`ProtoBegin p\n${prelit}\nProtoEnd\nProtoInstance p\nProtoInstance p`, 1, { maxPrototypeExpansions: 1 })).toThrow('prototype expansion budget');
  });
});

describe('shared PRELIGHT GPU material propagation', () => {
  it('keeps numeric RGB as linear lighting coefficients, separate from material/texture albedo', () => {
    const item = mesh(`Color .5 .25 .75\nTexture tint\n${prelit}`);
    expect(item.material).toBeInstanceOf(RwxPrelightMaterial); expect(item.material.vertexColors).toBe(false);
    expect(item.geometry.getAttribute('color')).toBeUndefined();
    const attribute = item.geometry.getAttribute('rwxPrelight');
    expect(attribute.count).toBe(3); expect(attribute.getX(0)).toBeCloseTo(.2); expect(attribute.getY(0)).toBeCloseTo(.4);
    expect(item.material.color.toArray()).toEqual([.5, .25, .75]);
    const compiled = shader(item.material);
    expect(compiled.vertexShader).toContain('vRwxPrelight = rwxPrelight;');
    expect(compiled.fragmentShader).toContain('totalEmissiveRadiance += diffuseColor.rgb * vRwxPrelight;');
    expect(compiled.fragmentShader.indexOf('#include <map_fragment>')).toBeLessThan(compiled.fragmentShader.indexOf('totalEmissiveRadiance +='));
    expect(compiled.fragmentShader).not.toContain('reflectedLight.directDiffuse = vec3(0.0)');
  });
  it('preserves prelight boundaries while welding smooth geometry, even at coincident positions/UVs', () => {
    const item = mesh(`LightSampling Vertex\n${prelit}\nVertex 0 0 0 UV 0 0 PRELIGHT 1 0 0\nVertex 1 0 0 UV 1 0\nVertex 0 1 0 UV 0 1\nTriangle 4 5 6`);
    expect(item.geometry.getAttribute('position').count).toBe(6); expect(item.geometry.getAttribute('rwxPrelight').count).toBe(6);
    expect(item.geometry.index).not.toBeNull();
  });
  it('retains the legacy materials exactly when geometry has no prelight', () => {
    const lit = mesh(triangle), unlit = mesh(`TextureMode null\n${triangle}`);
    expect(lit.material.constructor).toBe(THREE.MeshStandardMaterial); expect(unlit.material.constructor).toBe(THREE.MeshBasicMaterial);
    expect(lit.geometry.getAttribute('rwxPrelight')).toBeUndefined(); expect(unlit.geometry.getAttribute('rwxPrelight')).toBeUndefined();
  });
  it('uses an explicitly disclosed ambient-only approximation for prelit legacy TextureMode null', () => {
    const model = parseRwx(`TextureMode null\n${prelit}`), root = createRwxGroup(model); roots.push(root);
    const material = (root.children[0] as THREE.Mesh).material as RwxPrelightMaterial;
    expect(material.ambientOnly).toBe(true); expect(shader(material).fragmentShader).toContain('reflectedLight.directDiffuse = vec3(0.0)');
    expect(model.warnings[0]).toContain('ambient-only modern shading');
  });
  it('does not promote non-prelit sibling clumps into the ambient-only prelit material', () => {
    const model = parseRwx(`TextureMode null\nClumpBegin\n${triangle}\nClumpEnd\nClumpBegin\n${prelit}\nClumpEnd`), root = createRwxGroup(model); roots.push(root);
    expect(root.children).toHaveLength(2);
    expect((root.children[0] as THREE.Mesh).material.constructor).toBe(THREE.MeshBasicMaterial);
    expect((root.children[1] as THREE.Mesh).material).toBeInstanceOf(RwxPrelightMaterial);
  });
  it('preserves shader hooks and unique cache keys through material clone/copy and separate model instances', () => {
    const first = mesh(`TextureMode null\n${prelit}`), second = mesh(prelit);
    const clone = first.material.clone();
    expect(clone).toBeInstanceOf(RwxPrelightMaterial); expect(clone.ambientOnly).toBe(true);
    expect(shader(clone).fragmentShader).toContain('totalEmissiveRadiance +=');
    expect(clone.customProgramCacheKey()).toBe(first.material.customProgramCacheKey());
    expect(clone.customProgramCacheKey()).not.toBe(second.material.customProgramCacheKey());
    expect(first.geometry.getAttribute('rwxPrelight').array).not.toBe(second.geometry.getAttribute('rwxPrelight').array);
    first.geometry.getAttribute('rwxPrelight').setX(0, 0); expect(second.geometry.getAttribute('rwxPrelight').getX(0)).toBeCloseTo(.2);
    clone.dispose();
  });
  it('retains texture/mask/opacity behavior and prevents late image attachment after model disposal', async () => {
    const texture = new THREE.Texture(), mask = new THREE.Texture();
    const loadTexture = vi.fn(async (name: string) => name === 'tint' ? texture : mask);
    const root = createRwxGroup(parseRwx(`Texture tint Mask stencil\nOpacity .4\n${prelit}`), { loadTexture }); roots.push(root);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const item = root.children[0] as THREE.Mesh<THREE.BufferGeometry, RwxPrelightMaterial>;
    expect(item.material.map).toBe(texture); expect(item.material.alphaMap).toBe(mask); expect(item.material.opacity).toBe(.4); expect(item.material.alphaTest).toBe(.1);
    const geometry = vi.spyOn(item.geometry, 'dispose'), material = vi.spyOn(item.material, 'dispose'), textureDisposed = vi.spyOn(texture, 'dispose');
    disposeModelTree(root); roots.pop(); expect(geometry).toHaveBeenCalledTimes(1); expect(material).toHaveBeenCalledTimes(1); expect(textureDisposed).not.toHaveBeenCalled();
    const late = createRwxGroup(parseRwx(`Texture tint\n${prelit}`), { loadTexture });
    disposeModelTree(late); for (let i = 0; i < 5; i++) await Promise.resolve();
    expect((late.children[0] as THREE.Mesh<THREE.BufferGeometry, RwxPrelightMaterial>).material.map).toBeNull();
    texture.dispose(); mask.dispose();
  });
  it('rejects corrupt externally supplied color arrays rather than uploading mismatched attributes', () => {
    for (const colors of [[1, 0], new Array(9).fill(NaN), new Array(9).fill(2)]) {
      const model = parseRwx(prelit); model.parts[0].prelight = colors;
      expect(() => createRwxGroup(model)).toThrow('Invalid RWX PRELIGHT attribute');
    }
  });
});

describe('PRELIGHT through avatar, preview and environment pipelines', () => {
  it('preserves color/UV arrays through joint-local unbaking, VertexExt bind capture and animation', () => {
    const source = `ModelBegin\nClumpBegin\nTranslate 0 .1 0\nTag 1\n#! VertexExt 0 0 0 UV 0 0 PRELIGHT .2 .4 .6\nVertexExt .1 0 0 UV 1 0\nVertexExt 0 .1 0 UV 0 1\nTranslate 0 .4 0\nTriangle 1 2 3\nClumpEnd\nModelEnd`;
    const rig = parseAvatarRwx(source), part = rig.parts[0];
    expect(rig.joints.get('pelvis')!.bindPosition.y).toBe(1); expect(part.part.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(part.part.prelight).toEqual([.2, .4, .6, .2, .4, .6, .2, .4, .6]); expect(part.part.uvs).toEqual([0, 1, 1, 1, 0, 0]);
    const root = createRwxGroup({ parts: [part.part], warnings: [] }); roots.push(root); part.parent.add(root);
    const attribute = (root.children[0] as THREE.Mesh).geometry.getAttribute('rwxPrelight'), before = Array.from(attribute.array);
    applyAvatarPose(rig, new Map([['pelvis', { rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2), translation: new THREE.Vector3() }]]));
    rig.root.updateMatrixWorld(true);
    expect(new THREE.Vector3(1, 0, 0).applyMatrix4(root.matrixWorld).toArray()[1]).toBeCloseTo(2);
    expect(Array.from(attribute.array)).toEqual(before);
  });
  it('uses the same prelit geometry/material factory for preview and authored environment assets', async () => {
    const source = readFileSync(resolve(import.meta.dirname, 'fixtures/environment/prelight.rwx'), 'utf8');
    const fetcher = async () => ({ bytes: new TextEncoder().encode(source), contentType: 'text/plain' });
    const preview = new ModelPreviewSession(fetcher, 'https://fixtures.invalid/'), environment = new EnvironmentAssetSession(fetcher, 'https://fixtures.invalid/', 'skybox');
    try {
      const first = await preview.load('prelight'), second = await environment.load('prelight');
      const a = first.root.children[0] as THREE.Mesh, b = second.root.children[0] as THREE.Mesh;
      expect(a.material).toBeInstanceOf(RwxPrelightMaterial); expect(b.material).toBeInstanceOf(RwxPrelightMaterial);
      expect(Array.from(a.geometry.getAttribute('rwxPrelight').array)).toEqual(Array.from(b.geometry.getAttribute('rwxPrelight').array));
      expect(first.warnings).toEqual([]); expect(second.warnings).toEqual([]); expect((b.material as RwxPrelightMaterial).fog).toBe(false);
    } finally { preview.dispose(); environment.dispose(); }
  });
});
