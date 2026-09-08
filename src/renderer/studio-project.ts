import type { Position, TerrainTile, WorldObject } from '../shared/types';
import { validateStudioTerrain } from './studio-terrain';

export const STORAGE_KEY = 'wayfarer:studio-project-v1';
export const STUDIO_LIMITS = Object.freeze({
  fileBytes: 5 * 1024 * 1024,
  objects: 5000,
  nameCharacters: 64,
  textBytes: 8192,
  dataBytes: 16384,
  coordinate: 21474836.47,
  angle: (2147483647 * Math.PI) / 1800,
});

export interface StudioProject {
  format: 'wayfarer-studio';
  version: 1 | 2;
  name: string;
  objects: WorldObject[];
  position: Position;
  updatedAt: string;
  /** Version 2 only: sparse original-studio terrain patches, never remote data. */
  terrain?: TerrainTile[];
}
export interface StudioStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export type StudioErrorCode = 'invalid-project' | 'unsupported-version' | 'too-large' | 'corrupt-storage' | 'storage-unavailable' | 'quota-exceeded';
export interface StudioError { code: StudioErrorCode; message: string }
export type Result<T> = { ok: true; value: T } | { ok: false; error: StudioError };

const encoder = new TextEncoder();
const originalModels = new Set([
  'cube', 'column', 'landscape', 'plaza', 'fountain', 'pavilion', 'gallery',
  'arch', 'obelisk', 'tree', 'planter', 'bench', 'lamp', 'sign', 'rock',
].map(name => `wayfarer:${name}`));
const projectKeys = new Set(['format', 'version', 'name', 'objects', 'position', 'updatedAt', 'terrain']);
const positionKeys = new Set(['x', 'y', 'z', 'yaw', 'pitch']);
const objectKeys = new Set(['id', 'owner', 'model', 'description', 'action', 'x', 'y', 'z', 'yaw', 'pitch', 'roll', 'type', 'data', 'cellX', 'cellZ']);

