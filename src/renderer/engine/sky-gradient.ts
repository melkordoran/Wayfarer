import * as THREE from 'three';

export interface SkyColors { top: string; bottom: string; north: string; south: string; east: string; west: string }
const names = ['top', 'bottom', 'north', 'south', 'east', 'west'] as const;
export function validSkyColors(value: unknown): SkyColors | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (!names.every(name => typeof record[name] === 'string' && /^#[\da-f]{6}$/i.test(record[name] as string))) return;
  return Object.fromEntries(names.map(name => [name, record[name]])) as unknown as SkyColors;
}

/** Exact authored cardinal anchors, with Wayfarer's smooth squared-direction blend.
 * Historical AW's interpolation formula is not established; this is not a pixel-parity claim. */
export function sampleSkyGradient(colors: SkyColors, direction: THREE.Vector3): THREE.Color {
  const vector = direction.clone();
  if (vector.lengthSq() < 1e-12) vector.set(0, 1, 0);
  vector.normalize();
  return new THREE.Color(colors[vector.x >= 0 ? 'west' : 'east']).multiplyScalar(vector.x ** 2)
    .add(new THREE.Color(colors[vector.y >= 0 ? 'top' : 'bottom']).multiplyScalar(vector.y ** 2))
    .add(new THREE.Color(colors[vector.z >= 0 ? 'north' : 'south']).multiplyScalar(vector.z ** 2));
}

/** A fullscreen directional background, never geometry in the world/collision scene. */
export class SkyGradient {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  constructor() {
    const uniforms: Record<string, THREE.IUniform> = {
      inverseProjection: { value: new THREE.Matrix4() }, cameraRotation: { value: new THREE.Matrix3() },
    };
    for (const name of names) uniforms[name] = { value: new THREE.Color() };
    const material = new THREE.ShaderMaterial({
      uniforms, depthTest: false, depthWrite: false, toneMapped: false,
      vertexShader: `uniform mat4 inverseProjection; uniform mat3 cameraRotation; varying vec3 direction;
        void main() { direction = cameraRotation * (inverseProjection * vec4(position.xy, 1.0, 1.0)).xyz;
          gl_Position = vec4(position.xy, 1.0, 1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 north; uniform vec3 south; uniform vec3 east; uniform vec3 west;
        varying vec3 direction;
        void main() { vec3 ray = normalize(direction); vec3 weights = ray * ray;
          vec3 rgb = (ray.x >= 0.0 ? west : east) * weights.x + (ray.y >= 0.0 ? top : bottom) * weights.y + (ray.z >= 0.0 ? north : south) * weights.z;
          gl_FragColor = vec4(rgb, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = -10000; this.mesh.visible = false;
  }
  update(colors: SkyColors | undefined, camera: THREE.PerspectiveCamera) {
    this.mesh.visible = Boolean(colors);
    if (!colors) return;
    const uniforms = this.mesh.material.uniforms;
    for (const name of names) (uniforms[name].value as THREE.Color).set(colors[name]);
    camera.updateMatrixWorld(true);
    (uniforms.inverseProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (uniforms.cameraRotation.value as THREE.Matrix3).setFromMatrix4(camera.matrixWorld);
  }
  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
