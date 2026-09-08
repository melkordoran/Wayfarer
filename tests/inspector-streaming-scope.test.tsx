// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientCommand, ClientEvent, WorldObject } from '../src/shared/types';
import { createDemoWorld } from '../src/renderer/engine/demo';

const runtime = vi.hoisted(() => ({ options: null as any, inspector: null as any, selection: null as any, listeners: new Set<(event: ClientEvent) => void>() }));
const fake = vi.hoisted(() => ({ setWorld: vi.fn(), updateWorld: vi.fn(), setObjects: vi.fn(), setTerrain: vi.fn(), teleport: vi.fn(() => true), applyServerPosition: vi.fn(() => true), getPosition: vi.fn(() => ({ x: 0, y: 0, z: 0, yaw: 0 })), dispose: vi.fn(), setBuildMode: vi.fn(), setSelection: vi.fn(), setTransformMode: vi.fn(), setTransformSnap: vi.fn(), setTransformEnabled: vi.fn(), setTimeOfDay: vi.fn(), setWireframe: vi.fn(), setCameraMode: vi.fn(), setAvatarType: vi.fn(), setGesture: vi.fn(() => 0), setFlying: vi.fn(), setNavigationActionsEnabled: vi.fn(), unloadSceneData: vi.fn(), deleteObject: vi.fn() }));
const command = vi.hoisted(() => vi.fn<(value: ClientCommand) => Promise<void>>());
vi.mock('../src/renderer/engine', () => ({ WorldEngine: vi.fn(function (_canvas: unknown, options: unknown) { runtime.options = options; return fake; }) }));
vi.mock('../src/renderer/client', () => ({ bridge: { mode: 'preview', asset: vi.fn(), command, subscribe: (listener: (event: ClientEvent) => void) => { runtime.listeners.add(listener); return () => runtime.listeners.delete(listener); } } }));
vi.mock('../src/renderer/components/Inspector', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/components/Inspector')>();
  return { Inspector: (props: Parameters<typeof actual.Inspector>[0]) => { runtime.inspector = props; return <actual.Inspector {...props} />; } };
});
vi.mock('../src/renderer/components/SelectionInspector', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/components/SelectionInspector')>();
  return { SelectionInspector: (props: Parameters<typeof actual.SelectionInspector>[0]) => { runtime.selection = props; return <actual.SelectionInspector {...props} />; } };
});
import App from '../src/renderer/App';
const settings = { ...createDemoWorld().settings, name: 'Haven', title: 'Haven', objectPath: '', demo: false, canBuild: true };
const objects: WorldObject[] = [
  { id: 10, owner: 3, model: 'bench.rwx', description: 'Original bench', action: '', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
  { id: 11, owner: 3, model: 'tree.rwx', description: 'Original tree', action: '', x: 4, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
];
function emit(event: ClientEvent) { runtime.listeners.forEach(listener => listener(event)); }
function unload(ids: number[]) { emit({ type: 'stream-unload', world: 'Haven', session: 42, objectIds: ids, terrainPages: [], reason: 'distance' }); }
function enter(name = 'Other') {
  emit({ type: 'status', phase: 'entering', message: 'Entering' });
  emit({ type: 'world', settings: { ...settings, name, title: name } });
  emit({ type: 'status', phase: 'online', message: 'Online' });
}
beforeEach(() => {
  localStorage.clear(); runtime.listeners.clear(); runtime.inspector = null; runtime.selection = null;
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: vi.fn(), configurable: true });
  command.mockImplementation(async value => {
    if (value.type === 'connect') { emit({ type: 'login', citizen: 3, session: 42, name: 'Explorer' }); enter('Haven'); }
    if (value.type === 'object-change') {
      emit({ type: 'objects', objects: [{ ...value.object }] });
      emit({ type: 'object-result', operation: 'change', requestId: value.requestId!, id: value.object.id, object: { ...value.object } });
    }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
async function start(group = false) {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect to a universe' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enter universe' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  act(() => emit({ type: 'objects', objects }));
  fireEvent.click(screen.getByTitle('Toggle building mode (B)'));
  act(() => runtime.options.onSelect(objects[0]));
  if (group) act(() => runtime.options.onSelect(objects[1], { additive: true }));
  command.mockClear();
}
function draft(group = false) {
  fireEvent.change(screen.getByLabelText(group ? 'Move selection X' : 'Description'), { target: { value: group ? '2' : 'My preserved draft' } });
}
const writes = () => command.mock.calls.flatMap(([value]) => value.type === 'object-change' ? [value] : []);

describe('inspector drafts across streamed scene lifetime', () => {
  it('rebinds a single-object draft after same-entry eviction/reload without requiring selection or discarding text', async () => {
    await start(); draft(); act(() => unload([10]));
    const retained = screen.getByLabelText('Description') as HTMLTextAreaElement;
    expect(retained.value).toBe('My preserved draft'); expect(retained.disabled).toBe(false); expect(retained.readOnly).toBe(true);
    retained.focus(); retained.select(); expect(document.activeElement).toBe(retained); expect(retained.selectionEnd - retained.selectionStart).toBe(retained.value.length);
    expect(screen.getByRole('button', { name: /Apply changes/ }).hasAttribute('disabled')).toBe(true);
    act(() => emit({ type: 'objects', objects: [objects[0]] }));
    expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByRole('button', { name: /Apply changes/ }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Apply changes/ }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ previous: objects[0], object: { id: 10, description: 'My preserved draft' } });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Discard edits' })).toBeNull());
  });
  it('requires explicit conflict review if the reloaded canonical object changed', async () => {
    await start(); draft(); act(() => unload([10]));
    const changed = { ...objects[0], description: 'Remote revision', x: 12 };
    act(() => emit({ type: 'objects', objects: [changed] }));
    expect(screen.getByRole('alert').textContent).toContain('changed on the server');
    expect(screen.getByRole('button', { name: /Apply changes/ }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep my edits' }));
    fireEvent.click(screen.getByRole('button', { name: /Apply changes/ }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ previous: changed, object: { x: 12, description: 'My preserved draft' } });
  });
  it('preserves group offsets while missing members reload and applies to the original same-entry objects', async () => {
    await start(true); draft(true); act(() => unload([10]));
    expect((screen.getByLabelText('Move selection X') as HTMLInputElement).value).toBe('2');
    const retained = screen.getByLabelText('Move selection X') as HTMLInputElement;
    expect(retained.disabled).toBe(false); expect(retained.readOnly).toBe(true); retained.focus(); expect(document.activeElement).toBe(retained);
    expect(screen.getByRole('button', { name: 'Apply to selection' }).hasAttribute('disabled')).toBe(true);
    act(() => emit({ type: 'objects', objects: [objects[0]] }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Apply to selection' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes().map(value => [value.object.id, value.object.x])).toEqual([[10, 2], [11, 6]]);
  });
  it.each(['Other', 'Haven'])('cannot rebind a group draft to reused IDs after entering %s, including same-name reentry', async name => {
    await start(true); draft(true); const staleSave = runtime.selection.onSave;
    const destination = objects.map(object => ({ ...object, x: object.x + 100, description: 'Different scene' }));
    act(() => { enter(name); emit({ type: 'objects', objects: destination }); });
    expect((screen.getByLabelText('Move selection X') as HTMLInputElement).value).toBe('2');
    expect(screen.getByRole('alert').textContent).toContain('earlier world entry');
    expect(screen.getByRole('button', { name: 'Apply to selection' }).hasAttribute('disabled')).toBe(true);
    expect(runtime.selection.objects).toEqual(objects); // Old snapshot is not remapped onto destination data.
    await act(async () => expect(await staleSave(objects.map(object => ({ ...object, x: object.x + 2 })))).toBe(false));
    fireEvent.submit(screen.getByRole('button', { name: 'Apply to selection' }).closest('form')!); expect(writes()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard edits' })); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('cannot submit a stale single-object callback across world entries', async () => {
    await start(); draft(); const staleSave = runtime.inspector.onSave;
    act(() => { enter('Other'); emit({ type: 'objects', objects: [{ ...objects[0], description: 'Wrong world' }] }); });
    expect(runtime.inspector.object).toBeNull(); expect(screen.getByRole('alert').textContent).toContain('earlier world entry');
    await act(async () => expect(await staleSave({ ...objects[0], description: 'My preserved draft' })).toBe(false));
    expect(writes()).toEqual([]);
  });
  it('invalidates drafts when the Universe session changes even without a world-name change', async () => {
    await start(true); draft(true); const staleSave = runtime.selection.onSave;
    act(() => { emit({ type: 'login', citizen: 3, session: 99, name: 'Explorer' }); emit({ type: 'objects', objects }); });
    expect(screen.getByRole('button', { name: 'Apply to selection' }).hasAttribute('disabled')).toBe(true);
    await act(async () => expect(await staleSave(objects.map(object => ({ ...object, x: object.x + 2 })))).toBe(false)); expect(writes()).toEqual([]);
  });
  it.each([false, true])('rejects an old-entry save callback after its %s group draft was discarded', async group => {
    await start(group); draft(group); const staleSave = (group ? runtime.selection : runtime.inspector).onSave;
    act(() => { enter('Other'); emit({ type: 'objects', objects: objects.map(object => ({ ...object, x: object.x + 100 })) }); });
    fireEvent.click(screen.getByRole('button', { name: 'Discard edits' }));
    expect(screen.queryByRole('button', { name: 'Discard edits' })).toBeNull();
    await act(async () => expect(await staleSave(group ? objects.map(object => ({ ...object, x: object.x + 2 })) : { ...objects[0], description: 'Stale discarded text' })).toBe(false));
    expect(writes()).toEqual([]);
  });
  it('does not invalidate a draft for ordinary same-entry world attribute changes', async () => {
    await start(); draft(); act(() => emit({ type: 'world', settings: { ...settings, title: 'Updated title', fogMax: 300 } }));
    expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByRole('button', { name: /Apply changes/ }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Apply changes/ })); await waitFor(() => expect(writes()).toHaveLength(1));
  });
  it.each([false, true])('rejects an older rendered save callback after a same-entry canonical revision, group=%s', async group => {
    await start(group); draft(group); const staleSave = (group ? runtime.selection : runtime.inspector).onSave;
    act(() => emit({ type: 'objects', objects: [{ ...objects[0], x: 100, description: 'New canonical revision' }] }));
    await act(async () => expect(await staleSave(group ? objects.map(object => ({ ...object, x: object.x + 2 })) : { ...objects[0], description: 'Old rendered draft' })).toBe(false));
    expect(writes()).toEqual([]);
  });
});
