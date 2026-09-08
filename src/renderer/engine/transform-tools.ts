import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { WorldObject } from '../../shared/types';
import { sameBuildObject } from '../build-history';

export type TransformMode = 'select' | 'translate' | 'rotate';
export type TransformSpace = 'world' | 'local';
export interface TransformChange { before: WorldObject; after: WorldObject }
export interface TransformEntry { object: WorldObject; root: THREE.Group; ready: boolean }
interface Snapshot { before: WorldObject; root: THREE.Group; position: THREE.Vector3; quaternion: THREE.Quaternion }
interface Session {
  snapshots: Snapshot[]; centre: THREE.Vector3; initialQuaternion: THREE.Quaternion;
  primaryId: number | null; space: TransformSpace; axis: string; committing: boolean;
  alignedRotation?: { axis: THREE.Vector3; worldAxis: THREE.Vector3; plane: THREE.Plane; start: THREE.Vector3 };
}
interface TransformOptions {
  entries: () => TransformEntry[];
  /** Selection order is not necessarily primary order. Null disables local axes. */
  primaryId?: () => number | null;
  current: (id: number) => TransformEntry | undefined;
  commit?: (changes: TransformChange[]) => Promise<boolean>;
  changed: () => void;
  started: () => void;
  error: (message: string) => void;
}

const limit = 21474836.47;
const identity = new THREE.Quaternion();
const propertyQuaternion = (object: WorldObject) => new THREE.Quaternion().setFromEuler(new THREE.Euler(object.pitch, object.yaw, object.roll, 'YXZ'));
/** AW property origins in metres; rotations use Three's YXZ Euler convention. */
export function selectionCentre(objects: readonly WorldObject[]): THREE.Vector3 {
  if (!objects.length || objects.length > 256 || new Set(objects.map(o => o.id)).size !== objects.length)
    throw new Error('Choose between 1 and 256 distinct objects.');
  const centre = new THREE.Vector3();
  for (const object of objects) {
    if (![object.x, object.y, object.z, object.pitch, object.yaw, object.roll].every(Number.isFinite))
      throw new Error('An object has an invalid transform.');
    centre.add(new THREE.Vector3(object.x, object.y, object.z));
  }
  return centre.multiplyScalar(1 / objects.length);
}

/** Rotate positions about the world-space centroid and premultiply every orientation. */
export function transformObjects(objects: readonly WorldObject[], centre: THREE.Vector3, destination: THREE.Vector3, rotation: THREE.Quaternion): TransformChange[] {
  selectionCentre(objects);
  if (![...centre, ...destination, ...rotation].every(Number.isFinite) || rotation.lengthSq() < 1e-12)
    throw new Error('Invalid transform handle position.');
  const delta = rotation.clone().normalize();
  const rotates = delta.angleTo(identity) > 1e-10;
  return objects.map(object => {
    const position = new THREE.Vector3(object.x, object.y, object.z).sub(centre).applyQuaternion(delta).add(destination);
    if (![...position].every(value => Number.isFinite(value) && Math.abs(value) <= limit))
      throw new Error('The transform would leave the supported world coordinates.');
    const after = { ...object, x: position.x, y: position.y, z: position.z };
    if (rotates) {
      const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(object.pitch, object.yaw, object.roll, 'YXZ')).premultiply(delta);
      const euler = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ');
      after.pitch = euler.x; after.yaw = euler.y; after.roll = euler.z;
    }
    return { before: { ...object }, after };
  });
}

