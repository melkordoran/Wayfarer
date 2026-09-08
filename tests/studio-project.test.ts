import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoWorld } from '../src/renderer/engine/demo';
import { decodeStudioProject, encodeStudioProject, loadStudioProject, makeStudioProject, saveStudioProject, STORAGE_KEY, STUDIO_LIMITS, type StudioProject, type StudioStorage } from '../src/renderer/studio-project';
import type { WorldObject } from '../src/shared/types';

const timestamp = '2026-09-07T12:00:00.000Z';
const object: WorldObject = { id: 1, owner: 0, model: 'wayfarer:cube', description: 'My first build', action: 'create color #d9ae79;', x: 1, y: 0, z: -4, yaw: .2, pitch: 0, roll: 0 };
const position = { x: 0, y: 1.7, z: -8, yaw: .5, pitch: -.02 };
function seed(): StudioProject {
  const result = makeStudioProject('My studio', [object], position, timestamp);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function memory(initial?: string) {
  let value = initial ?? null;
  const storage: StudioStorage = {
    getItem: vi.fn(key => key === STORAGE_KEY ? value : null),
    setItem: vi.fn((key, next) => { expect(key).toBe(STORAGE_KEY); value = next; }),
  };
  return { storage, saved: () => value };
}
function expectFailure(result: ReturnType<typeof decodeStudioProject>, code: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}
afterEach(() => vi.unstubAllGlobals());

describe('versioned studio project files', () => {
  it('round-trips all original seed objects, appearance data and position without shared references', () => {
    const demo = createDemoWorld();
    const snapshot = makeStudioProject('The Commons', demo.objects, demo.settings.entry, timestamp);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const encoded = encodeStudioProject(snapshot.value);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeStudioProject(encoded.value);
    expect(decoded).toEqual(snapshot);
    snapshot.value.objects[0].description = 'changed after export';
    expect(demo.objects[0].description).not.toBe('changed after export');
    expect(decoded.ok && decoded.value.objects[0].description).not.toBe('changed after export');
    expect(snapshot.value.position).not.toBe(demo.settings.entry);
  });
  it('preserves an empty edited studio instead of treating it as a missing seed', () => {
    const project = { ...seed(), objects: [] };
    const store = memory();
    expect(saveStudioProject(project, store.storage).ok).toBe(true);
    const loaded = loadStudioProject(seed(), store.storage);
    expect(loaded.ok && loaded.value.source).toBe('saved');
    expect(loaded.ok && loaded.value.project.objects).toEqual([]);
  });
  it.each(['broken', '', 'null', '[]', '"project"'])('rejects invalid JSON/project shape %s', input => {
    expectFailure(decodeStudioProject(input), 'invalid-project');
  });
  it('rejects unsupported project versions', () => {
    expectFailure(decodeStudioProject(JSON.stringify({ ...seed(), version: 99 })), 'unsupported-version');
  });
  it.each(['world', 'objectPath', 'credentials', 'password', '__proto__'])('rejects unexpected top-level field %s', key => {
    const raw = JSON.parse(JSON.stringify(seed())); Object.defineProperty(raw, key, { value: 'not part of an offline project', enumerable: true });
    expectFailure(decodeStudioProject(JSON.stringify(raw)), 'invalid-project');
  });
  it('rejects extra fields on objects and position rather than persisting hidden connection data', () => {
    expectFailure(decodeStudioProject(JSON.stringify({ ...seed(), objects: [{ ...object, password: 'do-not-save' }] })), 'invalid-project');
    expectFailure(decodeStudioProject(JSON.stringify({ ...seed(), position: { ...position, host: 'elsewhere' } })), 'invalid-project');
  });
  it.each(['wayfarer:unknown', 'https://example.com/model.rwx', '//server/model.rwx', '../model.rwx', 'folder/model.rwx', 'folder\\model.rwx', '/model.rwx', 'file:///model.rwx', 'user:password@server.rwx', 'model%2e.rwx', 'model.zip'])('rejects unsafe or unsupported model reference %s', model => {
    expectFailure(decodeStudioProject(JSON.stringify({ ...seed(), objects: [{ ...object, model }] })), 'invalid-project');
  });
  it.each(['wayfarer:tree', 'column.rwx', 'MY-MODEL_01.RWX'])('accepts supported model reference %s', model => {
    expect(decodeStudioProject(JSON.stringify({ ...seed(), objects: [{ ...object, model }] })).ok).toBe(true);
  });
  it.each([0, -1, 1.2, 0x100000000])('rejects invalid object ID %s', id => {
    expectFailure(decodeStudioProject(JSON.stringify({ ...seed(), objects: [{ ...object, id }] })), 'invalid-project');
  });
  it('requires IDs to be unique', () => {
    expectFailure(decodeStudioProject(JSON.stringify({ ...seed(), objects: [object, { ...object, x: 3 }] })), 'invalid-project');
  });
  it('rejects sparse caller arrays before JSON can convert their holes to null', () => {
    const objects: WorldObject[] = Array(2);
    objects[1] = object;
    const result = makeStudioProject('Invalid', objects, position, timestamp);
    expectFailure(result, 'invalid-project');
  });
  it.each([NaN, Infinity, -Infinity, 100_000_000])('rejects invalid coordinate %s before serialization can coerce it', x => {
    const result = makeStudioProject('Invalid', [{ ...object, x }], position, timestamp);
    expect(result.ok).toBe(false);
  });
  it('rejects non-finite camera angles, overflow and unsupported entity types', () => {
    expect(makeStudioProject('Invalid', [object], { ...position, yaw: NaN }, timestamp).ok).toBe(false);
    expect(makeStudioProject('Invalid', [{ ...object, roll: 1e10 }], position, timestamp).ok).toBe(false);
    expect(makeStudioProject('Invalid', [{ ...object, type: 4 }], position, timestamp).ok).toBe(false);
  });
  it.each(['not a date', '2026-02-30T12:00:00.000Z', '2026-09-07', '2026-09-07T12:00:00+00:00'])('rejects malformed or noncanonical timestamp %s', updatedAt => {
    expectFailure(decodeStudioProject(JSON.stringify({ ...seed(), updatedAt })), 'invalid-project');
  });
  it('bounds UTF-8 text, aggregate file size, object count and project names', () => {
    expectFailure(decodeStudioProject(JSON.stringify({ ...seed(), objects: [{ ...object, description: '😀'.repeat(2100) }] })), 'too-large');
    expectFailure(decodeStudioProject(' '.repeat(STUDIO_LIMITS.fileBytes + 1)), 'too-large');
    expectFailure(decodeStudioProject(JSON.stringify({ ...seed(), objects: Array.from({ length: 5001 }, (_, i) => ({ ...object, id: i + 1 })) })), 'too-large');
    expect(makeStudioProject('a'.repeat(65), [object], position, timestamp).ok).toBe(false);
    expect(makeStudioProject(' ', [object], position, timestamp).ok).toBe(false);
    expect(makeStudioProject('two\nlines', [object], position, timestamp).ok).toBe(false);
  });
  it('enforces aggregate serialized size even when every individual object is within its limits', () => {
    const objects = Array.from({ length: 1000 }, (_, i) => ({ ...object, id: i + 1, description: 'x'.repeat(6000) }));
    const result = makeStudioProject('Too large', objects, position, timestamp);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('too-large');
  });
  it.each(['null', '{"scale":1e100}', '{"variant":-1}', '{"objectPath":"https://elsewhere"}', 'not JSON'])('rejects dangerous procedural appearance data %s', data => {
    expect(makeStudioProject('Invalid', [{ ...object, model: 'wayfarer:tree', data }], position, timestamp).ok).toBe(false);
  });
});

describe('studio project local persistence', () => {
  it('returns caller seed only when storage is missing and does not write during load', () => {
    const store = memory(), original = seed();
    const loaded = loadStudioProject(original, store.storage);
    expect(loaded).toEqual({ ok: true, value: { project: original, source: 'seed' } });
    expect(loaded.ok && loaded.value.project).not.toBe(original);
    expect(store.storage.setItem).not.toHaveBeenCalled();
  });
  it('saves and reloads a validated detached snapshot', () => {
    const store = memory(), project = seed();
    expect(saveStudioProject(project, store.storage).ok).toBe(true);
    project.objects[0].description = 'unsaved later edit';
    const loaded = loadStudioProject(seed(), store.storage);
    expect(loaded.ok && loaded.value.source).toBe('saved');
    expect(loaded.ok && loaded.value.project.objects[0].description).toBe(object.description);
  });
  it.each(['{broken', '', JSON.stringify({ format: 'wayfarer-studio', version: 99 })])('preserves corrupt or unsupported local project %s against load and autosave', existing => {
    const store = memory(existing);
    const loaded = loadStudioProject(seed(), store.storage);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe('corrupt-storage');
    const saved = saveStudioProject(seed(), store.storage);
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe('corrupt-storage');
    expect(store.saved()).toBe(existing);
    expect(store.storage.setItem).not.toHaveBeenCalled();
  });
  it('replaces corrupt local data only with an explicit validated import/reset option', () => {
    const store = memory('{broken');
    expect(saveStudioProject(seed(), store.storage, { replaceCorrupt: true }).ok).toBe(true);
    expect(loadStudioProject(seed(), store.storage).ok).toBe(true);
  });
  it('never overwrites a good project with an invalid import, even with replacement enabled', () => {
    const existing = JSON.stringify(seed()), store = memory(existing);
    expect(saveStudioProject({ ...seed(), password: 'secret' }, store.storage, { replaceCorrupt: true }).ok).toBe(false);
    expect(store.saved()).toBe(existing);
    expect(store.storage.setItem).not.toHaveBeenCalled();
  });
  it('surfaces quota errors and leaves the previous stored project intact', () => {
    const existing = JSON.stringify(seed()), store = memory(existing);
    store.storage.setItem = vi.fn(() => { throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); });
    const saved = saveStudioProject({ ...seed(), name: 'New draft' }, store.storage);
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe('quota-exceeded');
    expect(store.saved()).toBe(existing);
  });
  it('surfaces unavailable storage and does not save blindly after a read error', () => {
    const store = memory(); store.storage.getItem = vi.fn(() => { throw new Error('storage blocked'); });
    const loaded = loadStudioProject(seed(), store.storage), saved = saveStudioProject(seed(), store.storage);
    expect(loaded.ok).toBe(false); expect(saved.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe('storage-unavailable');
    if (!saved.ok) expect(saved.error.code).toBe('storage-unavailable');
    expect(store.storage.setItem).not.toHaveBeenCalled();
  });
  it('works with browser localStorage by default and fails explicitly when unavailable', () => {
    const store = memory(); vi.stubGlobal('localStorage', store.storage);
    expect(saveStudioProject(seed()).ok).toBe(true);
    expect(loadStudioProject(seed()).ok).toBe(true);
    vi.stubGlobal('localStorage', undefined);
    const result = loadStudioProject(seed());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('storage-unavailable');
  });
});
