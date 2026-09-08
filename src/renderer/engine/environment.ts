import * as THREE from 'three';
import type { Position, WorldSettings } from '../../shared/types';
import { validSkyColors } from './sky-gradient';

export type EnvironmentMode = 'world' | 'day' | 'sunset' | 'night';

const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
function color(value: unknown, fallback: string) {
  return new THREE.Color(typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : fallback);
}

export function terrainElevation(settings: WorldSettings | null): number {
  // The world terrain elevation attribute is already metres, unlike object wire positions.
  return finite(settings?.terrainOffset, 0);
}

export function flightAllowed(settings: WorldSettings | null): boolean {
  // The protocol derives effective canFly from authored AllowFlying and caretaker rights.
  return typeof settings?.canFly === 'boolean' ? settings.canFly : settings?.allowFlying !== false;
}

export function waterAppearance(settings: WorldSettings) {
  return {
    color: color(settings.waterColor, '#6dadae'),
    // The protocol normalizes AW's 0..255 byte to 0..1; zero remains meaningful.
    opacity: typeof settings.waterOpacity === 'number' && Number.isFinite(settings.waterOpacity)
      ? THREE.MathUtils.clamp(settings.waterOpacity, 0, 1) : 0.72,
    level: finite(settings.waterLevel, 0),
  };
}

export function applyWaterAppearance(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>, settings: WorldSettings) {
  const appearance = waterAppearance(settings), material = mesh.material;
  material.color.copy(appearance.color); material.opacity = appearance.opacity;
  const transparent = appearance.opacity < 1;
  if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
  material.depthWrite = !transparent;
  mesh.position.y = appearance.level; mesh.visible = settings.waterEnabled && appearance.opacity > 0;
  mesh.updateMatrixWorld(true);
}

interface Resources {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  renderer: { toneMappingExposure: number; shadowMap: { enabled: boolean } };
}

/** Applies authored values without owning scene resources. Presets affect lighting and sky,
 * never the world's fog enable/ranges, viewing distance, water or movement capabilities. */
export class EnvironmentController {
  private lightOffset = new THREE.Vector3(-38, 55, -40);
  constructor(private resources: Resources) {}

  apply(settings: WorldSettings | null, mode: EnvironmentMode, position: Position) {
    const { scene, camera, sun, ambient, hemi, renderer } = this.resources;
    const far = Math.max(camera.near + 1, finite(settings?.fogMax, 1200));
    const near = Math.max(0, Math.min(far - 0.01, finite(settings?.fogMin, 65)));
    // AW_WORLD_FOG_MAXIMUM also sets visibility when fog itself is disabled.
    camera.far = far; camera.updateProjectionMatrix();
    scene.fog = settings?.fogEnabled === false ? null : new THREE.Fog(color(settings?.fogColor, '#c8d6d1'), near, far);
    renderer.shadowMap.enabled = settings?.disableShadows !== true;
    sun.castShadow = renderer.shadowMap.enabled;
    scene.userData.authoredSkyColors = mode === 'world' ? validSkyColors(settings?.skyColors) : undefined;

    if (mode === 'world') {
      scene.background = color(settings?.skyColor, '#c8d6d1');
      ambient.color.copy(color(settings?.ambientColor, '#bfbfbf')); ambient.intensity = 1;
      hemi.intensity = 0;
      sun.color.copy(color(settings?.lightColor, '#ffffff')); sun.intensity = 1;
      const direction = settings?.lightDirection;
      if (direction && typeof direction === 'object' && 'x' in direction && 'y' in direction && 'z' in direction) {
        this.lightOffset.set(-finite(direction.x, 0), -finite(direction.y, 0), -finite(direction.z, 0));
        // A zero direction has no orientation: retain ambient light without inventing a sun.
        if (this.lightOffset.lengthSq() > 1e-12) this.lightOffset.normalize().multiplyScalar(85);
        else sun.intensity = 0;
      } else this.lightOffset.set(-38, 55, -40);
      renderer.toneMappingExposure = 1;
    } else {
      const preset = mode === 'night'
        ? { sky: '#172b3b', light: '#a8c8ef', ambient: '#728cab', intensity: 0.6, hemi: 0.7, exposure: 0.95 }
        : mode === 'sunset'
          ? { sky: '#c9a98d', light: '#ffc48b', ambient: '#b4c6d7', intensity: 3.2, hemi: 1.6, exposure: 1.08 }
          : { sky: '#c8d6d1', light: '#fff0cf', ambient: '#d5e7ef', intensity: 3, hemi: 2.1, exposure: 1.12 };
      scene.background = color(mode === 'day' ? settings?.skyColor : preset.sky, preset.sky);
      sun.color.copy(color(mode === 'day' ? settings?.lightColor : preset.light, preset.light)); sun.intensity = preset.intensity;
      hemi.color.copy(color(mode === 'day' ? settings?.ambientColor : preset.ambient, preset.ambient)); hemi.intensity = preset.hemi;
      ambient.color.set('#fff7e2'); ambient.intensity = 0.18;
      this.lightOffset.set(-38, mode === 'sunset' ? 22 : 55, -40);
      renderer.toneMappingExposure = preset.exposure;
    }
    this.follow(position);
  }

  follow(position: Position) {
    const { sun } = this.resources;
    // Move source and target together to retain world direction as the player travels.
    sun.target.position.set(position.x, position.y, position.z + 12);
    sun.position.copy(sun.target.position).add(this.lightOffset);
    sun.target.updateMatrixWorld(true); sun.updateMatrixWorld(true);
  }
}
