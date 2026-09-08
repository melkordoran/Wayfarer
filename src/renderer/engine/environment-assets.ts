import * as THREE from 'three';
import { assetUrl } from '../../shared/validation';
import { assetUrls, decodeModelAsset, unpackAsset, type AssetFetcher } from './assets';
import { parseRwx } from './rwx';
import { createRwxGroup, disposeModelTree } from './rwx-mesh';
import { PreviewWorkQueue } from './preview-work-queue';
import { parseDirectX } from './directx';
import { createDirectXInstance, type DirectXInstance } from './directx-mesh';

export type EnvironmentAssetKind = 'skybox' | 'ground';
export interface EnvironmentAsset {
  root: THREE.Group;
  /** Authored bounds in metres. Never recentered, resized or offset by this loader. */
  bounds: THREE.Box3;
  warnings: string[];
}
export const ENVIRONMENT_ASSET_LIMITS = Object.freeze({
  downloadBytes: 30_000_000,
  vertices: 500_000,
  parts: 2048,
  commands: 250_000,
  prototypeInvocations: 10_000,
  textures: 16,
  imageDimension: 4096,
  retainedPixels: 16_777_216,
  coordinate: 21_474_836.47,
  activeTasks: 2,
  waitingTasks: 32,
});

// Reuse the cancellation-aware bounded queue implementation, not the world's
// unbounded pending queue. Started transport requests keep their slot until they
// really settle (the bridge currently exposes no abort operation).
const environmentQueue = new PreviewWorkQueue(ENVIRONMENT_ASSET_LIMITS.activeTasks, ENVIRONMENT_ASSET_LIMITS.waitingTasks);

function basename(input: string, kind: 'model' | 'texture'): string {
  if (typeof input !== 'string' || input.length > 255 || /[\u0000-\u001f\u007f]/.test(input))
    throw new Error('Invalid environment asset name.');
  const name = input.trim();
  if (!/^[a-z0-9][a-z0-9_. -]*$/i.test(name) || name.includes('..') || name.endsWith('.'))
    throw new Error('Environment assets require a plain object-path filename, not a URL or directory.');
  const stem = name.replace(/\.(?:rwx|x|zip)$/i, '');
  if (kind === 'model' && /\.(?:awg|cob|cav|seq|bvh|png|jpe?g|bmp|gif)$/i.test(stem))
    throw new Error('Only RWX or supported DirectX environment models are supported; AWG groups and other formats are unavailable.');
  if (kind === 'texture' && /\.(?:rwx|awg|x|cob|cav|seq|bvh)$/i.test(name.replace(/\.zip$/i, '')))
    throw new Error('Choose an image for an environment texture.');
  return name;
}

/** A single source generation with exclusive geometry/material/texture ownership.
 * Construct a replacement session whenever world, path, kind or model changes,
 * and dispose the old one before attaching its replacement. This loader never
 * executes property actions, creates fallback scenery, or navigates a URL.
 *
 * Skybox provenance: https://www.activeworlds.com/newsletter/1001/1002.html
 * and https://www.activeworlds.com/newsletter/1001/1006.html describe a small or
 * large authored model centered on the viewer and rendered before the world.
 * Caller must use a separate background pass, not a depth-writing world mesh.
 * Supported RWX/DirectX ground is static. No repeating-grid/AWG semantics are invented.
 */
export class EnvironmentAssetSession {
  private active = true;
  private started = false;
  private root: THREE.Group | null = null;
  private directX: DirectXInstance | null = null;
  private cancellation = new AbortController();
  private textures = new Map<string, Promise<THREE.Texture>>();
  private ownedTextures = new Set<THREE.Texture>();
  private retainedPixels = 0;
  private warnings = new Set<string>();
  private readonly objectPath: string;

  constructor(private fetcher: AssetFetcher, objectPath: string, private kind: EnvironmentAssetKind,
    private onUpdate: (warnings: string[]) => void = () => {}) {
    if (kind !== 'skybox' && kind !== 'ground') throw new Error('Unsupported environment asset kind.');
    const path = assetUrl(objectPath);
    // A world object path is a directory, never an authenticated URL or query.
    if (path.search || path.hash) throw new Error('Environment object paths cannot include queries or fragments.');
    this.objectPath = path.href.replace(/\/?$/, '/');
  }

