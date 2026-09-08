import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { RwxModel } from "./rwx";

/** PRELIGHT is initial illumination, not an albedo multiplier. The additive term
 * is tinted by the same base color / decoded texture as reflected light. Numeric
 * RGB coefficients enter the existing linear-light pipeline without an extra sRGB
 * conversion. Historical AW Surface coefficients, clamping and gamma are not
 * reproduced by Three's physically based material/tone mapping.
 * https://web.archive.org/web/20250506084923/https://wiki.activeworlds.com/index.php?title=Vertex
 * https://www.activeworlds.com/newsletter/1201/1206.html
 */
export class RwxPrelightMaterial extends THREE.MeshStandardMaterial {
  ambientOnly = false;
  constructor(parameters: THREE.MeshStandardMaterialParameters = {}, ambientOnly = false) {
    super(parameters); this.ambientOnly = ambientOnly;
  }
  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 rwxPrelight;\nvarying vec3 vRwxPrelight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRwxPrelight = rwxPrelight;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRwxPrelight;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vRwxPrelight;');
    if (this.ambientOnly) shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>',
      '#include <aomap_fragment>\nreflectedLight.directDiffuse = vec3(0.0);\nreflectedLight.directSpecular = vec3(0.0);\nreflectedLight.indirectSpecular = vec3(0.0);');
  }
  override customProgramCacheKey() { return `wayfarer-rwx-prelight-v1-${this.ambientOnly ? 'ambient' : 'lit'}`; }
  override copy(source: THREE.MeshStandardMaterial) {
    super.copy(source); this.ambientOnly = source instanceof RwxPrelightMaterial && source.ambientOnly; return this;
  }
}

export interface RwxMeshOptions {
  wireframe?: boolean;
  loadTexture?: (name: string) => Promise<THREE.Texture>;
  isActive?: () => boolean;
  onTexture?: () => void;
  onTextureError?: (name: string, error: unknown) => void;
}

/** Shared geometry/material construction for the world and the model browser.
 * Texture ownership stays with the caller's cache/session. */
export function createRwxGroup(model: RwxModel, options: RwxMeshOptions = {}): THREE.Group {
  const group = new THREE.Group();
  for (const part of model.parts) {
    if (!part.positions.length) continue;
    let geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(part.positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(part.uvs, 2));
    if (part.prelight) {
      if (part.prelight.length !== part.positions.length || part.prelight.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
        geometry.dispose(); disposeModelTree(group); throw new Error('Invalid RWX PRELIGHT attribute: expected one finite RGB triple per vertex');
      }
      geometry.setAttribute("rwxPrelight", new THREE.Float32BufferAttribute(part.prelight, 3));
    }
    if (part.material.smooth) {
      const smooth = mergeVertices(geometry); geometry.dispose(); geometry = smooth;
    }
    geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    const parameters = {
      color: new THREE.Color().setRGB(...part.material.color),
      opacity: part.material.opacity, transparent: part.material.opacity < 1,
      side: part.material.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      wireframe: options.wireframe ?? false,
    };
    const material = part.prelight
      ? new RwxPrelightMaterial({ ...parameters, roughness: part.material.roughness }, part.material.unlit)
      : part.material.unlit
      ? new THREE.MeshBasicMaterial(parameters)
      : new THREE.MeshStandardMaterial({ ...parameters, roughness: part.material.roughness });
    const attach = (name: string, mask: boolean) => {
      if (!options.loadTexture) return;
      Promise.resolve().then(() => {
        if (options.isActive?.() === false || material.userData.disposed) return undefined;
        return options.loadTexture!(name);
      }).then(texture => {
        if (!texture) return;
        if (options.isActive?.() === false || material.userData.disposed) return;
        if (mask) { material.alphaMap = texture; material.alphaTest = 0.1; material.transparent = true; }
        else if (!material.userData.textureOverride) material.map = texture;
        material.needsUpdate = true;
        options.onTexture?.();
      }).catch(error => {
        if (options.isActive?.() !== false && !material.userData.disposed) options.onTextureError?.(name, error);
      });
    };
    if (part.material.texture) attach(part.material.texture, false);
    if (part.material.mask) attach(part.material.mask, true);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.tag = part.tag; mesh.userData.solid = part.solid;
    group.add(mesh);
  }
  group.userData.rwxWarnings = [...model.warnings];
  return group;
}

/** Dispose per-model geometry/materials and optional exclusively-owned textures. */
export function disposeModelTree(root: THREE.Object3D, ownTextures = false) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse(node => {
    if (!(node instanceof THREE.Mesh || node instanceof THREE.LineSegments || node instanceof THREE.Sprite)) return;
    if ("geometry" in node) geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(material);
      if (ownTextures) for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => { material.userData.disposed = true; material.dispose(); });
  textures.forEach(texture => {
    texture.dispose();
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) texture.image.close();
  });
}
