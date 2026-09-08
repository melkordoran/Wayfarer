import * as THREE from 'three';
import type { TerrainTile } from '../../shared/types';
import type { TerrainCellSample, TerrainEditRow, TerrainRegion } from '../../shared/terrain-edit';
import { terrainCellPage } from '../../shared/terrain-edit';
import { TerrainData, terrainBounds, terrainKey, validTerrainRegion } from './terrain-data';
import { terrainGeometry, type TerrainHeightLookup } from './terrain';
export type { TerrainCellSample, TerrainEditRow, TerrainRegion } from '../../shared/terrain-edit';

export type TerrainPreviewCancelReason = 'selection-changed' | 'terrain-changed' | 'unloaded' | 'world-changed' | 'disabled' | 'disposed';
interface Options {
  meshes: () => Iterable<THREE.Mesh>;
  offset: () => number;
  createPreview: (tile: TerrainTile, heightAt: TerrainHeightLookup) => THREE.Mesh;
  disposePreview: (mesh: THREE.Mesh) => void;
  onSelect?: (cell: { cellX: number; cellZ: number }) => void;
  onCancelled?: (reason: TerrainPreviewCancelReason) => void;
}
/** Whether a changed node owns any outer vertices used by this surface. */
export function sharesTerrainEdge(surface: TerrainTile, changed: TerrainTile): boolean {
  const a = terrainBounds(surface), b = terrainBounds(changed);
  return (a.right === b.cellX && a.cellZ <= b.top && a.top >= b.cellZ)
    || (a.top === b.cellZ && a.cellX <= b.right && a.right >= b.cellX);
}

