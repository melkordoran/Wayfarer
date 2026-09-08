import * as THREE from 'three';
import type { DirectXMesh, DirectXModel } from './directx';
import type { JointPose } from './avatar-assets';
import type { RwxMeshOptions } from './rwx-mesh';

export const DIRECTX_MESH_LIMITS = Object.freeze({ vertices: 1_000_000, meshes: 4096, frames: 1024, bones: 256, faceCorners: 4096, textures: 16 });
export interface DirectXMeshOptions extends RwxMeshOptions {
  /** AW's documented exporter preset is right-handed, +Y up. No generic LH reflection. */
  units?: number;
  jointName?: (frameName: string) => string | undefined;
  maxVertices?: number;
  maxMeshes?: number;
}
export interface DirectXJoint {
  name: string;
  group: THREE.Object3D;
  bindPosition: THREE.Vector3;
  bindRotation: THREE.Quaternion;
  bindScale: THREE.Vector3;
}
export interface DirectXInstance {
  format: 'x';
  root: THREE.Group;
  joints: Map<string, DirectXJoint>;
  warnings: string[];
  applyPose(pose: Map<string, JointPose>): void;
  dispose(): void;
}

function finiteArray(values: readonly number[], size: number, label: string, maximum = 21_474_836.47) {
  if (!Array.isArray(values) || values.length !== size) throw new Error(`Invalid DirectX ${label} length`);
  for (const value of values) if (!Number.isFinite(value) || Math.abs(value) > maximum) throw new Error(`Invalid DirectX ${label} value`);
}
function matrix(values: number[], units: number, label: string) {
  finiteArray(values, 16, label);
  // X's row-vector serialization has translation at 12..14. Reading this array
  // as Three's column-major matrix performs the required row/column transpose.
  const result = new THREE.Matrix4().fromArray(values);
  if (Math.abs(values[3]) > 1e-7 || Math.abs(values[7]) > 1e-7 || Math.abs(values[11]) > 1e-7 || Math.abs(values[15] - 1) > 1e-7 || Math.abs(result.determinant()) < 1e-12)
    throw new Error(`DirectX ${label} must be nonsingular and affine`);
  result.elements[12] *= units; result.elements[13] *= units; result.elements[14] *= units;
  return result;
}
function matrixClose(a: THREE.Matrix4, b: THREE.Matrix4) {
  return a.elements.every((value, index) => Math.abs(value - b.elements[index]) <= 1e-5 * Math.max(1, Math.abs(value), Math.abs(b.elements[index])));
}
function conformalSkinMatrix(value: THREE.Matrix4) {
  const x = new THREE.Vector3().setFromMatrixColumn(value, 0), y = new THREE.Vector3().setFromMatrixColumn(value, 1), z = new THREE.Vector3().setFromMatrixColumn(value, 2);
  const size = Math.max(x.lengthSq(), y.lengthSq(), z.lengthSq());
  return value.determinant() > 0 && size > 1e-16 &&
    Math.abs(x.lengthSq() - y.lengthSq()) <= size * 1e-5 && Math.abs(x.lengthSq() - z.lengthSq()) <= size * 1e-5 &&
    Math.abs(x.dot(y)) <= size * 1e-5 && Math.abs(x.dot(z)) <= size * 1e-5 && Math.abs(y.dot(z)) <= size * 1e-5;
}

/** Triangulate in a dominant-axis projection while preserving original 3D winding.
 * Returned indices address face corners, not positions: split normal/UV/skin
 * attributes therefore remain associated through concave polygon triangulation. */