/** One gizmo, one pointer, one bounded immutable batch. Geometry is only a preview. */
export class TransformTools {
  readonly controls: TransformControls;
  readonly pivot = new THREE.Object3D();
  private readonly helper: THREE.Object3D;
  private mode: TransformMode = 'select';
  private space: TransformSpace = 'world';
  private translationSnap = 0;
  private rotationSnap = 0;
  private allowed = false;
  private building = false;
  private session: Session | null = null;
  private committing = false;
  private pointer: number | null = null;
  private suppressedPointer: number | null = null;
  private disposed = false;
  private revision = 0;
  private readonly previewChanged = () => this.preview();

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private canvas: HTMLCanvasElement, private options: TransformOptions) {
    // The stock DOM handlers capture right-clicks and omit pointercancel. Route
    // its public pointer methods ourselves so the camera retains right-drag.
    this.controls = new TransformControls(camera, canvas);
    this.controls.disconnect();
    canvas.style.touchAction = 'none';
    this.controls.setSpace('world'); this.controls.setSize(0.9);
    this.controls.setColors('#dd7976', '#89bc93', '#74b4cd', '#f1c777');
    this.controls.showE = false; this.controls.showXYZE = false;
    this.controls.addEventListener('objectChange', this.previewChanged);
    this.helper = this.controls.getHelper();
    this.helper.name = 'Wayfarer transform handles'; this.pivot.name = 'Wayfarer selection pivot';
    this.scene.add(this.pivot, this.helper); this.sync();
  }

  get busy() { return !!this.session || this.committing; }
  /** Freeze scripted rotations while their roots carry a local drag preview. */
  previews(id: number) { return this.session?.snapshots.some(snapshot => snapshot.before.id === id) ?? false; }
  setMode(mode: TransformMode) {
    if (!['select', 'translate', 'rotate'].includes(mode)) throw new Error('Unsupported transform mode.');
    if (mode !== this.mode) this.cancel();
    this.mode = mode;
    if (mode !== 'select') this.controls.setMode(mode);
    this.sync();
  }
  setSpace(space: TransformSpace) {
    if (space !== 'world' && space !== 'local') throw new Error('Unsupported transform space.');
    if (space !== this.space) this.cancel();
    this.space = space; this.controls.setSpace(space);
    this.controls.setTranslationSnap(space === 'world' ? this.translationSnap || null : null);
    this.sync();
  }
  setSnap(snap: { translation: number; rotation: number }) {
    if (![snap.translation, snap.rotation].every(value => Number.isFinite(value) && value >= 0) || snap.translation > limit || snap.rotation > Math.PI * 2)
      throw new Error('Snapping requires nonnegative metres and radians.');
    if (snap.translation !== this.translationSnap || snap.rotation !== this.rotationSnap) this.cancel();
    this.translationSnap = snap.translation; this.rotationSnap = snap.rotation;
    // Stock local snap rotates the absolute position around world zero. Local
    // editing instead snaps displacement from the frozen drag origin below.
    this.controls.setTranslationSnap(this.space === 'world' ? snap.translation || null : null);
    this.controls.setRotationSnap(snap.rotation || null);
  }
  setEnabled(value: boolean) {
    this.allowed = value;
    if (!value && !this.session?.committing) this.cancel();
    this.sync();
  }
  setBuilding(value: boolean) { this.building = value; if (!value) this.cancel(); this.sync(); }
  private primary(entries: TransformEntry[]): TransformEntry | undefined {
    if (!this.options.primaryId) return entries[0];
    const id = this.options.primaryId();
    return entries.find(entry => entry.object.id === id);
  }

  sync() {
    if (this.disposed) return;
    const entries = this.options.entries();
    const primary = this.primary(entries), session = this.session;
    if (session && (entries.length !== session.snapshots.length || (primary?.object.id ?? null) !== session.primaryId
      || session.snapshots.some(snapshot => !entries.some(entry => entry.object.id === snapshot.before.id && entry.root === snapshot.root && entry.ready))
      || (session.space === 'local' && (!primary || !propertyQuaternion(primary.object).equals(session.initialQuaternion))))) this.cancel();
    const enabled = this.allowed && this.building && this.mode !== 'select' && !!this.options.commit && !this.committing && entries.length > 0 && entries.length <= 256 && entries.every(entry => entry.ready) && (this.space === 'world' || !!primary);
    this.controls.enabled = enabled;
    if (!enabled) { this.controls.detach(); return; }
    if (!this.session) {
      this.pivot.position.copy(selectionCentre(entries.map(entry => entry.object)));
      if (this.space === 'local') this.pivot.quaternion.copy(propertyQuaternion(primary!.object));
      else this.pivot.quaternion.identity();
      this.pivot.scale.setScalar(1);
    }
    this.controls.attach(this.pivot);
  }

  /** Called before authoritative roots are replaced, including cell reloads. */
  objectsChanged(objects: readonly WorldObject[], replace = false, forceReload = false) {
    if (!this.session) return;
    if (replace || objects.some(object => this.session!.snapshots.some(snapshot => snapshot.before.id === object.id && (forceReload || !sameBuildObject(snapshot.before, object))))) this.cancel();
  }
  objectDeleted(id: number) { if (this.previews(id)) this.cancel(); }

  private normalized(event: PointerEvent, button = event.button): PointerEvent {
    const rect = this.canvas.getBoundingClientRect();
    // The public Three API consumes normalized coordinates despite its DOM type.
    return { x: (event.clientX - rect.left) / Math.max(1, rect.width) * 2 - 1, y: -(event.clientY - rect.top) / Math.max(1, rect.height) * 2 + 1, button } as unknown as PointerEvent;
  }
  private matrices() { this.camera.updateMatrixWorld(true); this.scene.updateMatrixWorld(true); }
  pointerDown(event: PointerEvent): boolean {
    if (this.busy) return true;
    this.suppressedPointer = null;
    this.sync();
    if (!this.controls.enabled || event.button !== 0 || document.pointerLockElement === this.canvas) return false;
    this.matrices();
    const point = this.normalized(event);
    this.controls.pointerHover(point);
    if (!this.controls.axis) return false;
    const entries = this.options.entries();
    this.session = { centre: this.pivot.position.clone(), initialQuaternion: this.pivot.quaternion.clone(), primaryId: this.primary(entries)?.object.id ?? null,
      space: this.space, axis: this.controls.axis, committing: false, snapshots: entries.map(entry => ({ before: { ...entry.object }, root: entry.root, position: entry.root.position.clone(), quaternion: entry.root.quaternion.clone() })) };
    if (this.space === 'local' && this.mode === 'rotate' && /^[XYZ]$/.test(this.session.axis)) {
      const axis = new THREE.Vector3(this.session.axis === 'X' ? 1 : 0, this.session.axis === 'Y' ? 1 : 0, this.session.axis === 'Z' ? 1 : 0);
      const worldAxis = axis.clone().applyQuaternion(this.session.initialQuaternion);
      // Three r185's aligned fallback uses the world camera-eye vector as a
      // local rotation axis. Freeze a camera-facing ray plane and calculate a
      // signed ring angle about the authored world axis for this narrow case.
      const eye = this.camera.getWorldPosition(new THREE.Vector3()).sub(this.session.centre).normalize();
      if (Math.abs(worldAxis.dot(eye)) > 1 - 1e-10) {
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.getWorldQuaternion(new THREE.Quaternion()));
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.session.centre);
        const start = this.controls.getRaycaster().ray.intersectPlane(plane, new THREE.Vector3());
        if (!start) { this.session = null; return false; }
        start.sub(this.session.centre); start.addScaledVector(worldAxis, -start.dot(worldAxis));
        this.session.alignedRotation = { axis, worldAxis, plane, start };
      }
    }
    this.controls.pointerDown(point);
    if (!this.controls.dragging) { this.session = null; return false; }
    this.pointer = event.pointerId; this.suppressedPointer = event.pointerId; this.canvas.setPointerCapture?.(event.pointerId);
    this.options.started(); event.preventDefault(); return true;
  }
  pointerMove(event: PointerEvent): boolean {
    if (this.committing) return true;
    if (this.session) {
      if (event.pointerId === this.pointer) { this.sync(); if (this.session) { this.matrices(); this.controls.pointerMove(this.normalized(event, -1)); } event.preventDefault(); }
      return true;
    }
    if (this.controls.enabled && event.buttons === 0) { this.matrices(); this.controls.pointerHover(this.normalized(event)); }
    return false;
  }
  pointerUp(event: PointerEvent): boolean {
    const suppressed = event.pointerId === this.suppressedPointer;
    if (suppressed && event.button === 0) this.suppressedPointer = null;
    if (!this.session || this.session.committing) return this.committing || suppressed;
    if (event.pointerId !== this.pointer || event.button !== 0) return true;
    this.sync(); if (!this.session) return true;
    this.controls.pointerUp(this.normalized(event)); this.releasePointer();
    void this.commit(); event.preventDefault(); return true;
  }
  pointerCancelled(event: PointerEvent): boolean {
    if (this.pointer === null || event.pointerId !== this.pointer) return false;
    this.cancel(); return true;
  }
  private releasePointer() {
    const pointer = this.pointer; this.pointer = null;
    if (pointer !== null && this.canvas.hasPointerCapture?.(pointer)) this.canvas.releasePointerCapture(pointer);
  }
  private preview() {
    const session = this.session; if (!session || session.committing) return;
    try {
      if (session.space === 'local' && this.mode === 'translate' && this.translationSnap) {
        const offset = this.pivot.position.clone().sub(session.centre).applyQuaternion(session.initialQuaternion.clone().invert());
        for (const axis of ['x', 'y', 'z'] as const) offset[axis] = session.axis.includes(axis.toUpperCase()) ? Math.round(offset[axis] / this.translationSnap) * this.translationSnap : 0;
        this.pivot.position.copy(session.centre).add(offset.applyQuaternion(session.initialQuaternion));
      }
      if (session.alignedRotation) {
        const { axis, worldAxis, plane, start } = session.alignedRotation;
        const end = this.controls.getRaycaster().ray.intersectPlane(plane, new THREE.Vector3());
        if (!end) throw new Error('The local rotation handle lost its drag plane.');
        end.sub(session.centre); end.addScaledVector(worldAxis, -end.dot(worldAxis));
        let angle = Math.atan2(worldAxis.dot(start.clone().cross(end)), start.dot(end));
        if (this.rotationSnap) angle = Math.round(angle / this.rotationSnap) * this.rotationSnap;
        this.pivot.quaternion.copy(session.initialQuaternion).multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle)).normalize();
      }
      this.pivot.updateMatrixWorld(true);
      const delta = this.rotationDelta(session);
      const changes = transformObjects(session.snapshots.map(snapshot => snapshot.before), session.centre, this.pivot.position, delta);
      for (let i = 0; i < changes.length; i++) {
        const snapshot = session.snapshots[i], after = changes[i].after;
        snapshot.root.position.set(after.x, after.y, after.z);
        snapshot.root.quaternion.copy(snapshot.quaternion).premultiply(delta);
        snapshot.root.updateMatrixWorld(true);
      }
      this.options.changed();
    } catch (error) { this.cancel(); this.options.error(error instanceof Error ? error.message : 'Invalid transform.'); }
  }
  private rotationDelta(session: Session): THREE.Quaternion {
    // World mode retains its original identity-start behavior. A local pivot
    // includes the primary's authored orientation, which is a frame, not a drag.
    return session.space === 'world' ? this.pivot.quaternion.clone()
      : this.pivot.quaternion.clone().multiply(session.initialQuaternion.clone().invert());
  }
  private restore(session: Session) {
    for (const snapshot of session.snapshots) {
      const current = this.options.current(snapshot.before.id);
      // Never put a stale preview over an accepted broadcast or a replacement root.
      if (current?.root !== snapshot.root || !sameBuildObject(current.object, snapshot.before)) continue;
      current.root.position.copy(snapshot.position); current.root.quaternion.copy(snapshot.quaternion); current.root.updateMatrixWorld(true);
    }
    this.options.changed();
  }
  cancel() {
    const session = this.session; this.session = null; this.revision++;
    this.controls.dragging = false; this.controls.axis = null; this.releasePointer();
    if (session) this.restore(session);
    if (!this.disposed) this.sync();
  }
  private async commit() {
    const session = this.session; if (!session || session.committing) return;
    let changes: TransformChange[];
    try { changes = transformObjects(session.snapshots.map(snapshot => snapshot.before), session.centre, this.pivot.position, this.rotationDelta(session)); }
    catch (error) { this.cancel(); this.options.error(error instanceof Error ? error.message : 'Invalid transform.'); return; }
    const moved = changes.some(change => Math.hypot(change.after.x - change.before.x, change.after.y - change.before.y, change.after.z - change.before.z) > 1e-7 || new THREE.Quaternion().setFromEuler(new THREE.Euler(change.before.pitch, change.before.yaw, change.before.roll, 'YXZ')).angleTo(new THREE.Quaternion().setFromEuler(new THREE.Euler(change.after.pitch, change.after.yaw, change.after.roll, 'YXZ'))) > 1e-7);
    if (!moved || !this.options.commit) { this.cancel(); return; }
    session.committing = true; this.committing = true;
    const revision = this.revision;
    this.controls.enabled = false; this.controls.detach();
    try { await this.options.commit(changes); }
    catch (error) { if (!this.disposed && revision === this.revision) this.options.error(error instanceof Error ? error.message : 'The transform could not be accepted.'); }
    finally {
      this.committing = false;
      if (this.session === session) { this.session = null; this.restore(session); }
      // The callback's canonical broadcasts are the only source of durable data,
      // even if it says true without supplying an updated property yet.
      if (!this.disposed) this.sync();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.cancel();
    this.controls.removeEventListener('objectChange', this.previewChanged);
    this.controls.dispose(); this.scene.remove(this.helper, this.pivot);
  }
}