/** Bounded visual-only drafts. Canonical arrays, meshes and collision heights stay authoritative. */
export class TerrainTools {
  readonly data = new TerrainData();
  readonly overlay = new THREE.Group();
  private lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#e4bd70', depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, toneMapped: false }));
  private fill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: '#edc47d', depthTest: false, depthWrite: false, transparent: true, opacity: 0.12, side: THREE.DoubleSide, toneMapped: false }));
  private selection: TerrainRegion | null = null;
  private previews: Array<{ original: THREE.Mesh; mesh: THREE.Mesh; wasVisible: boolean }> = [];
  private previewHeight: TerrainHeightLookup | null = null;
  private enabled = false;
  private disposed = false;
  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private canvas: HTMLCanvasElement, private options: Options) {
    this.overlay.name = 'Wayfarer terrain selection'; this.overlay.add(this.fill, this.lines);
    this.fill.renderOrder = 29; this.lines.renderOrder = 30;
    this.overlay.visible = false; this.scene.add(this.overlay);
  }
  get active() { return this.enabled && !this.disposed; }
  get previewing() { return this.previews.length > 0; }
  setMode(enabled: boolean) {
    if (this.disposed || enabled === this.enabled) return;
    this.enabled = enabled; if (!enabled) this.cancelPreview('disabled'); this.refreshOverlay();
  }
  setSelection(region: TerrainRegion | null) {
    if (this.disposed || (region && !validTerrainRegion(region))) return false;
    if (JSON.stringify(region) !== JSON.stringify(this.selection)) this.cancelPreview('selection-changed');
    this.selection = region ? { ...region } : null; this.refreshOverlay(); return true;
  }
  sample(region: TerrainRegion): TerrainCellSample[] { return this.disposed ? [] : this.data.sample(region); }
  putTile(tile: TerrainTile): boolean {
    if (this.disposed || !this.data.put(tile)) return false;
    if (this.selectionTouches([tile]) || this.previewTouches([tile])) this.cancelPreview('terrain-changed');
    this.refreshOverlay(); return true;
  }
  setPageComplete(pageX: number, pageZ: number, complete: boolean) {
    if (this.disposed || !Number.isSafeInteger(pageX) || !Number.isSafeInteger(pageZ)) return;
    this.data.setComplete(pageX, pageZ, complete);
    if (!complete && this.selectionTouches([{ pageX, pageZ }])) this.cancelPreview('terrain-changed');
    this.refreshOverlay();
  }
  unload(pages: readonly { pageX: number; pageZ: number }[]) {
    if (this.selectionTouches(pages) || this.previewTouches(pages)) this.cancelPreview('unloaded');
    this.data.deletePages(pages); this.refreshOverlay();
  }
  private selectionTouches(pages: readonly { pageX: number; pageZ: number }[]) {
    const selection = this.selection; if (!selection) return false;
    const first = terrainCellPage(selection.cellX, selection.cellZ), last = terrainCellPage(selection.cellX + selection.width - 1, selection.cellZ + selection.depth - 1);
    return pages.some(page => page.pageX >= first.pageX && page.pageX <= last.pageX && page.pageZ >= first.pageZ && page.pageZ <= last.pageZ);
  }
  private previewTouches(pages: readonly { pageX: number; pageZ: number }[]) {
    return this.previews.some(({ original }) => {
      const tile = original.userData.terrainTile as TerrainTile;
      return pages.some(page => page.pageX === tile.pageX && page.pageZ === tile.pageZ);
    });
  }
  preview(rows: readonly TerrainEditRow[]): boolean {
    if (!this.active || !this.selection) return false;
    const changed = this.data.patchedTiles(rows, this.selection); if (!changed?.length) return false;
    this.cancelPreview();
    const replacements = new Map(changed.map(tile => [terrainKey(tile), tile]));
    const heightAt: TerrainHeightLookup = (x, z) => {
      for (const tile of changed) {
        const b = terrainBounds(tile);
        if (x >= b.cellX && x < b.right && z >= b.cellZ && z < b.top && Number.isInteger(x) && Number.isInteger(z)) return tile.heights[(z - b.cellZ) * tile.size + x - b.cellX];
      }
      return this.data.heightAt(x, z);
    };
    try {
      for (const original of this.options.meshes()) {
        const tile = original.userData.terrainTile as TerrainTile;
        if (!replacements.has(terrainKey(tile)) && !changed.some(value => sharesTerrainEdge(tile, value))) continue;
        const mesh = this.options.createPreview(replacements.get(terrainKey(tile)) ?? tile, heightAt);
        const wasVisible = original.visible;
        mesh.visible = wasVisible; mesh.userData.terrainPreview = true;
        this.previews.push({ original, mesh, wasVisible }); this.scene.add(mesh);
        original.userData.terrainPreviewHidden = true; original.visible = false;
      }
      if (!this.previews.length) return false;
      this.previewHeight = heightAt; this.refreshOverlay(); return true;
    } catch { this.cancelPreview(); return false; }
  }
  cancelPreview(reason?: TerrainPreviewCancelReason) {
    const hadPreview = this.previewing;
    for (const { original, mesh, wasVisible } of this.previews) {
      original.visible = wasVisible; delete original.userData.terrainPreviewHidden;
      this.scene.remove(mesh); this.options.disposePreview(mesh);
    }
    this.previews = []; this.previewHeight = null; this.refreshOverlay();
    if (hadPreview && reason) this.options.onCancelled?.(reason);
  }
  selectAt(clientX: number, clientY: number): boolean {
    if (!this.active || this.previewing || document.pointerLockElement === this.canvas) return false;
    const rect = this.canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), this.camera);
    ray.far = Math.min(1200, this.camera.far);
    let nearest: THREE.Intersection | null = null;
    // Hole cells still need to be selectable. Use authored height triangles for
    // this click only; never add hole proxies to scene rendering or collision.
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    try {
      for (const mesh of this.options.meshes()) {
        if (!mesh.visible) continue;
        const tile = mesh.userData.terrainTile as TerrainTile, b = terrainBounds(tile);
        const box = new THREE.Box3(new THREE.Vector3(b.cellX * 10, -21474837, b.cellZ * 10), new THREE.Vector3(b.right * 10, 21474837, b.top * 10));
        if (!ray.ray.intersectsBox(box)) continue;
        const geometry = terrainGeometry(tile, this.data.heightAt), proxy = new THREE.Mesh(geometry, material);
        proxy.position.y = this.options.offset(); proxy.updateMatrixWorld();
        const hit = ray.intersectObject(proxy)[0]; geometry.dispose();
        if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
      }
    } finally { material.dispose(); }
    if (!nearest) return false;
    const cellX = Math.floor(nearest.point.x / 10), cellZ = Math.floor(nearest.point.z / 10);
    if (!this.data.read(cellX, cellZ)) return false;
    this.setSelection({ cellX, cellZ, width: this.selection?.width ?? 1, depth: this.selection?.depth ?? 1 });
    this.options.onSelect?.({ cellX, cellZ }); return true;
  }
  refreshOverlay() {
    const selection = this.selection;
    this.overlay.visible = this.active && !!selection;
    if (!selection || this.disposed) return;
    const heightAt = this.previewHeight ?? this.data.heightAt, lines: number[] = [], faces: number[] = [];
    for (let z = 0; z < selection.depth; z++) for (let x = 0; x < selection.width; x++) {
      const cellX = selection.cellX + x, cellZ = selection.cellZ + z, h = heightAt(cellX, cellZ);
      if (h === null) continue;
      const point = (dx: number, dz: number) => [10 * (cellX + dx), (heightAt(cellX + dx, cellZ + dz) ?? h) + this.options.offset() + 0.06, 10 * (cellZ + dz)];
      const a = point(0, 0), b = point(1, 0), c = point(0, 1), d = point(1, 1);
      lines.push(...a, ...b, ...b, ...d, ...d, ...c, ...c, ...a); faces.push(...a, ...c, ...b, ...b, ...c, ...d);
    }
    this.lines.geometry.dispose(); this.fill.geometry.dispose();
    this.lines.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    this.fill.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(faces, 3));
    this.lines.material.color.set(this.previewing ? '#8bdac8' : '#e4bd70'); this.fill.material.color.copy(this.lines.material.color);
  }
  reset(reason: TerrainPreviewCancelReason = 'world-changed') {
    this.cancelPreview(reason); this.enabled = false; this.selection = null; this.data.clear(); this.overlay.visible = false;
    this.lines.geometry.dispose(); this.fill.geometry.dispose();
    this.lines.geometry = new THREE.BufferGeometry(); this.fill.geometry = new THREE.BufferGeometry();
  }
  dispose() {
    if (this.disposed) return;
    this.reset('disposed'); this.disposed = true; this.scene.remove(this.overlay);
    this.lines.geometry.dispose(); this.fill.geometry.dispose(); this.lines.material.dispose(); this.fill.material.dispose();
  }
}