export function triangulateDirectXFace(face: number[], positions: number[]): number[][] {
  if (face.length < 3 || face.length > DIRECTX_MESH_LIMITS.faceCorners) throw new Error('DirectX face exceeds corner budget');
  const points = face.map(index => {
    if (!Number.isSafeInteger(index) || index < 0 || index * 3 + 2 >= positions.length) throw new Error('Invalid DirectX face index');
    return new THREE.Vector3().fromArray(positions, index * 3);
  });
  const normal = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    normal.x += (a.y - b.y) * (a.z + b.z); normal.y += (a.z - b.z) * (a.x + b.x); normal.z += (a.x - b.x) * (a.y + b.y);
  }
  if (normal.lengthSq() < 1e-20) return [];
  const dimensions = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)], axis = dimensions.indexOf(Math.max(...dimensions));
  const contour = points.map(p => axis === 0 ? new THREE.Vector2(p.y, p.z) : axis === 1 ? new THREE.Vector2(p.x, p.z) : new THREE.Vector2(p.x, p.y));
  const triangles = face.length === 3 ? [[0, 1, 2]] : THREE.ShapeUtils.triangulateShape(contour, []);
  if (triangles.length !== face.length - 2) throw new Error('DirectX polygon could not be triangulated safely');
  for (const triangle of triangles) {
    const [a, b, c] = triangle.map(index => points[index]);
    if (new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).dot(normal) < 0) [triangle[1], triangle[2]] = [triangle[2], triangle[1]];
  }
  return triangles;
}

/** Release per-instance GPU resources, including skeleton bone textures. Textures
 * on materials remain owned by the caller's world cache or preview session. */
export function disposeDirectXTree(root: THREE.Object3D) {
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse(node => {
    if (node.userData.directXInstance) node.userData.directXDisposed = true;
    if (node instanceof THREE.SkinnedMesh) skeletons.add(node.skeleton);
  });
  for (const skeleton of skeletons) {
    if (!skeleton || (skeleton as THREE.Skeleton & { wayfarerDisposed?: boolean }).wayfarerDisposed) continue;
    (skeleton as THREE.Skeleton & { wayfarerDisposed?: boolean }).wayfarerDisposed = true; skeleton.dispose();
  }
}

/** Source coordinates are retained; the initial AW policy assumes one X unit is
 * one metre (not RWX's ten metres). This unit assumption and modern Phong/color
 * rendering are not a claim of pixel-exact historical ActiveWorlds behavior. */
