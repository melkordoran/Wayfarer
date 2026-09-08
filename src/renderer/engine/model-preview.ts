import * as THREE from "three";
import { assetUrls, decodeModelAsset, unpackAsset, type AssetFetcher } from "./assets";
import { makeDemoModel } from "./demo";
import { parseRwx } from "./rwx";
import { createRwxGroup, disposeModelTree } from "./rwx-mesh";
import { previewWorkQueue } from "./preview-work-queue";
import { parseDirectX } from './directx';
import { createDirectXInstance, type DirectXInstance } from './directx-mesh';

export const PREVIEW_LIMITS = { vertices: 500_000, parts: 2048, textures: 16, imageSize: 4096, totalTexturePixels: 16_777_216 } as const;

/** One explicit preview request. Disposing invalidates all queued/late work. */
export class ModelPreviewSession {
  private active = true;
  private started = false;
  private root: THREE.Group | null = null;
  private directX: DirectXInstance | null = null;
  private ownsModelTextures = false;
  private textures = new Map<string, Promise<THREE.Texture>>();
  private ownedTextures = new Set<THREE.Texture>();
  private cancellation = new AbortController();
  private texturePixels = 0;
  private warnings = new Set<string>();
  constructor(private fetcher: AssetFetcher, private objectPath: string,
    private onUpdate: (warnings: string[]) => void = () => {}) {}

  async load(model: string): Promise<{ root: THREE.Group; warnings: string[] }> {
    if (!this.active || this.started) throw new Error("This preview session is no longer available.");
    this.started = true;
    if (model.startsWith("wayfarer:")) {
      this.ownsModelTextures = true;
      this.root = makeDemoModel(model.slice(9));
    } else {
      const downloaded = await previewWorkQueue.run(this.cancellation.signal, () => this.fetchAvailable(assetUrls(this.objectPath, model, "models")));
      if (!this.active) throw new Error("Preview cancelled.");
      const decoded = await decodeModelAsset(downloaded.bytes, model, downloaded.url);
      this.assertActive();
      const options = {
        isActive: () => this.active,
        loadTexture: (name: string) => this.loadTexture(name),
        onTexture: () => this.onUpdate([...this.warnings]),
        onTextureError: (name: string) => {
          this.warnings.add(`Texture not previewed: ${name}`);
          this.onUpdate([...this.warnings]);
        },
      };
      if (decoded.format === 'x') {
        this.directX = createDirectXInstance(parseDirectX(decoded.source), { ...options, maxVertices: PREVIEW_LIMITS.vertices, maxMeshes: PREVIEW_LIMITS.parts });
        this.directX.warnings.forEach(warning => this.warnings.add(warning));
        this.root = this.directX.root;
      } else {
        const parsed = parseRwx(decoded.source, 10, { maxCommands: 250_000, maxPrototypeExpansions: 10_000 });
        if (parsed.parts.length > PREVIEW_LIMITS.parts || parsed.parts.reduce((sum, part) => sum + part.positions.length / 3, 0) > PREVIEW_LIMITS.vertices)
          throw new Error("This model is too detailed for the preview budget. No object was added.");
        parsed.warnings.forEach(warning => this.warnings.add(warning));
        this.root = createRwxGroup(parsed, options);
      }
    }
    const bounds = new THREE.Box3().setFromObject(this.root);
    if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) {
      this.dispose(); throw new Error("This model has no finite preview geometry.");
    }
    return { root: this.root, warnings: [...this.warnings] };
  }

  private assertActive() { if (!this.active) throw new Error("Preview cancelled."); }
  private async fetchAvailable(urls: string[]) {
    let lastError: unknown;
    for (const url of urls) {
      this.assertActive();
      try {
        const result = await this.fetcher(url);
        this.assertActive(); return { ...result, url };
      } catch (error) {
        // Cancellation must not start the next extension fallback request.
        this.assertActive(); lastError = error;
      }
    }
    throw lastError ?? new Error("World has no valid object path");
  }

  private loadTexture(name: string) {
    if (!this.active) return Promise.reject(new Error("Preview cancelled."));
    const existing = this.textures.get(name);
    if (existing) return existing;
    if (this.textures.size >= PREVIEW_LIMITS.textures) return Promise.reject(new Error("Preview texture limit reached."));
    const pending = previewWorkQueue.run(this.cancellation.signal, async () => {
      if (!this.active) throw new Error("Preview cancelled.");
      const raw = await this.fetchAvailable(assetUrls(this.objectPath, name, "textures"));
      if (!this.active) throw new Error("Preview cancelled.");
      const decoded = unpackAsset(raw.bytes, "texture");
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(decoded.bytes).buffer]), { imageOrientation: "flipY" });
      const pixels = bitmap.width * bitmap.height;
      if (!this.active || bitmap.width <= 0 || bitmap.height <= 0 || !Number.isFinite(pixels) || bitmap.width > PREVIEW_LIMITS.imageSize || bitmap.height > PREVIEW_LIMITS.imageSize || this.texturePixels + pixels > PREVIEW_LIMITS.totalTexturePixels) {
        bitmap.close(); throw new Error("Preview texture unavailable or exceeds the 4096px / 16 megapixel texture budget.");
      }
      const texture = new THREE.Texture(bitmap);
      texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.needsUpdate = true;
      this.ownedTextures.add(texture);
      this.texturePixels += pixels;
      return texture;
    });
    this.textures.set(name, pending); return pending;
  }

  dispose() {
    if (!this.active) return;
    this.active = false;
    this.cancellation.abort();
    if (this.directX) { this.directX.dispose(); this.directX = null; this.root = null; }
    if (this.root) { this.root.removeFromParent(); disposeModelTree(this.root, this.ownsModelTextures); this.root = null; }
    for (const texture of this.ownedTextures) {
      texture.dispose();
      const bitmap = texture.image as ImageBitmap | undefined;
      bitmap?.close?.();
    }
    this.ownedTextures.clear(); this.textures.clear(); this.texturePixels = 0;
  }
}

export function framePreview(camera: THREE.PerspectiveCamera, root: THREE.Object3D) {
  const bounds = new THREE.Box3().setFromObject(root);
  const centre = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.05);
  const vertical = camera.fov * Math.PI / 360;
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(camera.aspect, 0.01));
  const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.18;
  camera.position.copy(centre).add(new THREE.Vector3(1, 0.65, -1.3).normalize().multiplyScalar(distance));
  camera.near = Math.max(0.001, radius / 1000);
  camera.far = Math.max(100, distance + radius * 100);
  camera.lookAt(centre); camera.updateProjectionMatrix();
  return { centre, size, radius, distance };
}