  async load(model: string): Promise<EnvironmentAsset> {
    if (!this.active || this.started) throw new Error('This environment asset session is no longer available.');
    this.started = true;
    try {
      const name = basename(model, 'model');
      const downloaded = await this.run(() => this.fetchAvailable(assetUrls(this.objectPath, name, 'models')));
      this.assertActive();
      const decoded = await decodeModelAsset(downloaded.bytes, name, downloaded.url);
      this.assertActive();
      const options = {
        isActive: () => this.active,
        loadTexture: (texture: string) => this.loadTexture(texture),
        onTexture: () => this.notify(),
        onTextureError: (texture: string, cause: unknown) => {
          if (!this.active) return;
          this.warnings.add(`Environment texture unavailable: ${texture}. ${cause instanceof Error ? cause.message : 'Could not load image.'}`);
          this.notify();
        },
      };
      if (decoded.format === 'x') {
        this.directX = createDirectXInstance(parseDirectX(decoded.source), { ...options, maxVertices: ENVIRONMENT_ASSET_LIMITS.vertices, maxMeshes: ENVIRONMENT_ASSET_LIMITS.parts });
        this.directX.warnings.forEach(warning => this.warnings.add(warning));
        this.root = this.directX.root;
      } else {
        const parsed = parseRwx(decoded.source, 10, {
          maxCommands: ENVIRONMENT_ASSET_LIMITS.commands,
          maxPrototypeExpansions: ENVIRONMENT_ASSET_LIMITS.prototypeInvocations,
        });
        // These are acceptance limits after parsing, not peak parser-memory limits.
        if (parsed.parts.length > ENVIRONMENT_ASSET_LIMITS.parts ||
          parsed.parts.reduce((count, part) => count + part.positions.length / 3, 0) > ENVIRONMENT_ASSET_LIMITS.vertices)
          throw new Error('Environment model exceeds the geometry budget.');
        if (parsed.parts.some(part => part.positions.some(value => !Number.isFinite(value) || Math.abs(value) > ENVIRONMENT_ASSET_LIMITS.coordinate)))
          throw new Error('Environment model has unsupported or non-finite coordinates.');
        parsed.warnings.forEach(warning => this.warnings.add(warning));
        this.root = createRwxGroup(parsed, options);
      }
      this.root.name = `${this.kind}: ${name}`;
      this.root.userData.environmentAsset = this.kind;
      if (this.kind === 'skybox') this.root.traverse(node => {
        if (!(node instanceof THREE.Mesh)) return;
        node.castShadow = false; node.receiveShadow = false;
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          // Preserve authored facing, opacity, lighting, UVs and depth behavior.
          // The engine supplies a dedicated camera and clears depth before world.
          if ('fog' in material) material.fog = false;
        }
      });
      const bounds = new THREE.Box3().setFromObject(this.root);
      if (bounds.isEmpty() || ![...bounds.min, ...bounds.max].every(Number.isFinite))
        throw new Error('Environment model contains no finite supported geometry.');
      return { root: this.root, bounds, warnings: [...this.warnings] };
    } catch (cause) {
      this.dispose();
      throw cause;
    }
  }

  private assertActive() { if (!this.active) throw new Error('Environment asset cancelled.'); }
  private notify() { if (this.active) this.onUpdate([...this.warnings]); }
  private async run<T>(task: () => Promise<T>): Promise<T> {
    try { return await environmentQueue.run(this.cancellation.signal, task); }
    catch (cause) {
      if (cause instanceof Error) throw new Error(cause.message.replace(/Preview/g, 'Environment asset'));
      throw cause;
    }
  }
  private async fetchAvailable(urls: string[]) {
    let failure: unknown;
    for (const url of urls) {
      this.assertActive();
      try {
        const result = await this.fetcher(assetUrl(url).href);
        this.assertActive();
        if (result.bytes.byteLength > ENVIRONMENT_ASSET_LIMITS.downloadBytes)
          throw new Error('Environment asset exceeds the 30 MB download limit.');
        return { ...result, url };
      } catch (cause) { this.assertActive(); failure = cause; }
    }
    throw failure ?? new Error('No environment asset URL was available.');
  }
  private loadTexture(input: string): Promise<THREE.Texture> {
    if (!this.active) return Promise.reject(new Error('Environment asset cancelled.'));
    let name: string;
    try { name = basename(input, 'texture'); } catch (cause) { return Promise.reject(cause); }
    const old = this.textures.get(name);
    if (old) return old;
    if (this.textures.size >= ENVIRONMENT_ASSET_LIMITS.textures)
      return Promise.reject(new Error('Environment texture count exceeds the 16-image budget.'));
    const pending = this.run(async () => {
      this.assertActive();
      const downloaded = await this.fetchAvailable(assetUrls(this.objectPath, name, 'textures'));
      this.assertActive();
      const decoded = unpackAsset(downloaded.bytes, 'texture');
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(decoded.bytes).buffer]), { imageOrientation: 'flipY' });
      const pixels = bitmap.width * bitmap.height;
      // Decode happens before dimensions are available. Close rejected/late images;
      // this bounds retention, not transient decoder allocations.
      if (!this.active || bitmap.width <= 0 || bitmap.height <= 0 || !Number.isFinite(pixels) ||
        bitmap.width > ENVIRONMENT_ASSET_LIMITS.imageDimension || bitmap.height > ENVIRONMENT_ASSET_LIMITS.imageDimension ||
        this.retainedPixels + pixels > ENVIRONMENT_ASSET_LIMITS.retainedPixels) {
        bitmap.close();
        throw new Error('Environment image exceeds the 4096px / 16 megapixel retention budget or was cancelled.');
      }
      const texture = new THREE.Texture(bitmap);
      texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.needsUpdate = true;
      this.retainedPixels += pixels; this.ownedTextures.add(texture);
      return texture;
    });
    this.textures.set(name, pending);
    return pending;
  }

  dispose() {
    if (!this.active) return;
    this.active = false;
    this.cancellation.abort();
    if (this.directX) { this.directX.dispose(); this.directX = null; this.root = null; }
    if (this.root) {
      this.root.removeFromParent(); disposeModelTree(this.root); this.root = null;
    }
    for (const texture of this.ownedTextures) {
      texture.dispose();
      (texture.image as ImageBitmap | undefined)?.close?.();
    }
    this.ownedTextures.clear(); this.textures.clear(); this.retainedPixels = 0;
  }
}