export function createDirectXInstance(model: DirectXModel, options: DirectXMeshOptions = {}): DirectXInstance {
  const root = new THREE.Group(), joints = new Map<string, DirectXJoint>();
  root.userData.directXInstance = true;
  const warnings = new Set(model.warnings), frames = new Map<number, THREE.Bone>(), frameNames = new Map<string, THREE.Bone[]>();
  const affectingFrames = new Set<THREE.Object3D>();
  const affectAncestors = (node: THREE.Object3D) => {
    for (let current: THREE.Object3D | null = node; current && current !== root; current = current.parent) affectingFrames.add(current);
  };
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  const textureNames = new Set<string>();
  let active = true, vertexCount = 0, sourceVertices = 0, normalCount = 0, faceCount = 0, cornerCount = 0, materialCount = 0;
  const units = options.units ?? 1;
  const maxVertices = Math.min(options.maxVertices ?? DIRECTX_MESH_LIMITS.vertices, DIRECTX_MESH_LIMITS.vertices);
  const maxMeshes = Math.min(options.maxMeshes ?? DIRECTX_MESH_LIMITS.meshes, DIRECTX_MESH_LIMITS.meshes);
  const isActive = () => active && !root.userData.directXDisposed && options.isActive?.() !== false;
  const dispose = () => {
    if (!active || root.userData.directXDisposed) return; active = false; root.removeFromParent(); disposeDirectXTree(root);
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => { material.userData.disposed = true; material.dispose(); });
  };
  try {
    if (!Number.isFinite(units) || units <= 0 || units > 1000 || !Number.isSafeInteger(maxVertices) || maxVertices < 3 || !Number.isSafeInteger(maxMeshes) || maxMeshes < 1)
      throw new Error('Invalid DirectX mesh limits or units');
    if (model.frames.length > DIRECTX_MESH_LIMITS.frames || model.meshes.length > maxMeshes) throw new Error('DirectX model exceeds frame/mesh budget');
    warnings.add('DirectX geometry uses one source unit per metre; legacy AW scale parity is not yet verified.');
    if (model.hasEmbeddedAnimation) warnings.add('Embedded DirectX AnimationSet playback is not supported; the authored reference pose is shown');
    const definitions = new Map(model.frames.map(frame => [frame.id, frame]));
    for (const frame of model.frames) {
      if (!Number.isSafeInteger(frame.id) || frame.id < 0 || frames.has(frame.id)) throw new Error('Duplicate or invalid DirectX frame ID');
      const node = new THREE.Bone(); node.name = frame.name; frames.set(frame.id, node);
      const named = frameNames.get(frame.name) ?? []; named.push(node); frameNames.set(frame.name, named);
      const bind = matrix(frame.matrix, units, 'frame matrix');
      bind.decompose(node.position, node.quaternion, node.scale);
      const recomposed = new THREE.Matrix4().compose(node.position, node.quaternion, node.scale);
      const jointName = options.jointName?.(frame.name);
      if (!matrixClose(bind, recomposed)) {
        if (jointName) throw new Error(`DirectX animated joint has a sheared bind transform: ${frame.name}`);
        node.matrixAutoUpdate = false; node.matrix.copy(bind);
      }
      if (jointName) {
        if (joints.has(jointName)) throw new Error(`Duplicate DirectX animation joint: ${jointName}`);
        joints.set(jointName, { name: jointName, group: node, bindPosition: node.position.clone(), bindRotation: node.quaternion.clone(), bindScale: node.scale.clone() });
      }
    }
    for (const frame of model.frames) {
      let parent = frame.parent, depth = 0;
      const seen = new Set([frame.id]);
      while (parent !== null) {
        if (seen.has(parent) || ++depth > 128) throw new Error('Cyclic or excessively deep DirectX frame hierarchy');
        seen.add(parent); const definition = definitions.get(parent);
        if (!definition) throw new Error('Missing DirectX parent frame'); parent = definition.parent;
      }
      (frame.parent === null ? root : frames.get(frame.parent)!).add(frames.get(frame.id)!);
    }
    root.updateMatrixWorld(true);
    for (const source of model.meshes) {
      const count = source.positions.length / 3;
      if (!Number.isSafeInteger(count) || count > 250_000) throw new Error('DirectX mesh exceeds source vertex budget');
      sourceVertices += count; normalCount += (source.normals?.length ?? 0) / 3; faceCount += source.faces.length; materialCount += source.materials.length;
      if (sourceVertices > 250_000 || normalCount > 500_000 || faceCount > 250_000 || materialCount > 4096) throw new Error('DirectX model exceeds aggregate geometry budget');
      finiteArray(source.positions, count * 3, 'positions');
      if (source.uvs) finiteArray(source.uvs, count * 2, 'UVs');
      if (source.colors) { finiteArray(source.colors, count * 4, 'vertex colors', 1); if (source.colors.some(value => value < 0)) throw new Error('Invalid DirectX vertex color'); }
      if (source.normals) finiteArray(source.normals, source.normals.length, 'normals');
      if (source.normals && (!source.normalFaces || source.normalFaces.length !== source.faces.length || source.normals.length % 3)) throw new Error('DirectX normal faces do not match geometry');
      if (source.materials.length < 1 || source.materials.length > 4096 || source.materialIndices.length !== source.faces.length) throw new Error('Invalid DirectX material assignments');
      if (source.frame !== null && !frames.has(source.frame)) throw new Error('Missing DirectX mesh frame');
      const parent = source.frame === null ? root : frames.get(source.frame)!;
      const skin = skinData(source, count, frameNames, units);
      const renderedBones = new Set<number>();
      const geometry = new THREE.BufferGeometry(); geometries.add(geometry);
      const positions: number[] = [], normals: number[] = [], uvs: number[] = [], colors: number[] = [], indices: number[] = [], weights: number[] = [];
      const buckets = new Map<number, Array<[number, number]>>();
      for (let faceIndex = 0; faceIndex < source.faces.length; faceIndex++) {
        const material = source.materialIndices[faceIndex];
        if (!Number.isSafeInteger(material) || material < 0 || material >= source.materials.length) throw new Error('Invalid DirectX face material index');
        const face = source.faces[faceIndex], normalFace = source.normalFaces?.[faceIndex];
        cornerCount += face.length + (normalFace?.length ?? 0);
        if (cornerCount > 1_000_000) throw new Error('DirectX model exceeds face corner budget');
        if (source.normals && (!normalFace || normalFace.length !== face.length)) throw new Error('Invalid DirectX normal face');
        const triangles = triangulateDirectXFace(face, source.positions);
        vertexCount += triangles.length * 3;
        if (vertexCount > maxVertices) throw new Error('DirectX model exceeds rendered vertex budget');
        if (!triangles.length) continue;
        const bucket = buckets.get(material) ?? []; buckets.set(material, bucket);
        for (const triangle of triangles) for (const corner of triangle) bucket.push([faceIndex, corner]);
      }
      for (const [material, bucket] of buckets) {
        geometry.addGroup(positions.length / 3, bucket.length, material);
        for (const [faceIndex, corner] of bucket) {
          const vertex = source.faces[faceIndex][corner];
          positions.push(source.positions[vertex * 3] * units, source.positions[vertex * 3 + 1] * units, source.positions[vertex * 3 + 2] * units);
          if (source.normals) {
            const normal = source.normalFaces![faceIndex][corner];
            if (!Number.isSafeInteger(normal) || normal < 0 || normal * 3 + 2 >= source.normals.length) throw new Error('Invalid DirectX normal index');
            const value = new THREE.Vector3().fromArray(source.normals, normal * 3);
            if (value.lengthSq() < 1e-20) throw new Error('DirectX normal has zero length');
            normals.push(...value.normalize().toArray());
          }
          // Authored X UVs use the image's top-left origin. Our shared decoded
          // images are already flipped into Three's bottom-left convention.
          uvs.push(source.uvs?.[vertex * 2] ?? 0, 1 - (source.uvs?.[vertex * 2 + 1] ?? 0));
          if (source.colors) colors.push(...source.colors.slice(vertex * 4, vertex * 4 + 4));
          if (skin) {
            indices.push(...skin.indices[vertex]); weights.push(...skin.weights[vertex]);
            skin.indices[vertex].forEach((bone, index) => { if (skin.weights[vertex][index] > 0) renderedBones.add(bone); });
          }
        }
      }
      if (!positions.length) { warnings.add(`DirectX mesh has no nondegenerate faces: ${source.name ?? '(unnamed)'}`); continue; }
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      if (normals.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); else geometry.computeVertexNormals();
      if (colors.length) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
      // Exporters may retain unused material slots. Only visible groups get GPU
      // materials or texture requests; renumber groups to this dense local list.
      const materialRemap = new Map<number, number>();
      const meshMaterials = [...buckets.keys()].map((sourceIndex, materialIndex) => {
        materialRemap.set(sourceIndex, materialIndex);
        const sourceMaterial = source.materials[sourceIndex];
        finiteArray(sourceMaterial.diffuse, 4, 'diffuse color', 1); finiteArray(sourceMaterial.specular, 3, 'specular color', 1); finiteArray(sourceMaterial.emissive, 3, 'emissive color', 1);
        if ([...sourceMaterial.diffuse, ...sourceMaterial.specular, ...sourceMaterial.emissive].some(value => value < 0) || !Number.isFinite(sourceMaterial.power) || sourceMaterial.power < 0 || sourceMaterial.power > 10000) throw new Error('Invalid DirectX material');
        const material = new THREE.MeshPhongMaterial({
          color: new THREE.Color().setRGB(...sourceMaterial.diffuse.slice(0, 3) as [number, number, number]),
          opacity: sourceMaterial.diffuse[3], transparent: sourceMaterial.diffuse[3] < 1 || !!source.colors?.some((value, index) => index % 4 === 3 && value < 1),
          specular: new THREE.Color().setRGB(...sourceMaterial.specular), emissive: new THREE.Color().setRGB(...sourceMaterial.emissive),
          shininess: sourceMaterial.power, vertexColors: colors.length > 0, wireframe: options.wireframe ?? false,
        });
        materials.add(material);
        if (sourceMaterial.texture && (!/^[a-z0-9][a-z0-9_. -]*$/i.test(sourceMaterial.texture) || sourceMaterial.texture.includes('..') || sourceMaterial.texture.endsWith('.') || sourceMaterial.texture.length > 255)) {
          warnings.add(`DirectX texture requires a plain object-path filename; not loaded: ${sourceMaterial.texture.slice(0, 100)}`);
        } else if (sourceMaterial.texture && !textureNames.has(sourceMaterial.texture) && textureNames.size >= DIRECTX_MESH_LIMITS.textures) {
          warnings.add('DirectX model exceeds the 16-texture limit; additional materials remain untextured');
        } else if (sourceMaterial.texture && options.loadTexture) {
          const name = sourceMaterial.texture;
          textureNames.add(name);
          Promise.resolve().then(() => isActive() && !material.userData.disposed ? options.loadTexture!(name) : undefined).then(texture => {
            if (!texture || !isActive() || material.userData.disposed) return;
            if (!material.userData.textureOverride) material.map = texture;
            material.needsUpdate = true; options.onTexture?.();
          }).catch(error => { if (isActive() && !material.userData.disposed) options.onTextureError?.(name, error); });
        }
        return material;
      });
      geometry.groups.forEach(group => { group.materialIndex = materialRemap.get(group.materialIndex!)!; });
      let mesh: THREE.Mesh;
      if (skin) {
        for (const bone of renderedBones) affectAncestors(skin.bones[bone]);
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
        const skinned = new THREE.SkinnedMesh(geometry, meshMaterials); mesh = skinned; parent.add(mesh); mesh.updateMatrixWorld(true);
        // Posed avatars bypass bind-pose frustum bounds; recomputing every vertex
        // twice each animation frame would turn skinning into expensive CPU work.
        if (options.jointName) skinned.frustumCulled = false;
        const inverseMesh = mesh.matrixWorld.clone().invert();
        const inverses = skin.offsets.map(offset => offset.clone().multiply(inverseMesh));
        const skeleton = new THREE.Skeleton(skin.bones, inverses);
        skinned.bind(skeleton, mesh.matrixWorld.clone());
        if (skin.bones.some((bone, index) => !matrixClose(bone.matrixWorld.clone().multiply(skin.offsets[index]), mesh.matrixWorld)))
          warnings.add('Some DirectX skin offsets differ from frame reference transforms; authored offset matrices are retained');
        skinned.computeBoundingBox(); skinned.computeBoundingSphere();
      } else { mesh = new THREE.Mesh(geometry, meshMaterials); parent.add(mesh); affectAncestors(parent); geometry.computeBoundingBox(); geometry.computeBoundingSphere(); }
      mesh.name = source.name ?? ''; mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.solid = true;
    }
    root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(root);
    if (bounds.isEmpty() || [...bounds.min.toArray(), ...bounds.max.toArray()].some(value => !Number.isFinite(value) || Math.abs(value) > 21_474_836.47)) throw new Error('DirectX model has no finite supported geometry');
    for (const [name, joint] of joints) if (!affectingFrames.has(joint.group)) joints.delete(name);
    if (options.jointName && !joints.size) warnings.add('DirectX avatar has no recognized SEQ joints affecting visible geometry and will remain static');
    root.userData.directXWarnings = [...warnings];
    return {
      format: 'x', root, joints, warnings: [...warnings], dispose,
      applyPose(pose) {
        if (!isActive()) return;
        for (const [name, joint] of joints) {
          joint.group.position.copy(joint.bindPosition); joint.group.quaternion.copy(joint.bindRotation); joint.group.scale.copy(joint.bindScale);
          const key = pose.get(name);
          if (key) { joint.group.quaternion.multiply(key.rotation); joint.group.position.add(key.translation); }
        }
        root.parent?.updateWorldMatrix(true, false); root.updateMatrixWorld(true);
        root.traverse(node => {
          if (node instanceof THREE.SkinnedMesh) {
            // Three's runtime lazily recreates null bounds; its declaration is
            // currently stricter than SkinnedMesh.js's supported null state.
            node.skeleton.update(); node.boundingBox = null!; node.boundingSphere = null!;
          }
        });
      },
    };
  } catch (error) { dispose(); throw error; }
}