class ValidationError extends Error {
  constructor(readonly code: StudioErrorCode, message: string) { super(message); }
}
function failure<T>(code: StudioErrorCode, message: string): Result<T> { return { ok: false, error: { code, message } }; }
function errorResult<T>(error: unknown): Result<T> {
  return error instanceof ValidationError ? failure(error.code, error.message) : failure('invalid-project', 'The studio project is not valid.');
}
function record(value: unknown, keys: Set<string>, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('invalid-project', `${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ValidationError('invalid-project', `${label} must contain plain data.`);
  if (Object.keys(value).some(key => !keys.has(key))) throw new ValidationError('invalid-project', `${label} contains unsupported fields.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maxBytes: number, budget: { bytes: number }): string {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new ValidationError('invalid-project', `${label} must be valid text without control characters.`);
  if (value.length > maxBytes) throw new ValidationError('too-large', `${label} exceeds its text limit.`);
  const bytes = encoder.encode(value).byteLength;
  budget.bytes += bytes;
  if (bytes > maxBytes || budget.bytes > STUDIO_LIMITS.fileBytes) throw new ValidationError('too-large', `${label} exceeds the project size limits.`);
  return value;
}
function number(value: unknown, label: string, maximum: number, minimum = -maximum): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new ValidationError('invalid-project', `${label} is outside its supported range.`);
  return value;
}
function integer(value: unknown, label: string, maximum: number, minimum = 0): number {
  const result = number(value, label, maximum, minimum);
  if (!Number.isInteger(result)) throw new ValidationError('invalid-project', `${label} must be an integer.`);
  return result;
}
function position(raw: unknown): Position {
  const p = record(raw, positionKeys, 'Position');
  const result: Position = {
    x: number(p.x, 'Position X', STUDIO_LIMITS.coordinate),
    y: number(p.y, 'Position Y', STUDIO_LIMITS.coordinate),
    z: number(p.z, 'Position Z', STUDIO_LIMITS.coordinate),
    yaw: number(p.yaw, 'Position yaw', STUDIO_LIMITS.angle),
  };
  if (p.pitch !== undefined) result.pitch = number(p.pitch, 'Position pitch', STUDIO_LIMITS.angle);
  return result;
}
function model(value: unknown, budget: { bytes: number }): string {
  const result = text(value, 'Object model', 255, budget);
  if (originalModels.has(result)) return result;
  // Plain file names only. A project cannot supply a URL, object path or traversal.
  if (!/^[a-z0-9][a-z0-9_.-]*\.rwx$/i.test(result) || result.includes('..')) {
    throw new ValidationError('invalid-project', 'Models must be an original wayfarer: model or a plain .rwx file name.');
  }
  return result;
}
function appearance(data: string): void {
  if (!data) return;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { throw new ValidationError('invalid-project', 'Original model appearance data must be JSON.'); }
  const p = record(parsed, new Set(['variant', 'scale', 'text', 'subtitle']), 'Original model appearance');
  if (p.variant !== undefined) integer(p.variant, 'Appearance variant', 3);
  if (p.scale !== undefined) number(p.scale, 'Appearance scale', 100, 0.001);
  const budget = { bytes: 0 };
  if (p.text !== undefined) text(p.text, 'Sign text', 1024, budget);
  if (p.subtitle !== undefined) text(p.subtitle, 'Sign subtitle', 1024, budget);
}
function worldObject(raw: unknown, budget: { bytes: number }): WorldObject {
  const o = record(raw, objectKeys, 'World object');
  const result: WorldObject = {
    id: integer(o.id, 'Object ID', 0xffffffff, 1),
    owner: integer(o.owner, 'Object owner', 0xffffffff),
    model: model(o.model, budget),
    description: text(o.description, 'Object description', STUDIO_LIMITS.textBytes, budget),
    action: text(o.action, 'Object action', STUDIO_LIMITS.textBytes, budget),
    x: number(o.x, 'Object X', STUDIO_LIMITS.coordinate),
    y: number(o.y, 'Object Y', STUDIO_LIMITS.coordinate),
    z: number(o.z, 'Object Z', STUDIO_LIMITS.coordinate),
    yaw: number(o.yaw, 'Object yaw', STUDIO_LIMITS.angle),
    pitch: number(o.pitch, 'Object pitch', STUDIO_LIMITS.angle),
    roll: number(o.roll, 'Object roll', STUDIO_LIMITS.angle),
  };
  if (o.type !== undefined) result.type = integer(o.type, 'Object type', 0);
  if (o.data !== undefined) {
    result.data = text(o.data, 'Object data', STUDIO_LIMITS.dataBytes, budget);
    if (result.model.startsWith('wayfarer:')) appearance(result.data);
  }
  for (const key of ['cellX', 'cellZ'] as const) {
    if (o[key] !== undefined) result[key] = integer(o[key], `Object ${key}`, 0x7fffffff, -0x80000000);
  }
  return result;
}
function normalize(raw: unknown): StudioProject {
  const p = record(raw, projectKeys, 'Studio project');
  if (p.format !== 'wayfarer-studio') throw new ValidationError('invalid-project', 'This file is not a Wayfarer studio project.');
  if (p.version !== 1 && p.version !== 2) throw new ValidationError('unsupported-version', 'This studio project version is not supported.');
  if (p.version === 1 && p.terrain !== undefined) throw new ValidationError('invalid-project', 'Terrain patches require studio project version 2.');
  let terrain: TerrainTile[] | undefined;
  if (p.version === 2) {
    try { terrain = validateStudioTerrain(p.terrain); }
    catch (error) { throw new ValidationError('invalid-project', error instanceof Error ? error.message : 'Invalid studio terrain.'); }
  }
  const budget = { bytes: 0 };
  const name = text(p.name, 'Project name', STUDIO_LIMITS.nameCharacters * 4, budget).trim();
  if (!name || name.length > STUDIO_LIMITS.nameCharacters || /[\r\n\t]/.test(name)) throw new ValidationError('invalid-project', 'Project name must contain 1–64 characters on one line.');
  if (!Array.isArray(p.objects)) throw new ValidationError('invalid-project', 'Project objects must be an array.');
  if (p.objects.length > STUDIO_LIMITS.objects) throw new ValidationError('too-large', `A studio project can contain at most ${STUDIO_LIMITS.objects} objects.`);
  const ids = new Set<number>();
  const objects = Array.from(p.objects, rawObject => {
    const object = worldObject(rawObject, budget);
    if (ids.has(object.id)) throw new ValidationError('invalid-project', 'Project objects must have unique IDs.');
    ids.add(object.id); return object;
  });
  const updatedAt = text(p.updatedAt, 'Project timestamp', 32, budget);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt)) || new Date(updatedAt).toISOString() !== updatedAt) {
    throw new ValidationError('invalid-project', 'Project timestamp must be a valid UTC ISO timestamp.');
  }
  return { format: 'wayfarer-studio', version: p.version, name, objects, position: position(p.position), updatedAt, ...(terrain ? { terrain } : {}) };
}
function serialized(project: StudioProject): string {
  const json = JSON.stringify(project, null, 2);
  if (json.length > STUDIO_LIMITS.fileBytes || encoder.encode(json).byteLength > STUDIO_LIMITS.fileBytes) throw new ValidationError('too-large', 'Studio projects must fit within 5 MB.');
  return json;
}

