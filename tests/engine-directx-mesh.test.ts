import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createDirectXInstance, disposeDirectXTree, triangulateDirectXFace } from '../src/renderer/engine/directx-mesh';
import type { DirectXMaterial, DirectXModel } from '../src/renderer/engine/directx';

const identity = () => new THREE.Matrix4().toArray();
const translate = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z).toArray();
const material = (): DirectXMaterial => ({ diffuse: [.8, .6, .4, 1], power: 24, specular: [.2, .3, .4], emissive: [.01, .02, .03] });
function model(): DirectXModel {
  return { format: 'x', encoding: 'text', version: '0303', floatBits: 32, frames: [], warnings: [], hasEmbeddedAnimation: false,
    meshes: [{ frame: null, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]], uvs: [0, 0, 1, 0, 0, 1], materialIndices: [0], materials: [material()], skinWeights: [] }] };
}
function skinned(): DirectXModel {
  const result = model();
  result.frames = [{ id: 0, parent: null, name: 'pelvis', matrix: translate(1, 0, 0) }, { id: 1, parent: 0, name: 'back', matrix: translate(0, 1, 0) }];
  result.meshes[0].frame = 0; result.meshes[0].positions = [0, 0, 0, 1, 1, 0, 0, 2, 0];
  result.meshes[0].skinWeights = [
    { bone: 'pelvis', indices: [0, 1, 2], weights: [.5, .5, .5], offsetMatrix: identity() },
    { bone: 'back', indices: [0, 1, 2], weights: [.5, .5, .5], offsetMatrix: translate(0, -1, 0) },
  ]; return result;
}
function firstMesh(root: THREE.Group): THREE.Mesh {
  let result!: THREE.Mesh; root.traverse(node => { if (!result && node instanceof THREE.Mesh) result = node; }); return result;
}
const jointName = (name: string) => name;
const pose = (rotation: THREE.Quaternion, translation = new THREE.Vector3()) => new Map([['back', { rotation, translation }]]);
const turns = () => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('DirectX shared static mesh construction', () => {
  it('retains source axes and metre-sized geometry instead of applying RWX scale', () => {
    const instance = createDirectXInstance(model()), mesh = firstMesh(instance.root);
    expect(Array.from(mesh.geometry.getAttribute('position').array)).toEqual(model().meshes[0].positions);
    expect(new THREE.Box3().setFromObject(instance.root).getSize(new THREE.Vector3()).toArray()).toEqual([1, 1, 0]);
    expect(instance.warnings.some(warning => /scale parity.*not yet verified/.test(warning))).toBe(true);
    instance.dispose();
  });
  it('preserves per-corner authored normals, UV origin, RGBA, material boundaries and Phong coefficients', () => {
    const source = model(), data = source.meshes[0];
    data.faces.push([0, 2, 1]); data.materialIndices = [1, 0]; data.materials.push({ ...material(), diffuse: [1, 0, 0, .5], power: 60 });
    data.normals = [0, 0, 1, 0, 0, -1]; data.normalFaces = [[0, 0, 0], [1, 1, 1]];
    data.colors = [1, 0, 0, 1, 0, 1, 0, .25, 0, 0, 1, 1];
    const instance = createDirectXInstance(source), mesh = firstMesh(instance.root), materials = mesh.material as THREE.MeshPhongMaterial[];
    expect(Array.from(mesh.geometry.getAttribute('normal').array)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
    expect(Array.from(mesh.geometry.getAttribute('uv').array).slice(0, 6)).toEqual([0, 1, 1, 1, 0, 0]);
    expect(mesh.geometry.getAttribute('color').itemSize).toBe(4);
    expect(mesh.geometry.groups).toEqual([{ start: 0, count: 3, materialIndex: 0 }, { start: 3, count: 3, materialIndex: 1 }]);
    expect(materials[1]).toBeInstanceOf(THREE.MeshPhongMaterial); expect(materials[1].color.toArray()).toEqual([.8, .6, .4]);
    expect(materials[1].specular.toArray()).toEqual([.2, .3, .4]); expect(materials[1].emissive.toArray()).toEqual([.01, .02, .03]);
    expect(materials[1].transparent).toBe(true); expect(materials[0].shininess).toBe(60); expect(materials[0].opacity).toBe(.5);
    instance.dispose();
  });
  it('triangulates a concave polygon without filling its notch or changing winding', () => {
    const positions = [0, 0, 0, 2, 0, 0, 2, 2, 0, 1, 1, 0, 0, 2, 0];
    for (const face of [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0]]) {
      const triangles = triangulateDirectXFace(face, positions);
      const areas = triangles.map(triangle => {
        const [a, b, c] = triangle.map(corner => new THREE.Vector3().fromArray(positions, face[corner] * 3));
        return b.sub(a).cross(c.sub(a)).z / 2;
      });
      expect(triangles).toHaveLength(3); expect(areas.every(area => Math.sign(area) === (face[0] ? -1 : 1))).toBe(true);
      expect(Math.abs(areas.reduce((sum, area) => sum + area, 0))).toBeCloseTo(3);
    }
  });
  it('retains frame transforms, front-face raycasting and object-owned world placement', () => {
    const source = model(); source.frames = [{ id: 4, name: 'scenery', parent: null, matrix: translate(2, 3, 4) }]; source.meshes[0].frame = 4;
    const instance = createDirectXInstance(source), mesh = firstMesh(instance.root);
    instance.root.position.x = 10; instance.root.updateMatrixWorld(true);
    expect(mesh.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([12, 3, 4]);
    const ray = new THREE.Raycaster(new THREE.Vector3(12.2, 3.2, 6), new THREE.Vector3(0, 0, -1));
    expect(ray.intersectObject(instance.root, true)).toHaveLength(1);
    ray.set(new THREE.Vector3(12.2, 3.2, 2), new THREE.Vector3(0, 0, 1)); expect(ray.intersectObject(instance.root, true)).toHaveLength(0);
    expect(mesh.userData.solid).toBe(true); instance.dispose();
  });
  it('does not auto-play embedded AnimationSet and explicitly reports static avatars', () => {
    const source = model(); source.hasEmbeddedAnimation = true;
    const instance = createDirectXInstance(source, { jointName });
    expect(instance.warnings.some(warning => /AnimationSet playback is not supported/.test(warning))).toBe(true);
    expect(instance.warnings.some(warning => /no recognized SEQ joints/.test(warning))).toBe(true); instance.dispose();
  });
  it('preserves static nonuniform and reflected affine geometry without claiming animated skin support', () => {
    const source = model(); source.frames = [{ id: 0, parent: null, name: 'static', matrix: new THREE.Matrix4().makeScale(-2, 1, 1).toArray() }]; source.meshes[0].frame = 0;
    const instance = createDirectXInstance(source); expect(new THREE.Box3().setFromObject(instance.root).getSize(new THREE.Vector3()).toArray()).toEqual([2, 1, 0]); instance.dispose();
  });
});

describe('DirectX independent weighted skeletons and SEQ pose application', () => {
  it('keeps the nonidentity mesh/bone bind matrices invariant and interpolates a two-bone vertex', () => {
    const instance = createDirectXInstance(skinned(), { jointName }), mesh = firstMesh(instance.root) as THREE.SkinnedMesh;
    expect(mesh).toBeInstanceOf(THREE.SkinnedMesh);
    expect(mesh.getVertexPosition(1, new THREE.Vector3()).toArray()).toEqual([1, 1, 0]);
    expect(mesh.bindMatrix.elements[12]).toBe(1);
    instance.applyPose(pose(turns()));
    const vertex = mesh.getVertexPosition(1, new THREE.Vector3());
    expect(vertex.x).toBeCloseTo(.5); expect(vertex.y).toBeCloseTo(1.5); expect(vertex.z).toBeCloseTo(0);
    expect(mesh.frustumCulled).toBe(false); expect(mesh.boundingSphere).toBeNull();
    instance.dispose();
  });
  it('restores missing tracks and all bind scale/rotation/translation when a gesture stops', () => {
    const instance = createDirectXInstance(skinned(), { jointName }), joint = instance.joints.get('back')!;
    instance.applyPose(pose(turns(), new THREE.Vector3(.2, .3, .4)));
    expect(joint.group.position.toArray()).toEqual([.2, 1.3, .4]);
    joint.group.scale.set(3, 3, 3); instance.applyPose(new Map());
    expect(joint.group.position.toArray()).toEqual([0, 1, 0]); expect(joint.group.quaternion.toArray()).toEqual([0, 0, 0, 1]); expect(joint.group.scale.toArray()).toEqual([1, 1, 1]);
    instance.dispose();
  });
  it('never shares skeletons, bones, materials or geometry between avatars from one CPU template', () => {
    const source = skinned(), first = createDirectXInstance(source, { jointName }), second = createDirectXInstance(source, { jointName });
    const a = firstMesh(first.root) as THREE.SkinnedMesh, b = firstMesh(second.root) as THREE.SkinnedMesh;
    expect(a.skeleton).not.toBe(b.skeleton); expect(a.skeleton.bones[0]).not.toBe(b.skeleton.bones[0]); expect(a.geometry).not.toBe(b.geometry); expect(a.material).not.toBe(b.material);
    first.applyPose(pose(turns()));
    expect(second.joints.get('back')!.group.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
    first.dispose(); expect(b.getVertexPosition(1, new THREE.Vector3()).toArray()).toEqual([1, 1, 0]); second.dispose();
  });
  it('converts geometry, local frame translations and skin offsets consistently when an explicit unit scale is provided', () => {
    const instance = createDirectXInstance(skinned(), { jointName, units: 2 }), mesh = firstMesh(instance.root) as THREE.SkinnedMesh;
    expect(mesh.getVertexPosition(1, new THREE.Vector3()).toArray()).toEqual([2, 2, 0]);
    expect(mesh.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([2, 0, 0]);
    instance.applyPose(pose(turns(), new THREE.Vector3(0, 1, 0)));
    const vertex = mesh.getVertexPosition(1, new THREE.Vector3());
    expect(vertex.x).toBeCloseTo(1); expect(vertex.y).toBeCloseTo(3.5); // SEQ translation is already metres.
    instance.dispose();
  });
  it('preserves skin weights through material/normal face-corner expansion', () => {
    const source = skinned(); source.meshes[0].faces.push([2, 1, 0]); source.meshes[0].materialIndices.push(0);
    source.meshes[0].skinWeights[0].weights = [1, .25, .75]; source.meshes[0].skinWeights[1].weights = [0, .75, .25];
    const instance = createDirectXInstance(source), mesh = firstMesh(instance.root);
    expect(Array.from(mesh.geometry.getAttribute('skinWeight').array)).toEqual([1, 0, 0, 0, .25, .75, 0, 0, .75, .25, 0, 0, .75, .25, 0, 0, .25, .75, 0, 0, 1, 0, 0, 0]);
    instance.dispose();
  });
  it('does not claim unused sibling joints animate static geometry', () => {
    const source = model(); source.frames = [{ id: 0, parent: null, name: 'pelvis', matrix: identity() }];
    const instance = createDirectXInstance(source, { jointName });
    expect(instance.joints.size).toBe(0); expect(instance.warnings.some(warning => /affecting visible geometry/.test(warning))).toBe(true);
    instance.dispose();
  });
  it('retains mapped ancestors of positively weighted descendant bones, but excludes unused vertex influences', () => {
    const source = skinned(); source.frames.push({ id: 2, name: 'unused', parent: null, matrix: identity() });
    source.meshes[0].positions.push(8, 8, 8); source.meshes[0].uvs!.push(0, 0);
    source.meshes[0].skinWeights.push({ bone: 'unused', indices: [3], weights: [1], offsetMatrix: identity() });
    const instance = createDirectXInstance(source, { jointName });
    expect([...instance.joints.keys()]).toEqual(['pelvis', 'back']); instance.dispose();
  });
});

describe('DirectX resource ownership and hostile DTO validation', () => {
  it('disposes each skeleton bone texture, geometry and material once, never the shared material texture', async () => {
    const texture = new THREE.Texture(), source = skinned(); source.meshes[0].materials[0].texture = 'original.png';
    const textureDispose = vi.spyOn(texture, 'dispose'), instance = createDirectXInstance(source, { loadTexture: async () => texture });
    await tick(); const mesh = firstMesh(instance.root) as THREE.SkinnedMesh; mesh.skeleton.computeBoneTexture();
    const boneDispose = vi.spyOn(mesh.skeleton.boneTexture!, 'dispose'), geometryDispose = vi.spyOn(mesh.geometry, 'dispose'), materialDispose = vi.spyOn((mesh.material as THREE.Material[])[0], 'dispose');
    instance.dispose(); instance.dispose(); disposeDirectXTree(instance.root);
    expect(boneDispose).toHaveBeenCalledTimes(1); expect(geometryDispose).toHaveBeenCalledTimes(1); expect(materialDispose).toHaveBeenCalledTimes(1); expect(textureDispose).not.toHaveBeenCalled(); texture.dispose();
  });
  it('suppresses obsolete queued or late texture attachment and preserves a user texture override', async () => {
    const source = model(); source.meshes[0].materials[0].texture = 'original.png';
    let resolve!: (value: THREE.Texture) => void;
    const fetch = vi.fn(() => new Promise<THREE.Texture>(yes => { resolve = yes; })), onTexture = vi.fn();
    const canceled = createDirectXInstance(source, { loadTexture: fetch, onTexture }); canceled.dispose(); await tick(); expect(fetch).not.toHaveBeenCalled();
    const late = createDirectXInstance(source, { loadTexture: fetch, onTexture }); await tick(); late.dispose(); const texture = new THREE.Texture(); resolve(texture); await tick(); expect(onTexture).not.toHaveBeenCalled();
    const overridden = createDirectXInstance(source, { loadTexture: async () => texture, onTexture });
    const material = (firstMesh(overridden.root).material as THREE.MeshPhongMaterial[])[0]; material.userData.textureOverride = true;
    await tick(); expect(material.map).toBeNull(); overridden.dispose(); texture.dispose();
  });
  it.each(['https://remote.example/image.png', '../image.png', 'folder/image.png', 'C:\\export\\image.png'])('does not fetch unsafe TextureFilename %s', async name => {
    const source = model(); source.meshes[0].materials[0].texture = name;
    const loadTexture = vi.fn(), instance = createDirectXInstance(source, { loadTexture });
    await tick(); expect(loadTexture).not.toHaveBeenCalled(); expect(instance.warnings.some(warning => /plain object-path filename/.test(warning))).toBe(true); instance.dispose();
  });
  it('does not allocate or fetch unused material slots', async () => {
    const source = model(); source.meshes[0].materials[0].texture = 'visible.png'; source.meshes[0].materials.push({ ...material(), texture: 'unused.png' });
    source.meshes[0].faces.push([0, 0, 1]); source.meshes[0].materialIndices.push(1); // A degenerate face does not make its slot visible.
    const texture = new THREE.Texture(), loadTexture = vi.fn(async (_name: string) => texture), instance = createDirectXInstance(source, { loadTexture });
    await tick(); expect(loadTexture.mock.calls.map(([name]) => name)).toEqual(['visible.png']); expect(firstMesh(instance.root).material).toHaveLength(1); instance.dispose(); texture.dispose();
  });
  it('caps unique model image identities before queuing requests, while repeated images still share the cache', async () => {
    const source = model(), data = source.meshes[0];
    data.materials = Array.from({ length: 18 }, (_, index) => ({ ...material(), texture: `original-${index === 17 ? 0 : index}.png` }));
    data.faces = data.materials.map(() => [0, 1, 2]); data.materialIndices = data.materials.map((_, index) => index);
    const texture = new THREE.Texture(), loadTexture = vi.fn(async (_name: string) => texture), instance = createDirectXInstance(source, { loadTexture });
    await tick(); expect(new Set(loadTexture.mock.calls.map(([name]) => name)).size).toBe(16); expect(loadTexture).toHaveBeenCalledTimes(17);
    expect(instance.warnings.some(warning => /16-texture limit/.test(warning))).toBe(true); instance.dispose(); texture.dispose();
  });
  it('rejects a fifth positive influence without silently dropping authored skin weights', () => {
    const source = skinned();
    source.frames = Array.from({ length: 5 }, (_, index) => ({ id: index, parent: null, name: `bone${index}`, matrix: identity() }));
    source.meshes[0].frame = null;
    source.meshes[0].skinWeights = source.frames.map(frame => ({ bone: frame.name, indices: [0, 1, 2], weights: [.2, .2, .2], offsetMatrix: identity() }));
    expect(() => createDirectXInstance(source)).toThrow(/four supported skin influences/);
  });
  it.each(['ancestor', 'offset', 'reflection', 'shear'])('rejects unsupported internal skin %s transforms instead of incorrect normal lighting', kind => {
    const source = skinned();
    if (kind === 'ancestor') { source.frames[0].matrix[0] = 2; source.meshes[0].skinWeights[0].offsetMatrix[0] = .5; }
    if (kind === 'offset') source.meshes[0].skinWeights[0].offsetMatrix[0] = .5;
    if (kind === 'reflection') source.frames[0].matrix[0] = -1;
    if (kind === 'shear') source.frames[0].matrix[4] = .5;
    expect(() => createDirectXInstance(source)).toThrow(/uniform scale/);
  });
  it.each([
    ['invalid index', (source: DirectXModel) => { source.meshes[0].faces[0][0] = 99; }],
    ['nonfinite position', (source: DirectXModel) => { source.meshes[0].positions[0] = Infinity; }],
    ['sparse position', (source: DirectXModel) => { delete source.meshes[0].positions[0]; }],
    ['invalid weights', (source: DirectXModel) => { source.meshes[0].skinWeights[0].weights[0] = .9; }],
    ['missing bone', (source: DirectXModel) => { source.meshes[0].skinWeights[0].bone = 'absent'; }],
    ['duplicate bone name', (source: DirectXModel) => { source.frames[1].name = 'pelvis'; }],
    ['cycle', (source: DirectXModel) => { source.frames[0].parent = 1; }],
    ['singular bind matrix', (source: DirectXModel) => { source.frames[0].matrix[0] = 0; }],
    ['duplicate mapped joint', (source: DirectXModel) => { source.frames.push({ id: 2, parent: null, name: 'back', matrix: identity() }); }],
    ['invalid normal', (source: DirectXModel) => { source.meshes[0].normals = [0, 0, 0]; source.meshes[0].normalFaces = [[0, 0, 0]]; }],
  ])('rejects %s without returning a partial scene', (_name, mutate) => {
    const source = skinned(); mutate(source); expect(() => createDirectXInstance(source, { jointName })).toThrow();
  });
  it('rejects sheared animated joints and over-budget output before requesting any textures', () => {
    const source = skinned(); source.frames[1].matrix[4] = .4;
    expect(() => createDirectXInstance(source, { jointName })).toThrow('sheared');
    const larger = model(); larger.meshes[0].faces.push([0, 1, 2]); larger.meshes[0].materialIndices.push(0); larger.meshes[0].materials[0].texture = 'not-fetched.png'; const loadTexture = vi.fn();
    expect(() => createDirectXInstance(larger, { maxVertices: 3, loadTexture })).toThrow('vertex budget'); expect(loadTexture).not.toHaveBeenCalled();
  });
});
