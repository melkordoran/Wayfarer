import * as THREE from 'three';
import type { WorldSettings } from '../../shared/types';
import type { AssetFetcher } from './assets';
import { EnvironmentAssetSession, type EnvironmentAssetKind } from './environment-assets';
import { SkyGradient } from './sky-gradient';

interface Entry { key: string; session: EnvironmentAssetSession; root?: THREE.Group; radius?: number }
interface Lighting { ambient: THREE.AmbientLight; hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight }

/** Owns authored environment models separately from property objects. In particular,
 * the sky has its own camera/pass: authored model size never affects world depth. */
export class EnvironmentScene {
  private entries = new Map<EnvironmentAssetKind, Entry>();
  private warnings = new Set<string>();
  private background = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera();
  private ambient = new THREE.AmbientLight();
  private hemi = new THREE.HemisphereLight();
  private sun = new THREE.DirectionalLight();
  private gradient = new SkyGradient();
  private active = true;

  constructor(private scene: THREE.Scene, private fetcher: AssetFetcher,
    private changed: () => void, private warning: (message: string) => void) {
    this.background.add(this.ambient, this.hemi, this.sun, this.sun.target, this.gradient.mesh);
  }

  update(settings: WorldSettings) {
    if (!this.active) return;
    for (const kind of ['skybox', 'ground'] as const) {
      const model = typeof settings[kind] === 'string' ? settings[kind].trim() : '';
      const key = `${settings.objectPath}\n${model}`;
      const old = this.entries.get(kind);
      if (old?.key === key) continue;
      if (old) { old.session.dispose(); this.entries.delete(kind); this.changed(); }
      if (!model) continue;
      try {
        const session = new EnvironmentAssetSession(this.fetcher, settings.objectPath, kind, warnings => {
          if (this.entries.get(kind)?.session === session) warnings.forEach(message => this.warn(message));
        });
        const entry: Entry = { key, session };
        this.entries.set(kind, entry);
        session.load(model).then(asset => {
          if (!this.active || this.entries.get(kind) !== entry) { session.dispose(); return; }
          entry.root = asset.root;
          entry.radius = Math.max(1, asset.bounds.min.length(), asset.bounds.max.length());
          (kind === 'skybox' ? this.background : this.scene).add(asset.root);
          asset.root.updateMatrixWorld(true);
          asset.warnings.forEach(message => this.warn(message)); this.changed();
        }).catch(error => {
          if (this.active && this.entries.get(kind) === entry) this.warn(`${kind === 'skybox' ? 'Skybox' : 'Ground'} unavailable: ${error instanceof Error ? error.message : 'Could not load model.'}`);
        });
      } catch (error) { this.warn(`${kind === 'skybox' ? 'Skybox' : 'Ground'} unavailable: ${error instanceof Error ? error.message : 'Invalid object path.'}`); }
    }
    if (settings.ground && settings.repeatingGround) this.warn('Repeating ground placement is not yet supported; the authored RWX ground is rendered once at its world origin.');
    if (settings.backdrop) this.warn('Legacy backdrop panoramas are not yet rendered; the world sky color or authored RWX skybox remains visible.');
  }

  private warn(message: string) {
    if (this.warnings.has(message) || this.warnings.size >= 16) return;
    this.warnings.add(message); this.warning(message);
  }

  collisionMeshes(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    this.entries.get('ground')?.root?.traverse(node => {
      if (node instanceof THREE.Mesh && node.userData.solid !== false) meshes.push(node);
    });
    return meshes;
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, lights: Lighting) {
    const skybox = this.entries.get('skybox');
    const skyColors = this.scene.userData.authoredSkyColors;
    if (!skybox?.root && !skyColors) { renderer.render(this.scene, camera); return; }
    this.camera.fov = camera.fov; this.camera.aspect = camera.aspect;
    this.camera.near = 0.001; this.camera.far = (skybox?.radius ?? 1) * 2;
    this.camera.quaternion.copy(camera.quaternion); this.camera.updateProjectionMatrix();
    this.gradient.update(skyColors, this.camera);
    this.background.background = this.scene.background;
    this.ambient.color.copy(lights.ambient.color); this.ambient.intensity = lights.ambient.intensity;
    this.hemi.color.copy(lights.hemi.color); this.hemi.groundColor.copy(lights.hemi.groundColor); this.hemi.intensity = lights.hemi.intensity;
    this.sun.color.copy(lights.sun.color); this.sun.intensity = lights.sun.intensity;
    this.sun.position.copy(lights.sun.position).sub(lights.sun.target.position);
    const autoClear = renderer.autoClear, background = this.scene.background;
    try {
      renderer.autoClear = true; renderer.render(this.background, this.camera);
      renderer.autoClear = false; this.scene.background = null;
      renderer.clearDepth(); renderer.render(this.scene, camera);
    } finally { renderer.autoClear = autoClear; this.scene.background = background; }
  }

  reset() {
    for (const entry of this.entries.values()) entry.session.dispose();
    this.entries.clear(); this.warnings.clear(); this.changed();
  }
  dispose() { if (this.active) { this.active = false; this.reset(); this.gradient.dispose(); this.background.clear(); } }
}