/** Build a detached, validated snapshot. No storage is read or written. */
export function makeStudioProject(name: string, objects: readonly WorldObject[], savedPosition: Position, updatedAt = new Date().toISOString(), terrain?: readonly TerrainTile[]): Result<StudioProject> {
  try {
    const project = normalize({ format: 'wayfarer-studio', version: terrain ? 2 : 1, name, objects, position: savedPosition, updatedAt, ...(terrain ? { terrain } : {}) });
    serialized(project);
    return { ok: true, value: project };
  } catch (error) { return errorResult(error); }
}

/** Import a bounded file containing only the versioned offline project schema. */
export function decodeStudioProject(json: string): Result<StudioProject> {
  try {
    if (typeof json !== 'string') throw new ValidationError('invalid-project', 'Studio project import must be JSON text.');
    if (json.length > STUDIO_LIMITS.fileBytes || encoder.encode(json).byteLength > STUDIO_LIMITS.fileBytes) throw new ValidationError('too-large', 'Studio projects must fit within 5 MB.');
    let raw: unknown;
    try { raw = JSON.parse(json); } catch { throw new ValidationError('invalid-project', 'Studio project JSON is malformed.'); }
    const project = normalize(raw);
    serialized(project);
    return { ok: true, value: project };
  } catch (error) { return errorResult(error); }
}

/** Export a validated, detached project. Extra fields, including credentials, are rejected. */
export function encodeStudioProject(project: unknown): Result<string> {
  try { return { ok: true, value: serialized(normalize(project)) }; }
  catch (error) { return errorResult(error); }
}

function getStorage(storage?: StudioStorage): Result<StudioStorage> {
  try {
    const resolved = storage ?? globalThis.localStorage;
    if (!resolved || typeof resolved.getItem !== 'function' || typeof resolved.setItem !== 'function') return failure('storage-unavailable', 'Local project storage is unavailable. Export a project file to keep your work.');
    return { ok: true, value: resolved };
  } catch { return failure('storage-unavailable', 'Local project storage is unavailable. Export a project file to keep your work.'); }
}

/** Missing data uses the supplied original seed in memory. Errors never write a seed over saved data. */
export function loadStudioProject(seed: StudioProject, storage?: StudioStorage): Result<{ project: StudioProject; source: 'saved' | 'seed' }> {
  let fallback: StudioProject;
  try { fallback = normalize(seed); serialized(fallback); } catch (error) { return errorResult(error); }
  const target = getStorage(storage);
  if (!target.ok) return target;
  let saved: string | null;
  try { saved = target.value.getItem(STORAGE_KEY); }
  catch { return failure('storage-unavailable', 'The saved studio project could not be read. Existing data was left untouched.'); }
  if (saved === null) return { ok: true, value: { project: fallback, source: 'seed' } };
  const decoded = decodeStudioProject(saved);
  if (!decoded.ok) return failure('corrupt-storage', `The saved studio project could not be loaded: ${decoded.error.message} Existing data was left untouched.`);
  return { ok: true, value: { project: decoded.value, source: 'saved' } };
}

/** Autosave cannot overwrite corrupt local data. Explicit import/reset may opt into replacement. */
export function saveStudioProject(project: unknown, storage?: StudioStorage, options: { replaceCorrupt?: boolean } = {}): Result<StudioProject> {
  const encoded = encodeStudioProject(project);
  if (!encoded.ok) return encoded;
  const target = getStorage(storage);
  if (!target.ok) return target;
  let existing: string | null;
  try { existing = target.value.getItem(STORAGE_KEY); }
  catch { return failure('storage-unavailable', 'The saved studio project could not be checked. Existing data was left untouched.'); }
  if (existing !== null && !decodeStudioProject(existing).ok && options.replaceCorrupt !== true) {
    return failure('corrupt-storage', 'Autosave is paused because the existing studio project is corrupt or unsupported. Export your current work before explicitly replacing it.');
  }
  try { target.value.setItem(STORAGE_KEY, encoded.value); }
  catch (error) {
    const failureName = error && typeof error === 'object' && 'name' in error ? error.name : '';
    const failureCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const quota = failureName === 'QuotaExceededError' || failureName === 'NS_ERROR_DOM_QUOTA_REACHED' || failureCode === 22 || failureCode === 1014;
    return failure(quota ? 'quota-exceeded' : 'storage-unavailable', quota ? 'Local storage is full. Your project was not saved; export a project file to keep your work.' : 'The project could not be saved locally. Export a project file to keep your work.');
  }
  return decodeStudioProject(encoded.value);
}