function skinData(source: DirectXMesh, count: number, frames: Map<string, THREE.Bone[]>, units: number) {
  if (!source.skinWeights.length) return undefined;
  if (source.skinWeights.length > DIRECTX_MESH_LIMITS.bones) throw new Error('DirectX skin exceeds bone budget');
  const indices = Array.from({ length: count }, () => [] as number[]), weights = Array.from({ length: count }, () => [] as number[]);
  const bones: THREE.Bone[] = [], offsets: THREE.Matrix4[] = [], seen = new Set<string>();
  for (const block of source.skinWeights) {
    const matches = frames.get(block.bone);
    if (matches?.length !== 1 || seen.has(block.bone)) throw new Error(`Missing or ambiguous DirectX skin bone: ${block.bone}`);
    seen.add(block.bone); const bone = bones.length; bones.push(matches[0]); offsets.push(matrix(block.offsetMatrix, units, 'skin offset matrix'));
    // Three's stock linear-blend skin normal shader does not inverse-transpose
    // arbitrary internal scale/shear. Keep such static affine meshes supported,
    // but reject skins with nonuniform/sheared/reflected internal transforms.
    if (!conformalSkinMatrix(offsets[offsets.length - 1])) throw new Error('DirectX skin offsets require rotation and positive uniform scale; shear, nonuniform scale and reflections are unsupported');
    for (let node: THREE.Object3D | null = matches[0]; node?.parent; node = node.parent)
      if (!conformalSkinMatrix(node.matrix)) throw new Error('DirectX skinned bone ancestors require rotation and positive uniform scale; shear, nonuniform scale and reflections are unsupported');
    if (block.indices.length !== block.weights.length || block.indices.length > count) throw new Error('Invalid DirectX skin weight count');
    const vertices = new Set<number>();
    for (let index = 0; index < block.indices.length; index++) {
      const vertex = block.indices[index], weight = block.weights[index];
      if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= count || vertices.has(vertex) || !Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error('Invalid DirectX skin weight');
      vertices.add(vertex); if (weight === 0) continue;
      if (indices[vertex].length === 4) throw new Error('DirectX vertex exceeds four supported skin influences');
      indices[vertex].push(bone); weights[vertex].push(weight);
    }
  }
  for (let vertex = 0; vertex < count; vertex++) {
    const sum = weights[vertex].reduce((total, value) => total + value, 0);
    if (Math.abs(sum - 1) > 1e-4) throw new Error('DirectX skin weights must sum to one for every vertex');
    weights[vertex] = weights[vertex].map(value => value / sum);
    while (indices[vertex].length < 4) { indices[vertex].push(0); weights[vertex].push(0); }
  }
  return { bones, offsets, indices, weights };
}
