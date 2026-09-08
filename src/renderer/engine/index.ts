import * as THREE from 'three';
import { createRwxGroup } from './rwx-mesh';
import type { Avatar, Position, TerrainTile, WorldObject, WorldSettings } from '../../shared/types';
import { LOCAL_TELEPORT_DENIED, localTeleportAllowed } from '../../shared/navigation';
import { ACTION_LIMITS, BumpContacts, actionColor, parseActions, parseTeleport, type ActionCommand } from './actions';
import { AssetQueue, assetUrls, decodeModelAsset, firstAvailable, unpackAsset, type AssetFetcher } from './assets';
import { makeDemoModel } from './demo';
import { parseRwx, type RwxModel } from './rwx';
import { parseDirectX, type DirectXModel } from './directx';
import { createDirectXInstance, disposeDirectXTree, type DirectXInstance } from './directx-mesh';
import { isTerrainHoleAt, terrainSurface, terrainTextureName, type TerrainHeightLookup } from './terrain';
import { TerrainTools, sharesTerrainEdge, type TerrainCellSample, type TerrainEditRow, type TerrainPreviewCancelReason, type TerrainRegion } from './terrain-tools';
import { terrainKey } from './terrain-data';
export type { TerrainCellSample, TerrainEditRow, TerrainPreviewCancelReason, TerrainRegion } from './terrain-tools';
import { applyAvatarPose, directXJointName, loadAvatarCatalog, loadAvatarModel, loadAvatarSequence, sampleAvatarSequence, type AvatarCatalog, type AvatarDefinition, type AvatarModel, type AvatarRig, type AvatarSequence, type JointPose } from './avatar-assets';
import { TransformTools, type TransformChange, type TransformMode, type TransformSpace } from './transform-tools';
import { STUDIO_AVATAR_PATH, fetchStudioAvatarAsset } from './studio-avatar-assets';
import { EnvironmentController, applyWaterAppearance, flightAllowed, terrainElevation, type EnvironmentMode } from './environment';
import { EnvironmentScene } from './environment-scene';
export type { EnvironmentMode } from './environment';

export interface GesturePlaybackState {
  requestId: number;
  /** Wayfarer convention: explicit[gesture - 1], zero stops. Axis transports the integer opaquely. */
  gesture: number;
  phase: 'idle' | 'loading' | 'playing' | 'error';
  reason?: 'completed' | 'stopped' | 'world-changed' | 'avatar-changed' | 'asset-changed' | 'disposed' | 'unavailable' | 'timeout' | 'invalid';
  message?: string;
}
export const AVATAR_GESTURE_LIMITS = Object.freeze({ loadMs: 10_000, playbackMs: 60_000 });
export interface AvatarAssetState {
  session: number;
  local: boolean;
  type: number;
  geometry: string;
  status: 'loading' | 'ready' | 'fallback';
  format?: 'x' | 'rwx';
  warnings: string[];
  message?: string;
}

interface EngineOptions {
  onPosition: (position: Position) => void;
  onSelect: (object: WorldObject | null, context?: { additive: boolean }) => void;
  onStats: (stats: { fps: number; drawCalls: number; triangles: number }) => void;
  asset: AssetFetcher;
  onAction?: (action: { type: string; value?: string; object?: WorldObject }) => void;
  onAvatarCatalog?: (catalog: AvatarCatalog) => void;
  onAvatarAssetState?: (state: AvatarAssetState) => void;
  onGestureState?: (state: GesturePlaybackState) => void;
  onTransform?: (changes: TransformChange[]) => Promise<boolean>;
  onTerrainSelect?: (cell: { cellX: number; cellZ: number }) => void;
  onTerrainPreviewCancelled?: (reason: TerrainPreviewCancelReason) => void;
}
interface ObjectEntry { object: WorldObject; root: THREE.Group; actions: ActionCommand[]; rotation?: THREE.Vector3; solid: boolean; ready: boolean }
type RuntimeAvatarRig = AvatarRig | DirectXInstance;
interface AvatarEntry {
  avatar: Avatar; root: THREE.Group; body: THREE.Group; target: THREE.Vector3;
  definition?: AvatarDefinition; rig?: RuntimeAvatarRig; sequence?: AvatarSequence; sequenceName?: string;
  sequenceStarted: number; sequenceVersion: number; movingUntil: number;
  gesture?: { index: number; requestId: number; requestedAt: number; deadline: number; phase: 'loading' | 'playing' };
  gestureTimer?: ReturnType<typeof setTimeout>;
}

function cloneAvatarRig(template: AvatarRig): AvatarRig {
  const root = template.root.clone(true);
  const joints = new Map([...template.joints].map(([name, joint]) => [name, { ...joint, group: root.getObjectByName(joint.group.name) as THREE.Group, bindPosition: joint.bindPosition.clone(), bindRotation: joint.bindRotation.clone() }]));
  return { root, joints, warnings: template.warnings, parts: template.parts.map(({ part, parent }) => ({ part, parent: parent === template.root ? root : root.getObjectByName(parent.name) as THREE.Group })) };
}
function applyRigPose(rig: RuntimeAvatarRig, pose: Map<string, JointPose>) {
  if ('format' in rig && rig.format === 'x') rig.applyPose(pose);
  else applyAvatarPose(rig as AvatarRig, pose);
}

const eyeHeight = 1.7;
const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown', 'ShiftLeft', 'ShiftRight', 'KeyF']);
function shortcutModifier(event: KeyboardEvent) {
  return event.metaKey || event.ctrlKey || event.altKey || /^(Meta|Control|Alt)(Left|Right)$/.test(event.code);
}
function disposeTree(root: THREE.Object3D, textures = false) {
  disposeDirectXTree(root);
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), maps = new Set<THREE.Texture>();
  root.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Sprite) {
      if ('geometry' in child) geometries.add(child.geometry);
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        materials.add(material);
        if (textures) for (const value of Object.values(material)) if (value instanceof THREE.Texture && !value.userData.sharedAsset) maps.add(value);
      }
    }
  });
  geometries.forEach(g => g.dispose()); materials.forEach(m => { m.userData.disposed = true; m.dispose(); }); maps.forEach(t => { t.dispose(); if (typeof ImageBitmap !== 'undefined' && t.image instanceof ImageBitmap) t.image.close(); });
}

