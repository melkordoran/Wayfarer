// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientCommand, ClientEvent, TerrainTile, WorldSettings } from '../src/shared/types';
import { TerrainData } from '../src/renderer/engine/terrain-data';
import { createDemoWorld } from '../src/renderer/engine/demo';
import { STORAGE_KEY } from '../src/renderer/studio-project';
const runtime = vi.hoisted(() => ({ options: null as any, listeners: new Set<(event: ClientEvent) => void>() }));
const fake = vi.hoisted(() => ({ setWorld: vi.fn(), updateWorld: vi.fn(), setObjects: vi.fn(), setTerrain: vi.fn(), teleport: vi.fn(), getPosition: vi.fn(() => ({ x: 0, y: 0, z: 0, yaw: 0 })), dispose: vi.fn(), setBuildMode: vi.fn(), setSelection: vi.fn(), setTransformMode: vi.fn(), setTransformSnap: vi.fn(), setTransformEnabled: vi.fn(), setTimeOfDay: vi.fn(), setWireframe: vi.fn(), setCameraMode: vi.fn(), setAvatarType: vi.fn(), setGesture: vi.fn(() => 0), setFlying: vi.fn(), setNavigationActionsEnabled: vi.fn(), unloadSceneData: vi.fn(), deleteObject: vi.fn(), setTerrainEditMode: vi.fn(), setTerrainSelection: vi.fn(), setTerrainPageComplete: vi.fn(), sampleTerrain: vi.fn(), previewTerrainRows: vi.fn(() => true), cancelTerrainPreview: vi.fn() }));
const command = vi.hoisted(() => vi.fn<(value: ClientCommand) => Promise<void>>());
vi.mock('../src/renderer/engine', () => ({ WorldEngine: vi.fn(function (_canvas: unknown, options: unknown) { runtime.options = options; return fake; }) }));
vi.mock('../src/renderer/client', () => ({ bridge: { mode: 'preview', asset: vi.fn(), command, subscribe: (listener: (event: ClientEvent) => void) => { runtime.listeners.add(listener); return () => runtime.listeners.delete(listener); } } }));
import App from '../src/renderer/App';
const emit = (event: ClientEvent) => runtime.listeners.forEach(listener => listener(event));
let data: TerrainData, world: WorldSettings, heights: number[], textures: number[];
function networkPage(complete = true) {
  emit({ type: 'stream-unload', world: 'Haven', session: 42, objectIds: [], terrainPages: [{ pageX: 0, pageZ: 0 }], reason: 'refresh' });
  const tile: TerrainTile = { pageX: 0, pageZ: 0, nodeX: 64, nodeZ: 64, size: 8, heights: [...heights], textures: [...textures] };
  emit({ type: 'terrain', tile }); emit({ type: 'terrain-page', world: 'Haven', session: 42, pageX: 0, pageZ: 0, sequence: 10, complete });
}
beforeEach(() => {
  localStorage.clear(); runtime.listeners.clear(); data = new TerrainData(); heights = Array(64).fill(0); textures = Array(64).fill(0);
  world = { ...createDemoWorld().settings, name: 'Haven', title: 'Haven', objectPath: '', demo: false, canEditTerrain: true };
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: vi.fn(), configurable: true });
  fake.setWorld.mockImplementation(() => data.clear()); fake.setTerrain.mockImplementation(tile => data.put(tile));
  fake.setTerrainPageComplete.mockImplementation((x, z, complete) => data.setComplete(x, z, complete));
  fake.unloadSceneData.mockImplementation((_ids, pages) => data.deletePages(pages)); fake.sampleTerrain.mockImplementation(region => data.sample(region));
  fake.previewTerrainRows.mockReturnValue(true);
  command.mockImplementation(async value => {
    if (value.type === 'connect') {
      emit({ type: 'login', citizen: 3, session: 42, name: 'Explorer' }); emit({ type: 'status', phase: 'entering', message: 'Entering' });
      emit({ type: 'world', settings: world }); networkPage(); emit({ type: 'status', phase: 'online', message: 'Online' });
    }
    if (value.type === 'terrain-set') {
      for (let i = 0; i < value.heights.length; i++) { heights[value.cellZ * 8 + value.cellX + i] = value.heights[i]; textures[value.cellZ * 8 + value.cellX + i] = value.texture; }
      networkPage(); emit({ type: 'terrain-result', requestId: value.requestId, world: 'Haven', session: 42, cellX: value.cellX, cellZ: value.cellZ, heights: [...value.heights], textures: value.heights.map(() => value.texture), status: 'verified' });
    }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
function openTerrain() { fireEvent.click(screen.getByTitle('Toggle building mode (B)')); fireEvent.click(screen.getByRole('button', { name: 'Terrain' })); }
function selectOrigin() { fireEvent.change(screen.getByLabelText('Terrain cell X'), { target: { value: '0' } }); fireEvent.change(screen.getByLabelText('Terrain cell Z'), { target: { value: '0' } }); }
function preview() { fireEvent.click(screen.getByRole('button', { name: 'Preview terrain' })); }
const saved = () => JSON.parse(localStorage.getItem(STORAGE_KEY)!);
async function connect() { fireEvent.click(screen.getByRole('button', { name: 'Connect to a universe' })); fireEvent.click(screen.getByRole('button', { name: 'Enter universe' })); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); }

describe('Terrain editor in the full app', () => {
  it('seeds a nonoverlapping complete local page without rewriting v1 as v2 on load', async () => {
    render(<App />); expect(fake.setTerrain).toHaveBeenCalledTimes(16); expect(fake.setTerrainPageComplete).toHaveBeenCalledWith(0, 0, true);
    openTerrain(); selectOrigin(); expect(screen.getByRole('button', { name: 'Preview terrain' }).hasAttribute('disabled')).toBe(false);
    await waitFor(() => expect(saved()?.version).toBe(1)); expect(saved().terrain).toBeUndefined();
  });
  it('previews without saving, applies a v2 patch, and preserves it across rename and remount', async () => {
    const view = render(<App />); openTerrain(); selectOrigin(); preview();
    expect(fake.previewTerrainRows).toHaveBeenCalledWith([{ cellX: 0, cellZ: 0, heights: [0.43], textures: [0] }]);
    expect(localStorage.getItem(STORAGE_KEY) === null || saved().terrain === undefined).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Apply terrain' })); await screen.findByText('1 cell saved locally.');
    expect(saved().version).toBe(2); expect(saved().terrain).toHaveLength(1); expect(saved().terrain[0].heights[0]).toBe(0.43);
    fireEvent.click(screen.getByRole('button', { name: 'Project' })); fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Sculpted Commons' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save project name' })); expect(saved().name).toBe('Sculpted Commons'); expect(saved().terrain[0].heights[0]).toBe(0.43);
    view.unmount(); render(<App />); openTerrain(); selectOrigin(); expect(screen.getByText('Raw height 0.43 m')).toBeTruthy(); expect(saved().objects).toHaveLength(57);
  });
  it('undoes and redoes local terrain with no property mutation or network command', async () => {
    render(<App />); openTerrain(); selectOrigin(); preview(); fireEvent.click(screen.getByRole('button', { name: 'Apply terrain' })); await screen.findByText('1 cell saved locally.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo terrain' })); await waitFor(() => expect(saved().terrain).toEqual([]));
    fireEvent.click(screen.getByRole('button', { name: 'Redo terrain' })); await waitFor(() => expect(saved().terrain[0].heights[0]).toBe(0.43));
    expect(command).not.toHaveBeenCalled(); expect(fake.deleteObject).not.toHaveBeenCalled(); expect(saved().objects).toHaveLength(57);
  });
  it('keeps a copyable draft and blocks navigation/category changes until discard', () => {
    render(<App />); openTerrain(); selectOrigin(); preview();
    fireEvent.click(screen.getByRole('button', { name: 'Objects' })); expect(screen.getByLabelText('Terrain editor')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Return to world entrance' })); expect(screen.getByText('Apply or discard the terrain preview first.')).toBeTruthy();
    const before = (screen.getByLabelText('Terrain preview values') as HTMLTextAreaElement).value;
    act(() => runtime.options.onTerrainSelect({ cellX: 5, cellZ: 5 })); expect(fake.setTerrainSelection).toHaveBeenLastCalledWith({ cellX: 0, cellZ: 0, width: 1, depth: 1 });
    expect((screen.getByLabelText('Terrain preview values') as HTMLTextAreaElement).value).toBe(before);
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard preview' })); fireEvent.click(screen.getByRole('button', { name: 'Objects' })); expect(screen.queryByLabelText('Terrain editor')).toBeNull();
  });
  it('requires restoring a suspended visual preview after a dialog closes', () => {
    render(<App />); openTerrain(); selectOrigin(); preview();
    fireEvent.click(screen.getByRole('button', { name: 'Help and keyboard shortcuts' })); fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.getByRole('button', { name: 'Apply terrain' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Restore preview' })); expect(screen.getByRole('button', { name: 'Apply terrain' }).hasAttribute('disabled')).toBe(false);
  });
  it('allows editing negative coordinate text and rejects reserved hole encoding', () => {
    render(<App />); openTerrain(); selectOrigin(); fireEvent.change(screen.getByLabelText('Terrain cell X'), { target: { value: '-' } }); expect(screen.getByRole('button', { name: 'Preview terrain' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Terrain cell X'), { target: { value: '-1' } }); expect(fake.setTerrainSelection).toHaveBeenLastCalledWith({ cellX: -1, cellZ: 0, width: 1, depth: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Texture' })); fireEvent.change(screen.getByLabelText('Terrain texture number'), { target: { value: '62' } }); fireEvent.change(screen.getByLabelText('Terrain texture rotation'), { target: { value: '3' } }); preview();
    expect(screen.getByRole('alert').textContent).toContain('reserved for terrain holes'); expect(fake.previewTerrainRows).not.toHaveBeenCalled();
  });
  it('does not change canonical local terrain when storage refuses the v2 write', async () => {
    render(<App />); openTerrain(); selectOrigin(); preview();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    fireEvent.click(screen.getByRole('button', { name: 'Apply terrain' })); await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('0 of 1 cells verified'));
    expect(screen.getByLabelText('Terrain preview values')).toBeTruthy(); expect(fake.setTerrain).toHaveBeenCalledTimes(16); expect(screen.getByRole('button', { name: 'Undo terrain' }).hasAttribute('disabled')).toBe(true);
  });
  it('dispatches exact native-contract baselines and waits for server readback', async () => {
    render(<App />); await connect(); openTerrain(); selectOrigin(); preview(); fireEvent.click(screen.getByRole('button', { name: 'Apply terrain' })); await screen.findByText('1 cell verified from the server.');
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'terrain-set', world: 'Haven', session: 42, cellX: 0, cellZ: 0, previousHeights: [0], previousTextures: [0], heights: [0.5], texture: 0 }));
    expect(screen.getByText('Raw height 0.50 m')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo terrain' })); await waitFor(() => expect(heights[0]).toBe(0));
  });
  it('disables editing without terrain-specific permission even if building is allowed', async () => {
    world.canEditTerrain = false; render(<App />); await connect(); openTerrain(); selectOrigin(); expect(screen.getByRole('button', { name: 'Preview terrain' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('This citizen does not have terrain-editing rights in this world.')).toBeTruthy(); expect(command.mock.calls.filter(([value]) => value.type === 'terrain-set')).toHaveLength(0);
  });
  it('keeps old-entry drafts copyable and cannot submit them after same-world reentry', async () => {
    render(<App />); await connect(); openTerrain(); selectOrigin(); preview();
    act(() => { emit({ type: 'status', phase: 'entering', message: 'Entering again' }); emit({ type: 'world', settings: world }); networkPage(); emit({ type: 'status', phase: 'online', message: 'Online' }); });
    expect(screen.getByRole('alert').textContent).toContain('earlier world entry'); expect(screen.getByRole('button', { name: 'Apply terrain' }).hasAttribute('disabled')).toBe(true); expect(screen.getByLabelText('Terrain preview values')).toBeTruthy();
    expect(command.mock.calls.filter(([value]) => value.type === 'terrain-set')).toHaveLength(0);
  });
  it('rejects changed/unloaded baselines and does not silently restore a stale preview', async () => {
    render(<App />); await connect(); openTerrain(); selectOrigin(); preview();
    act(() => { heights[0] = 2; networkPage(); runtime.options.onTerrainPreviewCancelled('terrain-changed'); });
    expect(screen.getByRole('alert').textContent).toContain('changed or unloaded'); expect(screen.getByRole('button', { name: 'Apply terrain' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard preview' })); preview();
    expect((screen.getByLabelText('Terrain preview values') as HTMLTextAreaElement).value).toContain('2.5');
  });
  it('requires explicit re-preview after an identical canonical page refresh', async () => {
    render(<App />); await connect(); openTerrain(); selectOrigin(); preview();
    act(() => { networkPage(); runtime.options.onTerrainPreviewCancelled('terrain-changed'); });
    expect(screen.getByRole('button', { name: 'Apply terrain' }).hasAttribute('disabled')).toBe(true); fireEvent.click(screen.getByRole('button', { name: 'Restore preview' })); expect(screen.getByRole('button', { name: 'Apply terrain' }).hasAttribute('disabled')).toBe(false);
  });
  it('uses explicit hole encoding even when its disabled texture field was invalid', () => {
    render(<App />); openTerrain(); selectOrigin();
    fireEvent.click(screen.getByRole('button', { name: 'Texture' })); fireEvent.change(screen.getByLabelText('Terrain texture number'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Make a terrain hole' })); preview();
    expect(fake.previewTerrainRows).toHaveBeenCalledWith([{ cellX: 0, cellZ: 0, heights: [-0.07], textures: [254] }]);
  });
  it('guards duplicate dispatch and navigation until both canonical readback and IPC completion arrive', async () => {
    render(<App />); await connect(); openTerrain(); selectOrigin(); preview();
    const normal = command.getMockImplementation()!; let release!: () => void;
    command.mockImplementation(async value => { await normal(value); if (value.type === 'terrain-set') await new Promise<void>(resolve => { release = resolve; }); });
    fireEvent.click(screen.getByRole('button', { name: 'Apply terrain' }));
    await waitFor(() => expect(heights[0]).toBe(0.5));
    expect(screen.getByRole('button', { name: 'Applying…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Discard preview' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Objects' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Return to world entrance' }));
    expect(screen.getByText('Wait for the current terrain edit to finish.')).toBeTruthy();
    expect(command.mock.calls.filter(([value]) => value.type === 'terrain-set')).toHaveLength(1);
    await act(async () => release()); await screen.findByText('1 cell verified from the server.');
  });
  it('preserves a partially verified batch and permits undo of only its accepted cells', async () => {
    render(<App />); await connect(); openTerrain(); selectOrigin();
    fireEvent.change(screen.getByLabelText('Terrain selection size'), { target: { value: '2' } }); preview();
    const normal = command.getMockImplementation()!; let writes = 0;
    command.mockImplementation(async value => { if (value.type === 'terrain-set' && ++writes === 2) throw new Error('Second row refused by test server'); await normal(value); });
    fireEvent.click(screen.getByRole('button', { name: 'Apply terrain' }));
    await screen.findByText(/2 of 4 cells verified/);
    expect(heights.slice(0, 2)).toEqual([0.5, 0.5]); expect(heights.slice(8, 10)).toEqual([0, 0]);
    expect(screen.getByLabelText('Terrain preview values')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo terrain' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard preview' })); fireEvent.click(screen.getByRole('button', { name: 'Undo terrain' }));
    await waitFor(() => expect(heights.every(height => height === 0)).toBe(true));
    expect(fake.deleteObject).not.toHaveBeenCalled();
  });
  it('routes terrain keyboard undo/redo outside fields and leaves text editing alone', async () => {
    render(<App />); openTerrain(); selectOrigin(); preview(); fireEvent.click(screen.getByRole('button', { name: 'Apply terrain' })); await screen.findByText('1 cell saved locally.');
    fireEvent.keyDown(screen.getByLabelText('Terrain height step'), { key: 'z', metaKey: true }); expect(saved().terrain).toHaveLength(1);
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true }); await waitFor(() => expect(saved().terrain).toEqual([]));
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true }); await waitFor(() => expect(saved().terrain).toHaveLength(1));
    preview(); fireEvent.keyDown(document.body, { key: 'Escape' }); expect(screen.queryByLabelText('Terrain preview values')).toBeNull();
    expect(saved().terrain[0].heights[0]).toBe(0.43);
  });
});
