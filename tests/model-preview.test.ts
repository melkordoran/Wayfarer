import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPreviewSession, framePreview } from "../src/renderer/engine/model-preview";
import { createRwxGroup, disposeModelTree } from "../src/renderer/engine/rwx-mesh";
import { parseRwx } from "../src/renderer/engine/rwx";
import type { AssetFetcher } from "../src/renderer/engine/assets";

const model = "ModelBegin\nClumpBegin\nColor 1 0.5 0.25\nVertex 0 0 0 UV 0 0\nVertex 1 0 0 UV 1 0\nVertex 0 1 0 UV 0 1\nTriangle 1 2 3\nClumpEnd\nModelEnd";
const bytes = (text: string) => ({ bytes: new TextEncoder().encode(text), contentType: "text/plain" });
afterEach(() => vi.unstubAllGlobals());
describe("shared RWX meshes", () => {
  it("preserves geometry, lighting, normals, collision and material values", () => {
    const parsed = parseRwx(model.replace("Color", "Tag 7\nCollision off\nMaterialModes Double\nLightSampling Vertex\nColor"));
    const root = createRwxGroup(parsed, { wireframe: true });
    const mesh = root.children[0] as THREE.Mesh;
    expect(mesh.geometry.getAttribute("position").count).toBe(3);
    expect(mesh.geometry.getAttribute("uv").count).toBe(3);
    expect(mesh.geometry.getAttribute("normal")).toBeTruthy();
    expect(mesh.userData).toMatchObject({ tag: 7, solid: false });
    expect(mesh.material).toMatchObject({ wireframe: true, side: THREE.DoubleSide, roughness: 0.8 });
    expect((mesh.material as THREE.MeshStandardMaterial).color.toArray()).toEqual([1, 0.5, 0.25]);
    disposeModelTree(root);
  });
  it("attaches textures and masks, but leaves disposed/overridden materials alone", async () => {
    const parsed = parseRwx(model.replace("Color", "Texture stone mask cutout\nColor"));
    const texture = new THREE.Texture(), mask = new THREE.Texture();
    const loadTexture = vi.fn(async (name: string) => name === "stone" ? texture : mask);
    const changed = vi.fn();
    const root = createRwxGroup(parsed, { loadTexture, onTexture: changed });
    const material = (root.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    await vi.waitFor(() => expect(material.alphaMap).toBe(mask));
    expect(material.map).toBe(texture); expect(material.alphaTest).toBe(0.1);
    expect(changed).toHaveBeenCalledTimes(2);
    const later = createRwxGroup(parsed, { loadTexture });
    const laterMaterial = (later.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    disposeModelTree(later);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(laterMaterial.map).toBeNull();
    const overridden = createRwxGroup(parsed, { loadTexture });
    const overrideMaterial = (overridden.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    overrideMaterial.userData.textureOverride = true;
    await vi.waitFor(() => expect(overrideMaterial.alphaMap).toBe(mask));
    expect(overrideMaterial.map).toBeNull();
    disposeModelTree(root); disposeModelTree(overridden); texture.dispose(); mask.dispose();
  });
  it("ignores late callbacks from an obsolete world without disposing its shared texture", async () => {
    const texture = new THREE.Texture(), dispose = vi.spyOn(texture, "dispose"), changed = vi.fn();
    const root = createRwxGroup(parseRwx(model.replace("Color", "Texture stone\nColor")), { loadTexture: async () => texture, isActive: () => false, onTexture: changed });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    expect(((root.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).map).toBeNull();
    disposeModelTree(root); expect(dispose).not.toHaveBeenCalled(); texture.dispose();
  });
});

describe("model browser previews", () => {
  it("loads real RWX through object-path fallback and frames its dimensions", async () => {
    const fetcher = vi.fn<AssetFetcher>(async url => { if (url.endsWith(".zip")) throw new Error("missing"); return bytes(model); });
    const session = new ModelPreviewSession(fetcher, "https://example.test/objects");
    const { root } = await session.load("piece.rwx");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://example.test/objects/models/piece.zip", "https://example.test/objects/models/piece.rwx"]);
    const camera = new THREE.PerspectiveCamera(40, 0.6, 0.01, 100);
    const result = framePreview(camera, root);
    expect(result.size.toArray()).toEqual([10, 10, 0]);
    expect(result.centre.toArray()).toEqual([5, 5, 0]);
    expect(camera.position.distanceTo(result.centre)).toBeCloseTo(result.distance);
    expect(camera.far).toBeGreaterThan(result.distance + result.radius);
    for (const vertex of [[0, 0, 0], [10, 0, 0], [0, 10, 0]]) {
      camera.updateMatrixWorld(); const projected = new THREE.Vector3(...vertex).project(camera);
      expect(Math.abs(projected.x)).toBeLessThan(1); expect(Math.abs(projected.y)).toBeLessThan(1);
    }
    session.dispose();
  });
  it("previews original geometry without a network request and frees it once", async () => {
    const fetcher = vi.fn(); const session = new ModelPreviewSession(fetcher, "");
    const { root } = await session.load("wayfarer:cube");
    const geometry = (root.children[0] as THREE.Mesh).geometry;
    const dispose = vi.spyOn(geometry, "dispose");
    expect(fetcher).not.toHaveBeenCalled();
    expect(new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).toArray()).toEqual([1, 1, 1]);
    session.dispose(); session.dispose(); expect(dispose).toHaveBeenCalledTimes(1);
  });
  it("cancels pending model loads and refuses concurrent reuse", async () => {
    let resolve!: (value: ReturnType<typeof bytes>) => void;
    const fetcher = vi.fn<AssetFetcher>(() => new Promise(done => { resolve = done; }));
    const session = new ModelPreviewSession(fetcher, "https://example.test/");
    const loading = session.load("piece.rwx");
    await expect(session.load("second.rwx")).rejects.toThrow("no longer");
    session.dispose(); resolve(bytes(model));
    await expect(loading).rejects.toThrow("cancelled");
  });
  it("closes a bitmap that completes after the preview is disposed", async () => {
    let resolve!: (value: { width: number; height: number; close: () => void }) => void;
    const bitmap = { width: 16, height: 16, close: vi.fn() };
    const decode = vi.fn(() => new Promise(done => { resolve = done; }));
    vi.stubGlobal("createImageBitmap", decode);
    const fetcher: AssetFetcher = async url => url.includes("/models/") ? bytes(model.replace("Color", "Texture stone\nColor")) : { bytes: new Uint8Array([1, 2]), contentType: "image/png" };
    const update = vi.fn(), session = new ModelPreviewSession(fetcher, "https://example.test/", update);
    await session.load("piece.rwx");
    await vi.waitFor(() => expect(decode).toHaveBeenCalled());
    session.dispose(); resolve(bitmap);
    await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledTimes(1));
    expect(update).not.toHaveBeenCalled();
  });
  it("reports missing textures while retaining real geometry", async () => {
    const update = vi.fn();
    const session = new ModelPreviewSession(async url => {
      if (url.includes("textures")) throw new Error("missing");
      return bytes(model.replace("Color", "Texture missing\nColor"));
    }, "https://example.test/", update);
    const { root } = await session.load("piece.rwx");
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(["Texture not previewed: missing"]));
    expect(root.children).toHaveLength(1); session.dispose();
  });
  it("rejects empty or unbounded model geometry", async () => {
    const session = new ModelPreviewSession(async () => bytes("ModelBegin\nModelEnd"), "https://example.test/");
    await expect(session.load("empty.rwx")).rejects.toThrow("no finite");
    session.dispose();
  });
});