export class WorldEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1200);
  private readonly objects = new Map<number, ObjectEntry>();
  private readonly avatars = new Map<number, AvatarEntry>();
  private readonly terrain = new Map<string, THREE.Mesh>();
  private readonly warnedTerrainValues = new Set<number>();
  private readonly ray = new THREE.Raycaster();
  private readonly selectionHelpers = new Map<number, THREE.BoxHelper>();
  private readonly selectedIds = new Set<number>();
  private readonly transformTools: TransformTools;
  private readonly terrainTools: TerrainTools;
  private readonly hemi = new THREE.HemisphereLight('#d9edff', '#78795b', 2.1);
  private readonly sun = new THREE.DirectionalLight('#fff2d1', 3.0);
  private readonly ambient = new THREE.AmbientLight('#fff7e2', 0.18);
  private readonly environment: EnvironmentController;
  private readonly environmentScene: EnvironmentScene;
  private readonly queue = new AssetQueue(6);
  private readonly parsedModels = new Map<string, Promise<RwxModel | DirectXModel>>();
  private readonly avatarRigs = new Map<string, Promise<AvatarModel>>();
  private readonly avatarSequences = new Map<string, Promise<AvatarSequence>>();
  private avatarCatalog: AvatarCatalog = { version: 0, entries: [], warnings: [] };
  private avatarCatalogStatus: 'loading' | 'ready' | 'unavailable' = 'unavailable';
  private gestureRequest = 0;
  private localGesture = 0;
  private readonly textures = new Map<string, Promise<THREE.Texture>>();
  private readonly textureResources = new Set<THREE.Texture>();
  private readonly keys = new Set<string>();
  private readonly resizeObserver: ResizeObserver;
  private readonly listeners: Array<() => void> = [];
  private settings: WorldSettings | null = null;
  private water: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private ground: THREE.Mesh | null = null;
  private position: Position = { x: 0, y: 0, z: -29, yaw: 0, pitch: 0 };
  private selectedId: number | null = null;
  private buildMode = false;
  private fly = false;
  private wireframe = false;
  private dragging = false;
  private cameraPointer: number | null = null;
  private pointerStart = { x: 0, y: 0 };
  private frame = 0;
  private lastTime = 0;
  private lastPositionTime = 0;
  private lastStatsTime = 0;
  private frameCount = 0;
  private disposed = false;
  private generation = 0;
  private collisionMeshes: THREE.Mesh[] = [];
  private bumpMeshes: THREE.Mesh[] = [];
  private bumpObjects: Array<{ entry: ObjectEntry; bounds: THREE.Box3; meshes: Array<{ mesh: THREE.Mesh; bounds: THREE.Box3 }> }> = [];
  private readonly bumpContacts = new BumpContacts();
  private navigationActionsEnabled = true;
  private collisionDirty = true;
  private timeOfDay: EnvironmentMode = 'day';
  private cameraMode: 'first-person' | 'third-person' = 'first-person';
  private avatarType = 0;
  private readonly localAvatarSession = -2147483647;

  constructor(private canvas: HTMLCanvasElement, private options: EngineOptions) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.scene.background = new THREE.Color('#c8d6d1');
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.hemi, this.sun, this.sun.target, this.ambient);
    this.environment = new EnvironmentController({ scene: this.scene, camera: this.camera, sun: this.sun, ambient: this.ambient, hemi: this.hemi, renderer: this.renderer });
    this.environmentScene = new EnvironmentScene(this.scene, options.asset, () => { this.collisionDirty = true; }, value => this.options.onAction?.({ type: 'asset-error', value }));
    this.sun.position.set(-38, 55, -28);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -65, right: 65, top: 65, bottom: -65, near: 1, far: 170 });
    this.sun.shadow.normalBias = 0.045;
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.canvas.tabIndex = 0;
    this.canvas.style.outline = 'none';
    this.canvas.style.touchAction = 'none';
    this.transformTools = new TransformTools(this.scene, this.camera, canvas, {
      entries: () => [...this.selectedIds].flatMap(id => this.objects.has(id) ? [this.objects.get(id)!] : []),
      primaryId: () => this.selectedId,
      current: id => this.objects.get(id), commit: options.onTransform,
      started: () => { this.keys.clear(); this.dragging = false; },
      changed: () => { this.collisionDirty = true; for (const id of this.selectedIds) this.updateSelectionHighlight(id); },
      error: message => this.options.onAction?.({ type: 'transform-error', value: message }),
    });
    this.terrainTools = new TerrainTools(this.scene, this.camera, canvas, {
      meshes: () => this.terrain.values(), offset: () => terrainElevation(this.settings),
      createPreview: (tile, heightAt) => this.createTerrainMesh(tile, heightAt),
      disposePreview: mesh => disposeTree(mesh, true), onSelect: options.onTerrainSelect, onCancelled: options.onTerrainPreviewCancelled,
    });
    this.installControls();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.frame = requestAnimationFrame(this.animate);
  }

  resize() {
    if (this.disposed) return;
    const width = Math.max(1, this.canvas.clientWidth), height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
  getPosition(): Position { return { ...this.position }; }
  setFlying(value: boolean) {
    if (value && !flightAllowed(this.settings)) {
      this.options.onAction?.({ type: 'flight-denied', value: 'Flying is disabled in this world for your current rights.' });
      return false;
    }
    this.fly = value;
    if (!value) for (const key of ['Space', 'PageUp', 'PageDown']) this.keys.delete(key);
    this.options.onAction?.({ type: 'fly', value: String(value) });
    return value;
  }
  setCameraMode(mode: 'first-person' | 'third-person') {
    if (this.disposed) return;
    this.cameraMode = mode;
    const local = mode === 'third-person' ? this.ensureLocalAvatar() : this.avatars.get(this.localAvatarSession);
    if (local) local.root.visible = mode === 'third-person';
  }
  setAvatarType(type: number) {
    if (!Number.isInteger(type) || type < 0 || type > 65535 || this.disposed) return;
    if (this.avatarType !== type) {
      this.cancelLocalGesture('avatar-changed'); this.avatarType = type; this.deleteAvatar(this.localAvatarSession);
    }
    if (this.cameraMode === 'third-person') this.ensureLocalAvatar();
  }
  /** Explicit local trigger: calling the same positive index again deliberately restarts it. */
  setGesture(gesture: number): number {
    const requestId = ++this.gestureRequest;
    if (this.disposed) return requestId;
    const local = this.ensureLocalAvatar();
    this.clearAvatarSequence(local); this.clearGesture(local);
    this.localGesture = 0; local.avatar = { ...local.avatar, gesture: 0 };
    if (!Number.isInteger(gesture) || gesture < 0 || gesture > 255) {
      this.options.onGestureState?.({ requestId, gesture: 0, phase: 'error', reason: 'invalid', message: 'Gesture index must be an integer from 0 to 255.' });
    } else if (gesture === 0) {
      this.options.onGestureState?.({ requestId, gesture: 0, phase: 'idle', reason: 'stopped' });
    } else {
      this.localGesture = gesture; local.avatar = { ...local.avatar, gesture };
      this.beginGesture(local, gesture, requestId);
    }
    return requestId;
  }
  stopGesture(): number { return this.setGesture(0); }
  private ensureLocalAvatar(): AvatarEntry {
    let local = this.avatars.get(this.localAvatarSession);
    if (!local) {
      this.setAvatar({ ...this.position, session: this.localAvatarSession, citizen: 0, name: '', type: this.avatarType, gesture: 0, state: 0 });
      local = this.avatars.get(this.localAvatarSession)!;
      local.root.children[1].visible = false;
    }
    local.root.visible = this.cameraMode === 'third-person';
    return local;
  }
  setBuildMode(value: boolean) { this.buildMode = value; if (!value) this.setTerrainEditMode(false); this.transformTools.setBuilding(value && !this.terrainTools.active); this.canvas.style.cursor = value ? 'crosshair' : 'default'; if (!value) this.setSelected(null); }
  setTerrainEditMode(enabled: boolean) {
    if (this.disposed) return;
    if (enabled && (this.settings?.terrainEnabled === false || this.settings?.canEditTerrain === false)) return;
    this.terrainTools.setMode(enabled); this.keys.clear(); this.stopCameraDrag();
    this.transformTools.setBuilding(this.buildMode && !enabled);
  }
  setTerrainSelection(region: TerrainRegion | null) { return this.terrainTools.setSelection(region); }
  sampleTerrain(region: TerrainRegion): TerrainCellSample[] { return this.terrainTools.sample(region); }
  previewTerrainRows(rows: readonly TerrainEditRow[]): boolean { return this.terrainTools.preview(rows); }
  cancelTerrainPreview() { this.terrainTools.cancelPreview(); }
  setTerrainPageComplete(pageX: number, pageZ: number, complete: boolean) { this.terrainTools.setPageComplete(pageX, pageZ, complete); this.syncStudioTerrainBase(); }
  setTransformMode(mode: TransformMode) { this.transformTools.setMode(mode); }
  setTransformSpace(space: TransformSpace) { this.transformTools.setSpace(space); }
  /** Translation in metres, rotation in radians; zero disables the snap. */
  setTransformSnap(snap: { translation: number; rotation: number }) { this.transformTools.setSnap(snap); }
  setTransformEnabled(value: boolean) { this.transformTools.setEnabled(value); }
  /** Host UI pauses authored navigation during modal/draft/build/session work.
   * Disabling clears held input; enabling never queues or replays an action. */
  setNavigationActionsEnabled(value: boolean) {
    if (this.disposed || this.navigationActionsEnabled === value) return;
    this.navigationActionsEnabled = value;
    this.keys.clear(); this.stopCameraDrag();
    this.bumpContacts.reset(performance.now());
  }
  setWireframe(value: boolean) {
    this.wireframe = value;
    this.scene.traverse(node => { if (node instanceof THREE.Mesh) for (const m of Array.isArray(node.material) ? node.material : [node.material]) if ('wireframe' in m) m.wireframe = value; });
  }
  setSelected(id: number | null) {
    this.setSelection(id === null ? [] : [id], id);
  }
  /** At most 256 existing objects are selected; declaration order is preserved. */
  setSelection(ids: readonly number[], primaryId?: number | null) {
    if (this.disposed) return;
    const next = new Set<number>();
    for (const id of ids) {
      if (Number.isSafeInteger(id) && this.objects.has(id)) next.add(id);
      if (next.size === 256) break;
    }
    const requestedPrimary = primaryId === undefined ? this.selectedId : primaryId;
    // A refused 257th additive pick must not silently move the local reference
    // frame to the first object while the UI retains its previous selection.
    this.selectedId = primaryId === null ? null
      : requestedPrimary !== null && next.has(requestedPrimary) ? requestedPrimary
      : this.selectedId !== null && next.has(this.selectedId) ? this.selectedId
      : next.values().next().value ?? null;
    for (const id of this.selectionHelpers.keys()) if (!next.has(id)) this.removeSelectionHighlight(id);
    this.selectedIds.clear(); next.forEach(id => this.selectedIds.add(id));
    for (const id of this.selectedIds) this.updateSelectionHighlight(id);
    this.transformTools.sync();
  }
  private updateSelectionHighlight(id: number) {
    const entry = this.objects.get(id);
    if (!entry || !this.selectedIds.has(id)) return;
    let helper = this.selectionHelpers.get(id);
    if (!helper) {
      helper = new THREE.BoxHelper(entry.root); helper.renderOrder = 20;
      helper.userData.selectionFor = id;
      const material = helper.material as THREE.LineBasicMaterial;
      material.depthTest = false; material.depthWrite = false; material.toneMapped = false;
      this.selectionHelpers.set(id, helper); this.scene.add(helper);
    }
    (helper.material as THREE.LineBasicMaterial).color.set(id === this.selectedId ? '#dfaf58' : '#74c5bd');
    helper.setFromObject(entry.root); helper.geometry.computeBoundingBox(); helper.visible = true;
  }
  private removeSelectionHighlight(id: number) {
    const helper = this.selectionHelpers.get(id);
    if (!helper) return;
    this.scene.remove(helper); disposeTree(helper); this.selectionHelpers.delete(id);
  }

  setWorld(settings: WorldSettings) {
    this.cancelLocalGesture('world-changed');
    this.stopCameraDrag();
    this.transformTools.cancel();
    this.terrainTools.reset();
    this.generation++;
    this.environmentScene.reset();
    this.settings = settings;
    this.setFlying(false);
    for (const id of this.objects.keys()) this.deleteObject(id);
    for (const id of this.avatars.keys()) this.deleteAvatar(id);
    this.terrain.forEach(mesh => { this.scene.remove(mesh); disposeTree(mesh, true); }); this.terrain.clear();
    this.warnedTerrainValues.clear();
    if (this.water) { this.scene.remove(this.water); disposeTree(this.water, true); this.water = null; }
    if (this.ground) { this.scene.remove(this.ground); disposeTree(this.ground, true); this.ground = null; }
    this.textureResources.forEach(texture => this.disposeTexture(texture));
    this.textureResources.clear(); this.textures.clear(); this.parsedModels.clear();
    this.collisionDirty = true; this.setSelected(null);
    this.syncEnvironment();
    this.environmentScene.update(settings);
    this.setTimeOfDay(this.timeOfDay);
    this.placeAt(settings.entry);
    this.refreshAvatarCatalog();
    if (this.cameraMode === 'third-person') this.setAvatarType(this.avatarType);
  }

  /** Apply repeated world attribute packets without resetting the user's place or downloaded scene. */
  updateWorld(settings: WorldSettings) {
    if (!this.settings || this.settings.name.toLowerCase() !== settings.name.toLowerCase() || Boolean(this.settings.demo) !== Boolean(settings.demo)) { this.setWorld(settings); return; }
    const objectPathChanged = this.settings.objectPath !== settings.objectPath;
    if (this.settings.terrainOffset !== settings.terrainOffset || this.settings.terrainEnabled !== settings.terrainEnabled || objectPathChanged) this.terrainTools.cancelPreview('terrain-changed');
    this.settings = settings;
    if (!settings.terrainEnabled || settings.canEditTerrain === false) this.setTerrainEditMode(false);
    if (this.fly && !flightAllowed(settings)) this.setFlying(false);
    if (!settings.canBuild) this.transformTools.cancel();
    this.syncEnvironment(); this.setTimeOfDay(this.timeOfDay);
    this.environmentScene.update(settings);
    if (objectPathChanged) {
      this.generation++;
      this.parsedModels.clear(); this.textures.clear();
      const objects = [...this.objects.values()].map(entry => entry.object);
      this.setObjects(objects, false, true);
      for (const mesh of this.terrain.values()) this.applyTerrainTextures(mesh);
      this.refreshAvatarCatalog();
      this.collectUnusedTextures(true);
    }
  }

  private syncEnvironment() {
    const settings = this.settings;
    if (!settings) return;
    const needsGround = settings.terrainEnabled && !settings.demo;
    if (needsGround && !this.ground) {
      this.ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: '#79916a', roughness: 1 }));
      this.ground.rotation.x = -Math.PI / 2; this.ground.receiveShadow = true; this.scene.add(this.ground);
    }
    if (!needsGround && this.ground) { this.scene.remove(this.ground); disposeTree(this.ground); this.ground = null; }
    for (const mesh of this.terrain.values()) { mesh.visible = settings.terrainEnabled && !mesh.userData.terrainPreviewHidden; mesh.position.y = terrainElevation(settings); mesh.updateMatrixWorld(true); }
    if (this.ground) { this.ground.visible = this.terrain.size === 0; this.ground.position.y = terrainElevation(settings) - 0.05; this.ground.updateMatrixWorld(true); }
    if (settings.waterEnabled && !this.water) {
      this.water = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: '#6dadae', transparent: true, opacity: 0.72, roughness: 0.25, metalness: 0.35, side: THREE.DoubleSide }));
      this.water.rotation.x = -Math.PI / 2; this.scene.add(this.water);
    }
    if (settings.waterEnabled && this.water) applyWaterAppearance(this.water, settings);
    if (!settings.waterEnabled && this.water) { this.scene.remove(this.water); disposeTree(this.water); this.water = null; }
    this.collisionDirty = true;
    this.terrainTools.refreshOverlay(); this.syncStudioTerrainBase();
  }
  private syncStudioTerrainBase() {
    if (!this.settings?.demo) return;
    const replace = this.settings.terrainEnabled && this.terrainTools.sample({ cellX: -64, cellZ: -64, width: 1, depth: 1 })[0]?.height != null && this.terrain.size > 0;
    for (const entry of this.objects.values()) if (entry.object.model === 'wayfarer:landscape') entry.root.traverse(node => { if (node.userData.studioTerrainBase) node.visible = !replace; });
  }

  setTimeOfDay(time: EnvironmentMode) {
    this.timeOfDay = time;
    this.environment.apply(this.settings, time, this.position);
  }
  setEnvironmentMode(mode: EnvironmentMode) { this.setTimeOfDay(mode); }

  setObjects(objects: WorldObject[], replace = false, forceReload = false) {
    this.transformTools.objectsChanged(objects, replace, forceReload);
    if (replace) for (const id of this.objects.keys()) this.removeObject(id, true);
    for (const object of objects) {
      if (![object.x, object.y, object.z, object.yaw, object.pitch, object.roll].every(Number.isFinite)) continue;
      const existing = this.objects.get(object.id);
      if (!forceReload && existing && this.sameAppearance(existing.object, object)) {
        existing.object = object; existing.root.userData.worldObject = object; continue;
      }
      const wasSelected = this.selectedIds.has(object.id);
      this.removeObject(object.id, true);
      const root = new THREE.Group();
      root.position.set(object.x, object.y, object.z);
      root.rotation.set(object.pitch, object.yaw, object.roll, 'YXZ');
      root.userData.worldObject = object;
      const entry: ObjectEntry = { object, root, actions: parseActions(object.action), solid: true, ready: false };
      this.objects.set(object.id, entry); this.scene.add(root);
      if (object.model.startsWith('wayfarer:')) {
        const model = makeDemoModel(object.model.slice(9), object.data); root.add(model); entry.ready = true; this.applyActions(entry); this.collisionDirty = true;
        if (wasSelected) this.updateSelectionHighlight(object.id);
      } else {
        const marker = this.placeholder(); root.add(marker);
        if (wasSelected) this.updateSelectionHighlight(object.id);
        const generation = this.generation;
        this.loadRwx(object.model).then(model => {
          if (this.disposed || generation !== this.generation || this.objects.get(object.id) !== entry) return;
          const mesh = 'format' in model && model.format === 'x'
            ? createDirectXInstance(model, { wireframe: this.wireframe, loadTexture: name => this.loadTexture(name), isActive: () => generation === this.generation && !this.disposed }).root
            : this.createRwxMesh(model as RwxModel, generation);
          root.remove(marker); disposeTree(marker);
          root.add(mesh); root.userData.modelWarnings = mesh.userData.directXWarnings ?? mesh.userData.rwxWarnings ?? [];
          entry.ready = true; this.applyActions(entry); this.collisionDirty = true;
          if (this.selectedIds.has(object.id)) this.updateSelectionHighlight(object.id);
          this.transformTools.sync();
        }).catch(error => {
          if (this.disposed || generation !== this.generation || this.objects.get(object.id) !== entry) return;
          marker.userData.loadError = String(error); this.options.onAction?.({ type: 'asset-error', value: `${object.model}: ${String(error)}`, object });
        });
      }
    }
    this.setSelection([...this.selectedIds], this.selectedId);
    this.syncStudioTerrainBase();
    this.collisionDirty = true;
    this.collectUnusedTextures();
  }
  private sameAppearance(a: WorldObject, b: WorldObject) {
    return a.model === b.model && a.data === b.data && a.action === b.action && a.description === b.description && a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw && a.pitch === b.pitch && a.roll === b.roll;
  }
  deleteObject(id: number) { this.transformTools.objectDeleted(id); this.removeObject(id); this.transformTools.sync(); }
  /** Unload streamed-out data, without manufacturing an authoritative deletion.
   * Shared object-path textures remain cache-owned; exclusively owned maps and
   * all per-node geometry/materials are released. Late callbacks see disposed. */
  unloadSceneData(objectIds: readonly number[], terrainPages: readonly { pageX: number; pageZ: number }[]) {
    if (this.disposed) return;
    for (const id of new Set(objectIds)) if (Number.isSafeInteger(id)) { this.transformTools.objectDeleted(id); this.removeObject(id); }
    const pages = new Set(terrainPages.filter(page => Number.isSafeInteger(page.pageX) && Number.isSafeInteger(page.pageZ)).map(page => `${page.pageX},${page.pageZ}`));
    this.terrainTools.unload(terrainPages);
    const removed: TerrainTile[] = [];
    for (const [key, mesh] of this.terrain) {
      const tile = mesh.userData.terrainTile as TerrainTile;
      if (!pages.has(`${tile.pageX},${tile.pageZ}`)) continue;
      removed.push(tile);
      this.scene.remove(mesh); disposeTree(mesh, true); this.terrain.delete(key);
    }
    this.rebuildTerrainEdges(removed); this.syncStudioTerrainBase();
    if (this.ground) this.ground.visible = this.terrain.size === 0 && Boolean(this.settings?.terrainEnabled);
    this.collisionDirty = true; this.refreshCollisions(); this.transformTools.sync(); this.collectUnusedTextures();
  }
  private removeObject(id: number, preserveSelection = false) {
    const entry = this.objects.get(id); if (!entry) return;
    this.scene.remove(entry.root);
    // Procedural models own their generated textures; downloaded textures have a shared cache.
    disposeTree(entry.root, entry.object.model.startsWith('wayfarer:'));
    this.objects.delete(id); this.bumpContacts.forget(id); this.collisionDirty = true;
    if (!preserveSelection) {
      this.selectedIds.delete(id); this.removeSelectionHighlight(id);
      if (this.selectedId === id) {
        this.selectedId = this.selectedIds.values().next().value ?? null;
        if (this.selectedId !== null) this.updateSelectionHighlight(this.selectedId);
      }
    }
  }
  private disposeTexture(texture: THREE.Texture) {
    texture.dispose(); if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) texture.image.close();
  }
  private collectUnusedTextures(force = false) {
    if (!force && this.textureResources.size < 128) return;
    const used = new Set<THREE.Texture>();
    this.scene.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) used.add(value);
      }
    });
    const now = performance.now();
    for (const texture of this.textureResources) {
      // Recently loaded textures may still be awaiting their material promise callback.
      if (used.has(texture) || (!force && now - Number(texture.userData.createdAt) < 10000)) continue;
      this.disposeTexture(texture); this.textureResources.delete(texture); this.textures.delete(texture.userData.cacheKey);
    }
  }

  private placeholder() {
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: '#bd879b', transparent: true, opacity: 0.25, wireframe: true });
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material); cube.position.y = 0.5; group.add(cube);
    return group;
  }
  private loadRwx(name: string) {
    const key = `${this.settings?.objectPath}|${name}`;
    let pending = this.parsedModels.get(key);
    if (!pending) {
      const urls = assetUrls(this.settings?.objectPath ?? '', name, 'models');
      const generation = this.generation;
      pending = this.queue.run(async () => {
        if (this.disposed || generation !== this.generation) throw new Error('World changed before loading model');
        const downloaded = await firstAvailable(this.options.asset, urls);
        const decoded = await decodeModelAsset(downloaded.bytes, name, downloaded.url);
        if (this.disposed || generation !== this.generation) throw new Error('World changed while loading model');
        return decoded.format === 'x' ? parseDirectX(decoded.source) : parseRwx(decoded.source);
      });
      this.parsedModels.set(key, pending);
      if (this.parsedModels.size > 256) this.parsedModels.delete(this.parsedModels.keys().next().value!);
    }
    return pending;
  }
  private loadTexture(name: string, source?: { path: string; fetcher: AssetFetcher }): Promise<THREE.Texture> {
    const path = source?.path ?? this.settings?.objectPath ?? '', fetcher = source?.fetcher ?? this.options.asset;
    const key = `${path}|${name}`;
    const generation = this.generation;
    let pending = this.textures.get(key);
    if (!pending) {
      const urls = assetUrls(path, name, 'textures');
      pending = this.queue.run(async () => {
        if (this.disposed || generation !== this.generation) throw new Error('World changed before loading texture');
        const raw = await firstAvailable(fetcher, urls);
        const decoded = unpackAsset(raw.bytes, 'texture');
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(decoded.bytes).buffer]), { imageOrientation: 'flipY' });
        if (this.disposed || generation !== this.generation) { bitmap.close(); throw new Error('World changed while loading texture'); }
        if (bitmap.width > 8192 || bitmap.height > 8192) { bitmap.close(); throw new Error('Texture exceeds 8192 pixels'); }
        const texture = new THREE.Texture(bitmap); texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.userData.sharedAsset = true; texture.userData.cacheKey = key; texture.userData.createdAt = performance.now();
        texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy()); texture.needsUpdate = true;
        this.textureResources.add(texture); return texture;
      });
      this.textures.set(key, pending);
    }
    return pending;
  }
  private createRwxMesh(model: RwxModel, generation: number, source?: { path: string; fetcher: AssetFetcher }) {
    return createRwxGroup(model, { wireframe: this.wireframe, loadTexture: name => this.loadTexture(name, source), isActive: () => generation === this.generation && !this.disposed });
  }

  private applyActions(entry: ObjectEntry) {
    const generation = this.generation;
    entry.root.traverse(node => { if (node instanceof THREE.Mesh) for (const m of Array.isArray(node.material) ? node.material : [node.material]) if ('wireframe' in m) m.wireframe = this.wireframe; });
    for (const action of entry.actions.filter(action => action.trigger === 'create')) {
      const args = action.args;
      switch (action.command) {
        case 'solid': entry.solid = !/^(off|no|false)$/i.test(args[0] ?? ''); break;
        case 'visible': entry.root.visible = !/^(off|no|false)$/i.test(args[0] ?? ''); break;
        case 'name': entry.root.name = args[0] ?? ''; break;
        case 'scale': {
          const values = args.slice(0, 3).map(Number); if (!values.length || !values.every(Number.isFinite)) break;
          entry.root.scale.set(values[0], values[1] ?? values[0], values[2] ?? values[0]); break;
        }
        case 'rotate': {
          const values = args.slice(0, 3).map(Number); if (values.length === 3 && values.every(Number.isFinite)) entry.rotation = new THREE.Vector3(values[0], values[1], values[2]).multiplyScalar(Math.PI / 180); break;
        }
        case 'color': {
          const color = actionColor(args); if (!color) break;
          entry.root.traverse(node => { if (node instanceof THREE.Mesh) for (const m of Array.isArray(node.material) ? node.material : [node.material]) if ('color' in m && m.color instanceof THREE.Color) m.color.set(color); }); break;
        }
        case 'opacity': {
          const opacity = Math.max(0, Math.min(1, Number(args[0]))); if (!Number.isFinite(opacity)) break;
          entry.root.traverse(node => { if (node instanceof THREE.Mesh) for (const m of Array.isArray(node.material) ? node.material : [node.material]) { m.opacity = opacity; m.transparent = opacity < 1; m.needsUpdate = true; } }); break;
        }
        case 'texture': {
          if (!args[0]) break;
          entry.root.traverse(node => { if (node instanceof THREE.Mesh) for (const m of Array.isArray(node.material) ? node.material : [node.material]) m.userData.textureOverride = true; });
          this.loadTexture(args[0]).then(texture => {
            if (this.disposed || generation !== this.generation || this.objects.get(entry.object.id) !== entry) return;
            entry.root.traverse(node => { if (node instanceof THREE.Mesh) for (const m of Array.isArray(node.material) ? node.material : [node.material]) if ('map' in m) { m.map = texture; m.needsUpdate = true; } });
          }).catch(() => {}); break;
        }
      }
    }
    entry.root.updateMatrixWorld(true);
    // Download/edit completion underneath an avatar is not a fresh collision.
    if (entry.actions.some(action => action.trigger === 'bump' && action.command === 'teleport')) this.bumpContacts.suppress(entry.object.id);
  }

  setTerrain(tile: TerrainTile) {
    if (this.disposed || !this.terrainTools.putTile(tile)) return;
    const key = terrainKey(tile); tile = this.terrainTools.data.tiles.get(key)!;
    const mesh = this.createTerrainMesh(tile, this.terrainTools.data.heightAt);
    const previous = this.terrain.get(key); if (previous) { this.scene.remove(previous); disposeTree(previous, true); }
    const newUnsupported = (mesh.userData.terrainUnsupportedValues as number[]).filter(value => !this.warnedTerrainValues.has(value));
    if (newUnsupported.length && this.warnedTerrainValues.size < 32) {
      newUnsupported.forEach(value => this.warnedTerrainValues.add(value));
      this.options.onAction?.({ type: 'asset-error', value: `Terrain uses unsupported extended texture codes: ${newUnsupported.slice(0, 8).join(', ')}` });
    }
    this.terrain.set(key, mesh); this.scene.add(mesh); this.rebuildTerrainEdges([tile]); this.collisionDirty = true;
    if (this.ground) this.ground.visible = false;
    this.syncStudioTerrainBase();
  }
  private createTerrainMesh(tile: TerrainTile, heightAt: TerrainHeightLookup) {
    const surface = terrainSurface(tile, heightAt);
    // Original studio-only swatches, not substitutes for a world's missing images.
    const studioColors = ['#688c65', '#c6b182', '#8d9693', '#826b52'];
    const materials = surface.textureIds.map(index => new THREE.MeshStandardMaterial({ color: this.settings?.demo ? studioColors[index] ?? studioColors[0] : '#7d936a', roughness: 1, wireframe: this.wireframe }));
    const mesh = new THREE.Mesh(surface.geometry, materials);
    mesh.visible = this.settings?.terrainEnabled ?? true;
    mesh.userData.terrainTile = tile; mesh.userData.terrainTextureIds = surface.textureIds; mesh.userData.terrainUnsupportedValues = surface.unsupportedValues;
    this.applyTerrainTextures(mesh); mesh.position.y = terrainElevation(this.settings);
    mesh.receiveShadow = true; mesh.updateMatrixWorld(); return mesh;
  }
  private rebuildTerrainEdges(changed: readonly TerrainTile[]) {
    for (const mesh of this.terrain.values()) {
      const tile = mesh.userData.terrainTile as TerrainTile;
      if (!changed.some(value => sharesTerrainEdge(tile, value))) continue;
      const surface = terrainSurface(tile, this.terrainTools.data.heightAt);
      mesh.geometry.dispose(); mesh.geometry = surface.geometry;
    }
    this.collisionDirty = true;
  }
  private applyTerrainTextures(mesh: THREE.Mesh) {
    if (!this.settings?.objectPath) return;
    const generation = this.generation;
    const materials = mesh.material as THREE.MeshStandardMaterial[];
    for (const [i, textureId] of (mesh.userData.terrainTextureIds as number[]).entries()) {
      const material = materials[i];
      this.loadTexture(terrainTextureName(textureId)).then(texture => {
        if (this.disposed || generation !== this.generation || material.userData.disposed) return;
        material.map = texture; material.color.set('#ffffff'); material.needsUpdate = true;
      }).catch(() => { /* Keep a readable ground color when the object path has no terrain textures. */ });
    }
  }

  setAvatar(avatar: Avatar) {
    if (this.disposed || ![avatar.x, avatar.y, avatar.z, avatar.yaw].every(Number.isFinite)) return;
    const current = this.avatars.get(avatar.session);
    if (current && current.avatar.type === avatar.type && current.avatar.name === avatar.name) {
      // Axis repeats this value on movement packets, without a gesture serial number.
      if (current.avatar.gesture !== avatar.gesture) {
        this.clearGesture(current); this.clearAvatarSequence(current);
        if (Number.isInteger(avatar.gesture) && avatar.gesture > 0 && avatar.gesture <= 255) this.beginGesture(current, avatar.gesture);
      }
      if (current.target.distanceToSquared(new THREE.Vector3(avatar.x, avatar.y, avatar.z)) > 0.0025) current.movingUntil = performance.now() + 250;
      current.avatar = { ...avatar }; current.target.set(avatar.x, avatar.y, avatar.z); return;
    }
    if (current) this.deleteAvatar(avatar.session);
    const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
    const colors = ['#416b66', '#b87b51', '#7b7799', '#a46865', '#809456'];
    const clothing = new THREE.MeshStandardMaterial({ color: colors[Math.abs(avatar.type) % colors.length], roughness: 0.9 });
    const skin = new THREE.MeshStandardMaterial({ color: '#d5ab87', roughness: 0.9 });
    const trousers = new THREE.MeshStandardMaterial({ color: '#39484a', roughness: 1 });
    const part = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z = 0) => { const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z); mesh.castShadow = true; body.add(mesh); };
    part(new THREE.CapsuleGeometry(0.23, 0.42, 4, 12), clothing, 0, 1.13);
    part(new THREE.SphereGeometry(0.18, 16, 12), skin, 0, 1.71);
    for (const x of [-0.12, 0.12]) part(new THREE.CapsuleGeometry(0.085, 0.58, 4, 8), trousers, x, 0.4);
    for (const x of [-0.31, 0.31]) part(new THREE.CapsuleGeometry(0.075, 0.47, 4, 8), clothing, x, 1.08);
    const name = this.nameLabel(avatar.name); name.position.y = 2.15; root.add(name);
    root.position.set(avatar.x, avatar.y, avatar.z); root.rotation.y = avatar.yaw;
    const entry: AvatarEntry = { avatar: { ...avatar }, root, body, target: root.position.clone(), sequenceStarted: 0, sequenceVersion: 0, movingUntil: 0 };
    this.avatars.set(avatar.session, entry); this.scene.add(root); this.loadAvatarBody(entry);
    if (Number.isInteger(avatar.gesture) && avatar.gesture > 0 && avatar.gesture <= 255) this.beginGesture(entry, avatar.gesture);
  }
  private avatarSource() {
    return this.settings?.demo === true ? { path: STUDIO_AVATAR_PATH, fetcher: fetchStudioAvatarAsset } : { path: this.settings?.objectPath, fetcher: this.options.asset };
  }
  private clearAvatarSequence(entry: AvatarEntry) {
    const hadWarnings = Boolean(entry.sequence?.warnings.length);
    entry.sequenceVersion++; entry.sequence = undefined; entry.sequenceName = undefined;
    if (entry.rig) { applyRigPose(entry.rig, new Map()); entry.rig.root.visible = true; entry.body.visible = false; }
    if (hadWarnings) this.avatarMotionWarning(entry);
    this.animateFallbackAvatar(entry, performance.now(), false);
  }
  private clearGesture(entry: AvatarEntry) {
    if (entry.gestureTimer !== undefined) clearTimeout(entry.gestureTimer);
    entry.gestureTimer = undefined; entry.gesture = undefined;
  }
  private gestureState(entry: AvatarEntry, state: GesturePlaybackState) {
    if (entry.avatar.session === this.localAvatarSession) this.options.onGestureState?.(state);
  }
  private beginGesture(entry: AvatarEntry, index: number, requestId = ++this.gestureRequest) {
    this.clearGesture(entry);
    const now = performance.now();
    entry.gesture = { index, requestId, requestedAt: now, deadline: now + AVATAR_GESTURE_LIMITS.loadMs, phase: 'loading' };
    this.scheduleGestureEnd(entry, AVATAR_GESTURE_LIMITS.loadMs, 'timeout');
    this.gestureState(entry, { gesture: index, requestId, phase: 'loading' });
  }
  private scheduleGestureEnd(entry: AvatarEntry, duration: number, reason: 'completed' | 'timeout') {
    if (entry.gestureTimer !== undefined) clearTimeout(entry.gestureTimer);
    const requestId = entry.gesture!.requestId;
    entry.gestureTimer = setTimeout(() => {
      if (!this.disposed && this.avatars.get(entry.avatar.session) === entry && entry.gesture?.requestId === requestId) this.finishGesture(entry, reason);
    }, duration);
  }
  private finishGesture(entry: AvatarEntry, reason: NonNullable<GesturePlaybackState['reason']>, message?: string) {
    const gesture = entry.gesture;
    if (!gesture) return;
    this.clearGesture(entry); this.clearAvatarSequence(entry);
    if (entry.avatar.session === this.localAvatarSession) { this.localGesture = 0; entry.avatar = { ...entry.avatar, gesture: 0 }; }
    const error = reason === 'timeout' || reason === 'unavailable' || reason === 'invalid';
    this.gestureState(entry, { gesture: gesture.index, requestId: gesture.requestId, phase: error ? 'error' : 'idle', reason, ...(message ? { message } : error ? { message: reason === 'timeout' ? 'Gesture loading or playback exceeded its time limit.' : 'This avatar gesture could not be played.' } : {}) });
  }
  private cancelLocalGesture(reason: NonNullable<GesturePlaybackState['reason']>) {
    const local = this.avatars.get(this.localAvatarSession);
    if (local) this.finishGesture(local, reason);
    this.localGesture = 0;
  }
  private refreshAvatarCatalog() {
    this.cancelLocalGesture('asset-changed');
    this.avatarCatalog = { version: 0, entries: [], warnings: [] };
    this.avatarRigs.clear(); this.avatarSequences.clear(); this.options.onAvatarCatalog?.(this.avatarCatalog);
    for (const entry of this.avatars.values()) {
      if (entry.rig) { entry.root.remove(entry.rig.root); disposeTree(entry.rig.root, true); entry.rig = undefined; }
      this.clearGesture(entry); this.clearAvatarSequence(entry);
      entry.definition = undefined; entry.body.visible = true;
      delete entry.root.userData.avatarAssetError; delete entry.root.userData.avatarSequenceError;
    }
    const { path, fetcher } = this.avatarSource(), generation = this.generation;
    this.avatarCatalogStatus = path ? 'loading' : 'unavailable';
    if (!path) return;
    this.queue.run(() => loadAvatarCatalog(path, fetcher)).then(catalog => {
      if (this.disposed || generation !== this.generation) return;
      this.avatarCatalog = catalog; this.avatarCatalogStatus = 'ready'; this.options.onAvatarCatalog?.(catalog);
      for (const entry of this.avatars.values()) this.loadAvatarBody(entry);
    }).catch(error => {
      if (this.disposed || generation !== this.generation) return;
      this.avatarCatalogStatus = 'unavailable';
      this.options.onAvatarCatalog?.({ version: 0, entries: [], warnings: [`Avatar catalog unavailable; using original fallback figures. ${String(error)}`] });
    });
  }
  private loadAvatarBody(entry: AvatarEntry) {
    const definition = this.avatarCatalog.entries.find(avatar => avatar.index === entry.avatar.type);
    const { path, fetcher } = this.avatarSource(), generation = this.generation;
    if (!path || !definition?.geometry || entry.definition === definition) return;
    entry.definition = definition;
    this.avatarAssetState(entry, { status: 'loading', warnings: [] });
    let pending = this.avatarRigs.get(definition.geometry);
    if (!pending) {
      pending = this.queue.run(() => {
        if (this.disposed || generation !== this.generation) throw new Error('World changed before loading avatar');
        return loadAvatarModel(path, definition.geometry!, fetcher);
      });
      this.avatarRigs.set(definition.geometry, pending);
      if (this.avatarRigs.size > 128) this.avatarRigs.delete(this.avatarRigs.keys().next().value!);
    }
    pending.then(template => {
      if (this.disposed || generation !== this.generation || this.avatars.get(entry.avatar.session) !== entry || entry.definition !== definition) return;
      let rig: RuntimeAvatarRig;
      if (template.format === 'x') {
        rig = createDirectXInstance(template, { jointName: directXJointName, wireframe: this.wireframe,
          loadTexture: name => this.loadTexture(name, { path, fetcher }), isActive: () => generation === this.generation && !this.disposed });
      } else {
        if (!template.parts.some(({ part }) => part.positions.length)) throw new Error('Avatar geometry has no supported faces');
        rig = cloneAvatarRig(template);
        for (const { part, parent } of rig.parts) parent.add(this.createRwxMesh({ parts: [part], warnings: [] }, generation, { path, fetcher }));
      }
      if (entry.rig) { entry.root.remove(entry.rig.root); disposeTree(entry.rig.root, true); }
      entry.rig = rig; entry.root.add(rig.root); entry.body.visible = false;
      entry.root.userData.avatarAssetWarnings = rig.warnings; delete entry.root.userData.avatarAssetError;
      this.avatarAssetState(entry, { status: 'ready', format: template.format, warnings: rig.warnings });
    }).catch(error => {
      if (this.disposed || generation !== this.generation || this.avatars.get(entry.avatar.session) !== entry) return;
      entry.body.visible = true;
      entry.root.userData.avatarAssetError = String(error);
      this.avatarAssetState(entry, { status: 'fallback', warnings: [], message: String(error) });
    });
  }
  private avatarAssetState(entry: AvatarEntry, state: Pick<AvatarAssetState, 'status' | 'warnings' | 'format' | 'message'>) {
    if (this.disposed || this.avatars.get(entry.avatar.session) !== entry) return;
    this.options.onAvatarAssetState?.({ ...state, session: entry.avatar.session, local: entry.avatar.session === this.localAvatarSession,
      type: entry.avatar.type, geometry: entry.definition?.geometry ?? '' });
  }
  private avatarMotionWarning(entry: AvatarEntry, message?: string) {
    if (!entry.rig) return;
    this.avatarAssetState(entry, { status: 'ready', format: 'format' in entry.rig ? 'x' : 'rwx',
      warnings: [...entry.rig.warnings, ...(entry.sequence?.warnings ?? []), ...(message ? [message] : [])], message });
  }
  private animateAvatar(entry: AvatarEntry, time: number, moving: boolean) {
    if (entry.gesture && time >= entry.gesture.deadline) this.finishGesture(entry, entry.gesture.phase === 'loading' ? 'timeout' : 'completed');
    if (entry.gesture && (this.avatarCatalogStatus === 'unavailable' || (this.avatarCatalogStatus === 'ready' && !entry.definition?.explicit[entry.gesture.index - 1]?.sequence.trim()) || entry.root.userData.avatarAssetError)) {
      this.finishGesture(entry, 'unavailable', 'The selected avatar has no playable sequence for this gesture.');
    }
    if (!entry.rig || !entry.definition) {
      this.animateFallbackAvatar(entry, time, moving);
      return;
    }
    const definition = entry.definition;
    const gesture = entry.gesture ? definition.explicit[entry.gesture.index - 1] : undefined;
    const idle = definition.implicit.idle || definition.implicit.wait;
    const locomotion = moving ? definition.implicit.walk || definition.implicit.run || idle : idle;
    const name = gesture?.sequence || locomotion;
    if (name !== entry.sequenceName) {
      this.clearAvatarSequence(entry);
      entry.sequenceName = name; entry.sequenceStarted = time;
      entry.rig.root.visible = true; entry.body.visible = false;
      applyRigPose(entry.rig, new Map());
      if (name) {
        const generation = this.generation, version = entry.sequenceVersion, gestureRequest = entry.gesture?.requestId;
        const { path, fetcher } = this.avatarSource();
        let pending = this.avatarSequences.get(name);
        if (!pending) {
          pending = this.queue.run(() => {
            if (!path || this.disposed || generation !== this.generation) throw new Error('World changed before loading sequence');
            return loadAvatarSequence(path, name, fetcher);
          });
          this.avatarSequences.set(name, pending);
          if (this.avatarSequences.size > 256) this.avatarSequences.delete(this.avatarSequences.keys().next().value!);
        }
        pending.then(sequence => {
          if (this.disposed || generation !== this.generation || this.avatars.get(entry.avatar.session) !== entry || entry.sequenceVersion !== version) return;
          if (gestureRequest !== undefined && entry.gesture?.requestId !== gestureRequest) return;
          if (entry.gesture && performance.now() >= entry.gesture.deadline) { this.finishGesture(entry, 'timeout'); return; }
          if (gestureRequest !== undefined && (!Number.isFinite(sequence.durationMs) || sequence.durationMs <= 0 || sequence.durationMs > AVATAR_GESTURE_LIMITS.playbackMs)) {
            this.finishGesture(entry, 'unavailable', 'Gesture duration must be between zero and 60 seconds.'); return;
          }
          if (!entry.rig || !sequence.joints.some(joint => entry.rig!.joints.has(joint.name) && (joint.rotations.length > 0 || !!joint.translations?.length))) {
            entry.root.userData.avatarSequenceError = 'This sequence has no animation tracks mapped to the avatar joints.';
            if (entry.gesture) this.finishGesture(entry, 'unavailable', 'This gesture has no animation tracks mapped to the selected avatar.');
            else this.avatarMotionWarning(entry, 'This motion has no tracks affecting the avatar; its reference pose is shown.');
            return;
          }
          // A pelvis-only translation (including one carried by matrix keys)
          // is suppressed by the sampler below. Do not claim visible gesture
          // playback merely because those keys exist. Neutral implicit idle
          // clips remain valid, and authored nonidentity static poses count.
          if (entry.gesture && !sequence.joints.some(joint => entry.rig!.joints.has(joint.name) && (
            joint.rotations.some(key => Math.hypot(key.rotation.x, key.rotation.y, key.rotation.z) > 1e-8) ||
            (joint.name !== sequence.rootJoint && joint.translations?.some(key => key.value.lengthSq() > 1e-16))
          ))) {
            const message = 'This gesture has no visible pose changes on the selected avatar; root motion is disabled.';
            entry.root.userData.avatarSequenceError = message;
            this.finishGesture(entry, 'unavailable', message);
            this.avatarMotionWarning(entry, message);
            return;
          }
          delete entry.root.userData.avatarSequenceError;
          entry.sequence = sequence; entry.sequenceStarted = performance.now();
          this.avatarMotionWarning(entry);
          if (entry.gesture) {
            entry.gesture.phase = 'playing'; entry.gesture.deadline = entry.sequenceStarted + sequence.durationMs;
            this.scheduleGestureEnd(entry, sequence.durationMs, 'completed');
            this.gestureState(entry, { gesture: entry.gesture.index, requestId: entry.gesture.requestId, phase: 'playing' });
          }
        }).catch(error => {
          if (this.avatarSequences.get(name) === pending) this.avatarSequences.delete(name);
          if (this.disposed || generation !== this.generation || this.avatars.get(entry.avatar.session) !== entry || entry.sequenceVersion !== version) return;
          entry.root.userData.avatarSequenceError = String(error);
          if (entry.gesture) {
            const detail = error instanceof Error && /^DirectX(?: animation| MSZIP)?:/.test(error.message) ? ` ${error.message.slice(0, 400)}` : '';
            const message = `The gesture animation could not be loaded.${detail}`;
            this.finishGesture(entry, 'unavailable', message);
            this.avatarMotionWarning(entry, message);
            return;
          }
          if (entry.rig) {
            applyRigPose(entry.rig, new Map()); entry.rig.root.visible = true; entry.body.visible = false;
            this.avatarMotionWarning(entry, 'Avatar motion could not be loaded; its reference pose is shown.');
          } else entry.body.visible = true;
        });
      }
    }
    if (entry.sequence) {
      const elapsed = time - entry.sequenceStarted;
      applyRigPose(entry.rig, sampleAvatarSequence(entry.sequence, elapsed, { loop: !gesture, rootMotion: false }));
    }
    if (entry.body.visible) this.animateFallbackAvatar(entry, time, moving);
  }
  private animateFallbackAvatar(entry: AvatarEntry, time: number, moving: boolean) {
    const stride = moving ? Math.sin(time * 0.011) * 0.35 : 0;
    entry.body.children[2].rotation.x = stride; entry.body.children[3].rotation.x = -stride;
    entry.body.children[4].rotation.x = -stride * 0.7; entry.body.children[5].rotation.x = stride * 0.7;
    // An unavailable Bow, Dance, etc. must not silently become an endless fake wave.
    entry.body.children[5].rotation.z = 0;
  }
  deleteAvatar(session: number) { const entry = this.avatars.get(session); if (entry) { this.finishGesture(entry, 'avatar-changed'); this.clearGesture(entry); this.scene.remove(entry.root); disposeTree(entry.root, true); this.avatars.delete(session); } }
  private nameLabel(name: string) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96;
    const ctx = canvas.getContext('2d')!; ctx.font = '500 34px system-ui'; ctx.textAlign = 'center';
    const width = Math.min(490, ctx.measureText(name).width + 40);
    ctx.fillStyle = 'rgba(21, 43, 37, 0.74)'; ctx.beginPath(); ctx.roundRect((512 - width) / 2, 12, width, 62, 16); ctx.fill();
    ctx.fillStyle = '#fbf8e9'; ctx.fillText(name.slice(0, 32), 256, 55);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true })); sprite.scale.set(2.7, 0.5, 1); return sprite;
  }
  /** User/menu navigation is checked here, not only in the UI. */
  teleport(position: Position): boolean {
    if (this.disposed) return false;
    if (!localTeleportAllowed(this.settings)) {
      this.options.onAction?.({ type: 'teleport-denied', value: LOCAL_TELEPORT_DENIED });
      return false;
    }
    return this.placeAt(position);
  }
  /** Only for trusted protocol positioning, never user-menu navigation. */
  applyServerPosition(position: Position): boolean { return this.placeAt(position); }
  private placeAt(position: Position): boolean {
    if (this.disposed || ![position.x, position.y, position.z].every(value => Number.isFinite(value) && Math.abs(value) <= 21474836.47)
      || ![position.yaw, position.pitch ?? 0].every(value => Number.isFinite(value) && Math.abs(value) <= 2147483647 * Math.PI / 1800)) return false;
    this.transformTools.cancel();
    this.stopCameraDrag();
    this.keys.clear(); this.bumpContacts.reset(performance.now());
    this.position = { ...position, pitch: position.pitch ?? 0 }; this.updateCamera(); this.options.onPosition(this.getPosition());
    return true;
  }

  private listen(target: EventTarget, name: string, callback: EventListener, options?: AddEventListenerOptions) {
    target.addEventListener(name, callback, options); this.listeners.push(() => target.removeEventListener(name, callback, options));
  }
  private stopCameraDrag(pointerId?: number) {
    if (pointerId !== undefined && pointerId !== this.cameraPointer) return;
    const pointer = this.cameraPointer; this.cameraPointer = null; this.dragging = false;
    if (pointer !== null && this.canvas.hasPointerCapture?.(pointer)) this.canvas.releasePointerCapture(pointer);
  }
  private installControls() {
    this.listen(this.canvas, 'contextmenu', event => event.preventDefault());
    this.listen(this.canvas, 'pointerdown', event => {
      const e = event as PointerEvent; this.canvas.focus(); this.pointerStart = { x: e.clientX, y: e.clientY };
      if (!this.terrainTools.active && this.transformTools.pointerDown(e)) return;
      if (e.button === 2 && this.cameraPointer === null) { this.dragging = true; this.cameraPointer = e.pointerId; this.canvas.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    this.listen(this.canvas, 'pointermove', event => {
      const e = event as PointerEvent;
      if (this.transformTools.pointerMove(e)) return;
      if ((this.dragging && e.pointerId === this.cameraPointer) || document.pointerLockElement === this.canvas) {
        this.position.yaw -= e.movementX * 0.003;
        this.position.pitch = Math.max(-1.45, Math.min(1.45, (this.position.pitch ?? 0) - e.movementY * 0.003));
      }
    });
    this.listen(this.canvas, 'pointerup', event => {
      const e = event as PointerEvent;
      if (this.transformTools.pointerUp(e)) return;
      if (e.button === 2) this.stopCameraDrag(e.pointerId);
      if (e.button === 0 && Math.hypot(e.clientX - this.pointerStart.x, e.clientY - this.pointerStart.y) < 5) {
        if (this.terrainTools.active) this.terrainTools.selectAt(e.clientX, e.clientY);
        else this.selectAt(e.clientX, e.clientY, e.shiftKey);
      }
    });
    this.listen(this.canvas, 'pointercancel', event => { this.transformTools.pointerCancelled(event as PointerEvent); this.stopCameraDrag((event as PointerEvent).pointerId); });
    this.listen(this.canvas, 'lostpointercapture', event => { this.transformTools.pointerCancelled(event as PointerEvent); this.stopCameraDrag((event as PointerEvent).pointerId); });
    this.listen(this.canvas, 'dblclick', () => { if (!this.buildMode && !this.terrainTools.active && this.canvas.requestPointerLock) { const result = this.canvas.requestPointerLock(); if (result && typeof result.catch === 'function') result.catch(() => {}); } });
    this.listen(window, 'keydown', event => {
      const e = event as KeyboardEvent;
      // Command can swallow the movement key's keyup on macOS. A shortcut
      // starts a new input boundary, even if focus has already left the canvas.
      if (shortcutModifier(e)) { this.keys.clear(); return; }
      if (e.code === 'Escape' && this.terrainTools.previewing) { e.preventDefault(); this.terrainTools.cancelPreview('disabled'); this.keys.clear(); return; }
      if (e.code === 'Escape' && this.transformTools.busy) { e.preventDefault(); this.transformTools.cancel(); this.keys.clear(); return; }
      if (document.activeElement !== this.canvas && document.pointerLockElement !== this.canvas) return;
      if (movementKeys.has(e.code)) {
        // Do not resume a key held across a shortcut, blur or pointer unlock.
        // Movement requires a fresh press after those cancellation boundaries.
        if (e.repeat && !this.keys.has(e.code)) return;
        e.preventDefault();
        if (this.transformTools.busy) return;
        if (['Space', 'PageUp', 'PageDown'].includes(e.code) && !flightAllowed(this.settings)) {
          if (!e.repeat) this.setFlying(true);
          return;
        }
        this.keys.add(e.code);
        if (e.code === 'KeyF' && !e.repeat) this.setFlying(!this.fly);
      }
    });
    this.listen(window, 'keyup', event => {
      const e = event as KeyboardEvent;
      if (shortcutModifier(e)) this.keys.clear();
      else this.keys.delete(e.code);
    });
    this.listen(window, 'blur', () => { this.keys.clear(); this.stopCameraDrag(); this.transformTools.cancel(); });
    this.listen(this.canvas, 'blur', () => { this.keys.clear(); this.stopCameraDrag(); });
    this.listen(document, 'pointerlockchange', () => { if (document.pointerLockElement !== this.canvas) this.keys.clear(); });
    this.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') { this.keys.clear(); this.stopCameraDrag(); this.transformTools.cancel(); }
    });
  }
  private selectAt(x: number, y: number, additive = false) {
    if (this.disposed || this.transformTools.busy || (!this.navigationActionsEnabled && !this.buildMode)) return;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = document.pointerLockElement === this.canvas ? new THREE.Vector2() : new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1);
    this.ray.setFromCamera(pointer, this.camera); this.ray.far = 300;
    const hit = this.ray.intersectObjects([...this.objects.values()].map(entry => entry.root), true)[0];
    let root: THREE.Object3D | null = hit?.object ?? null;
    while (root && !root.userData.worldObject) root = root.parent;
    const object = root?.userData.worldObject as WorldObject | undefined;
    if (this.buildMode) {
      if (!additive) this.setSelected(object?.id ?? null);
      else if (object) {
        const next = new Set(this.selectedIds);
        if (next.has(object.id)) next.delete(object.id); else next.add(object.id);
        this.setSelection([...next], next.has(object.id) ? object.id : undefined);
      }
      this.options.onSelect(object ?? null, { additive }); return;
    }
    if (!object) return;
    const entry = this.objects.get(object.id);
    this.options.onAction?.({ type: 'click', object });
    if (entry) this.executeNavigationActions(entry, 'activate');
  }
  private actionsAllowed() { return !this.disposed && this.navigationActionsEnabled && !this.buildMode && !this.terrainTools.active && !this.transformTools.busy; }
  private executeNavigationActions(entry: ObjectEntry, trigger: 'activate' | 'bump') {
    const generation = this.generation, object = entry.object;
    for (const action of entry.actions) {
      if (action.trigger !== trigger) continue;
      if (!this.actionsAllowed() || generation !== this.generation || this.objects.get(object.id) !== entry) return;
      // Unsupported conditional ownership must not silently grant navigation.
      if (action.command === 'lock') return;
      if (action.command === 'teleport') {
        const value = action.args.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' '), destination = parseTeleport(value, this.position);
        // Authored activate/bump teleports are expressly exempt from the menu
        // restriction. Keep this bypass private to parsed world-object actions.
        if (!destination) continue;
        // One navigation per activation, no recursive chains or post-travel commands.
        this.keys.clear();
        if (!destination.world || destination.world.toLowerCase() === this.settings?.name.toLowerCase()) this.placeAt(destination.position);
        else this.options.onAction?.({ type: 'teleport', value, object });
        return;
      } else if (trigger === 'activate' && action.command === 'url') this.options.onAction?.({ type: 'url', value: action.args[0], object });
    }
  }

  private refreshCollisions() {
    if (!this.collisionDirty) return;
    this.collisionMeshes = []; this.bumpMeshes = []; this.bumpObjects = [];
    for (const entry of this.objects.values()) if (entry.ready) {
      const bumps = entry.actions.some(action => action.trigger === 'bump' && action.command === 'teleport');
      const meshes: Array<{ mesh: THREE.Mesh; bounds: THREE.Box3 }> = [];
      entry.root.traverse(node => {
        if (!(node instanceof THREE.Mesh)) return;
        if (entry.solid && node.userData.solid !== false) this.collisionMeshes.push(node);
        if (bumps) meshes.push({ mesh: node, bounds: new THREE.Box3().setFromObject(node) }); // Solid off still receives bump.
      });
      if (meshes.length) this.bumpObjects.push({ entry, meshes, bounds: new THREE.Box3().setFromObject(entry.root) });
    }
    for (const mesh of this.terrain.values()) if (mesh.visible || mesh.userData.terrainPreviewHidden) this.collisionMeshes.push(mesh);
    this.collisionMeshes.push(...this.environmentScene.collisionMeshes());
    if (this.ground?.visible) this.collisionMeshes.push(this.ground);
    this.collisionDirty = false;
  }
  private refreshBumpCandidates() {
    this.bumpMeshes = [];
    const origin = new THREE.Vector3(this.position.x, this.position.y + .85, this.position.z);
    const nearby = new THREE.Box3().setFromCenterAndSize(origin, new THREE.Vector3(3, 4, 3));
    const candidates = this.bumpObjects.filter(item => {
      if (item.entry.rotation) {
        item.entry.root.updateMatrixWorld(true); item.bounds.setFromObject(item.entry.root);
        item.meshes.forEach(part => part.bounds.setFromObject(part.mesh));
      }
      return item.bounds.intersectsBox(nearby);
    }).sort((a, b) => a.bounds.distanceToPoint(origin) - b.bounds.distanceToPoint(origin) || a.entry.object.id - b.entry.object.id);
    for (const item of candidates) for (const part of item.meshes) {
      if (!part.bounds.intersectsBox(nearby)) continue;
      this.bumpMeshes.push(part.mesh);
      if (this.bumpMeshes.length >= ACTION_LIMITS.bumpMeshes) return;
    }
  }
  private addBumpHits(contacts: Set<number>, freshDistance = Infinity, respectBlocking = true) {
    if (!this.bumpMeshes.length || contacts.size >= ACTION_LIMITS.contacts) return;
    if (respectBlocking && !this.fly) {
      const blocker = this.ray.intersectObjects(this.collisionMeshes, false)[0];
      if (blocker) this.ray.far = Math.min(this.ray.far, blocker.distance + 0.0001);
    }
    for (const hit of this.ray.intersectObjects(this.bumpMeshes, false)) {
      let root: THREE.Object3D | null = hit.object;
      while (root && !root.userData.worldObject) root = root.parent;
      const object = root?.userData.worldObject as WorldObject | undefined;
      if (object && this.objects.has(object.id) && (hit.distance <= freshDistance || this.bumpContacts.has(object.id))) contacts.add(object.id);
      if (contacts.size >= ACTION_LIMITS.contacts) break;
    }
  }
  private canMove(dx: number, dz: number, contacts?: Set<number>) {
    const distance = Math.hypot(dx, dz);
    if (distance < 0.00001) return true;
    const direction = new THREE.Vector3(dx / distance, 0, dz / distance);
    let allowed = true;
    for (const height of [0.55, 1.5]) {
      this.ray.set(new THREE.Vector3(this.position.x, this.position.y + height, this.position.z), direction); this.ray.near = 0; this.ray.far = distance + 0.32;
      const hit = this.ray.intersectObjects(this.collisionMeshes, false)[0];
      if (hit) allowed = false;
      if (contacts) {
        if (hit && !this.fly) this.ray.far = Math.min(this.ray.far, hit.distance + 0.0001);
        this.addBumpHits(contacts, Infinity, false);
      }
    }
    return allowed;
  }
  private move(dt: number) {
    if (this.transformTools.busy) return;
    this.refreshCollisions();
    this.refreshBumpCandidates();
    const contacts = new Set<number>(), priorY = this.position.y;
    const down = (...keys: string[]) => keys.some(key => this.keys.has(key));
    if (down('ArrowLeft')) this.position.yaw += dt * 1.4;
    if (down('ArrowRight')) this.position.yaw -= dt * 1.4;
    const forward = Number(down('KeyW', 'ArrowUp')) - Number(down('KeyS', 'ArrowDown'));
    const strafe = Number(down('KeyD', 'KeyE')) - Number(down('KeyA', 'KeyQ'));
    const vector = new THREE.Vector2(forward, strafe);
    if (vector.lengthSq() > 1) vector.normalize();
    const speed = (down('ShiftLeft', 'ShiftRight') ? 10 : 4.2) * dt;
    const dx = (Math.sin(this.position.yaw) * vector.x - Math.cos(this.position.yaw) * vector.y) * speed;
    const dz = (Math.cos(this.position.yaw) * vector.x + Math.sin(this.position.yaw) * vector.y) * speed;
    const moveX = this.canMove(dx, 0, contacts); if (this.fly || moveX) this.position.x += dx;
    const moveZ = this.canMove(0, dz, contacts); if (this.fly || moveZ) this.position.z += dz;
    if (flightAllowed(this.settings)) {
      if (down('Space', 'PageUp')) { if (!this.fly) this.setFlying(true); this.position.y += speed; }
      if (down('PageDown')) { if (!this.fly) this.setFlying(true); this.position.y -= speed; }
    }
    if (!this.fly) {
      this.ray.set(new THREE.Vector3(this.position.x, this.position.y + 0.6, this.position.z), new THREE.Vector3(0, -1, 0)); this.ray.near = 0; this.ray.far = 100;
      const hit = this.ray.intersectObjects(this.collisionMeshes, false)[0];
      const inHole = this.settings?.terrainEnabled && [...this.terrain.values()].some(mesh => isTerrainHoleAt(mesh.userData.terrainTile, this.position.x, this.position.z) === true);
      const ground = hit?.point.y ?? (inHole ? this.position.y - 100 : this.settings?.terrainEnabled ? terrainElevation(this.settings) : this.position.y);
      this.position.y += Math.max(-dt * 9.8, Math.min(dt * 7, ground - this.position.y));
    }
    if (this.bumpMeshes.length) {
      // Fixed-size capsule approximation: swept vertical probes plus stationary
      // side/foot/head contacts keep an edge latched while touching a surface.
      const dy = this.position.y - priorY;
      if (Math.abs(dy) > 0.00001) for (const height of [0.05, 1.7]) {
        this.ray.set(new THREE.Vector3(this.position.x, priorY + height, this.position.z), new THREE.Vector3(0, Math.sign(dy), 0)); this.ray.near = 0; this.ray.far = Math.abs(dy) + 0.05; this.addBumpHits(contacts);
      }
      for (const height of [0.55, 1.5]) for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        // A blocked movement can stop up to one frame short of the radius.
        // Retain that existing contact within .85 m, but never create a new
        // stationary contact outside the .325 m capsule approximation.
        this.ray.set(new THREE.Vector3(this.position.x, this.position.y + height, this.position.z), new THREE.Vector3(x, 0, z)); this.ray.near = 0; this.ray.far = 0.85; this.addBumpHits(contacts, .325);
      }
      this.ray.set(new THREE.Vector3(this.position.x, this.position.y + 0.6, this.position.z), new THREE.Vector3(0, -1, 0)); this.ray.near = 0; this.ray.far = 0.65; this.addBumpHits(contacts);
    }
    const bump = this.bumpContacts.update(contacts, performance.now(), this.actionsAllowed());
    if (bump !== undefined) { const entry = this.objects.get(bump); if (entry) this.executeNavigationActions(entry, 'bump'); }
  }
  private updateCamera() {
    this.camera.position.set(this.position.x, this.position.y + eyeHeight, this.position.z);
    this.camera.rotation.set(this.position.pitch ?? 0, Math.PI + this.position.yaw, 0, 'YXZ');
    if (this.cameraMode === 'third-person') {
      const direction = new THREE.Vector3(); this.camera.getWorldDirection(direction);
      this.camera.position.addScaledVector(direction, -5); this.camera.position.y += 1;
    }
    const local = this.avatars.get(this.localAvatarSession);
    if (local) { local.root.position.set(this.position.x, this.position.y, this.position.z); local.target.copy(local.root.position); local.avatar.yaw = this.position.yaw; local.root.rotation.y = this.position.yaw; }
  }
  private animate = (time: number) => {
    if (this.disposed) return;
    const dt = Math.min(0.05, this.lastTime ? (time - this.lastTime) / 1000 : 1 / 60); this.lastTime = time;
    const priorX = this.position.x, priorZ = this.position.z;
    this.move(dt); this.updateCamera();
    const local = this.avatars.get(this.localAvatarSession);
    if (local && Math.hypot(this.position.x - priorX, this.position.z - priorZ) > 0.0001) local.movingUntil = time + 150;
    for (const entry of this.objects.values()) if (entry.rotation && !this.transformTools.previews(entry.object.id)) {
      entry.root.rotation.x += entry.rotation.x * dt; entry.root.rotation.y += entry.rotation.y * dt; entry.root.rotation.z += entry.rotation.z * dt;
    }
    for (const entry of this.avatars.values()) {
      const moving = entry.root.position.distanceToSquared(entry.target) > 0.008 || time < entry.movingUntil;
      entry.root.position.lerp(entry.target, 1 - Math.exp(-dt * 12));
      const difference = Math.atan2(Math.sin(entry.avatar.yaw - entry.root.rotation.y), Math.cos(entry.avatar.yaw - entry.root.rotation.y)); entry.root.rotation.y += difference * Math.min(1, dt * 12);
      this.animateAvatar(entry, time, moving);
    }
    this.environment.follow(this.position);
    for (const [id, helper] of this.selectionHelpers) if (this.objects.get(id)?.rotation) { helper.update(); helper.geometry.computeBoundingBox(); }
    this.environmentScene.render(this.renderer, this.camera, { ambient: this.ambient, hemi: this.hemi, sun: this.sun });
    if (time - this.lastPositionTime > 120) { this.options.onPosition(this.getPosition()); this.lastPositionTime = time; }
    this.frameCount++;
    if (time - this.lastStatsTime > 1000) { this.options.onStats({ fps: Math.round(this.frameCount * 1000 / (time - this.lastStatsTime)), drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles }); this.frameCount = 0; this.lastStatsTime = time; }
    this.frame = requestAnimationFrame(this.animate);
  };

  dispose() {
    if (this.disposed) return;
    this.cancelLocalGesture('disposed');
    this.disposed = true; this.generation++; this.bumpContacts.reset(0, false); this.bumpMeshes = []; this.bumpObjects = []; cancelAnimationFrame(this.frame); this.resizeObserver.disconnect(); this.listeners.forEach(remove => remove());
    this.stopCameraDrag();
    this.transformTools.dispose();
    this.terrainTools.dispose();
    this.environmentScene.dispose();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    for (const id of this.objects.keys()) this.deleteObject(id);
    for (const id of this.avatars.keys()) this.deleteAvatar(id);
    this.terrain.forEach(mesh => disposeTree(mesh, true)); this.terrain.clear();
    if (this.water) disposeTree(this.water, true); if (this.ground) disposeTree(this.ground, true);
    this.textureResources.forEach(texture => this.disposeTexture(texture)); this.textureResources.clear();
    // Keep the canvas context reusable: React StrictMode immediately recreates the engine on it.
    for (const id of this.selectionHelpers.keys()) this.removeSelectionHighlight(id);
    this.selectedIds.clear(); this.selectedId = null;
    this.sun.shadow.dispose(); this.scene.clear(); this.renderer.dispose();
    this.parsedModels.clear(); this.textures.clear();
    this.avatarRigs.clear(); this.avatarSequences.clear();
  }
}
