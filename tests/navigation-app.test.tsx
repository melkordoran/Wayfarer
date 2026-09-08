// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientCommand, ClientEvent } from '../src/shared/types';
import { createDemoWorld } from '../src/renderer/engine/demo';
import { BuildHistory } from '../src/renderer/build-history';
const runtime = vi.hoisted(() => ({ options: null as any, listeners: new Set<(event: ClientEvent) => void>() }));
const fake = vi.hoisted(() => ({ setWorld: vi.fn(), updateWorld: vi.fn(), setObjects: vi.fn(), setTerrain: vi.fn(), teleport: vi.fn(() => true), applyServerPosition: vi.fn(() => true), getPosition: vi.fn(() => ({ x: 10, y: 2, z: 3, yaw: 0 })), dispose: vi.fn(), setBuildMode: vi.fn(), setSelection: vi.fn(), setTransformMode: vi.fn(), setTransformSnap: vi.fn(), setTransformEnabled: vi.fn(), setTimeOfDay: vi.fn(), setWireframe: vi.fn(), setCameraMode: vi.fn(), setAvatarType: vi.fn(), setGesture: vi.fn(() => 0), setFlying: vi.fn(), setNavigationActionsEnabled: vi.fn(), unloadSceneData: vi.fn(), deleteObject: vi.fn() }));
const command = vi.hoisted(() => vi.fn<(value: ClientCommand) => Promise<void>>());
vi.mock('../src/renderer/engine', () => ({ WorldEngine: vi.fn(function (_canvas: unknown, options: unknown) { runtime.options = options; return fake; }) }));
vi.mock('../src/renderer/client', () => ({ bridge: { mode: 'preview', asset: vi.fn(), command, subscribe: (listener: (event: ClientEvent) => void) => { runtime.listeners.add(listener); return () => runtime.listeners.delete(listener); } } }));
import App from '../src/renderer/App';
function emit(event: ClientEvent) { runtime.listeners.forEach(listener => listener(event)); }
const world = { ...createDemoWorld().settings, name: 'Haven', title: 'Haven', objectPath: '', demo: false, canTeleport: false, allowTeleport: false };
const destination = { x: 80, y: 2, z: -30, yaw: 0 };
beforeEach(() => {
  localStorage.clear(); runtime.listeners.clear();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: vi.fn(), configurable: true });
  command.mockImplementation(async value => {
    if (value.type === 'connect') {
      emit({ type: 'login', citizen: 3, session: 42, name: 'Explorer' });
      emit({ type: 'status', phase: 'entering', message: 'Entering' });
      emit({ type: 'world', settings: world });
      emit({ type: 'status', phase: 'online', message: 'Online' });
    }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
async function connect() {
  fireEvent.click(screen.getByRole('button', { name: 'Connect to a universe' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enter universe' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fake.teleport.mockClear(); fake.applyServerPosition.mockClear(); command.mockClear();
}
function travelDialog() { fireEvent.click(screen.getByTitle('Travel to coordinates (T)')); }
function submitHome() {
  const input = screen.getByRole('textbox', { name: 'Chat message' });
  fireEvent.change(input, { target: { value: '/home' } }); fireEvent.submit(input.closest('form')!);
}
describe('navigation permission UI', () => {
  it('reports actual canvas capture and viewport fullscreen instead of optimistic clicks', async () => {
    const view = render(<App />), canvas = view.container.querySelector('canvas')!, viewport = canvas.parentElement!;
    const request = vi.fn().mockResolvedValue(undefined), exit = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(viewport, 'requestFullscreen', { value: request, configurable: true });
    Object.defineProperty(document, 'exitFullscreen', { value: exit, configurable: true });
    Object.defineProperty(document, 'pointerLockElement', { get: () => null, configurable: true });
    Object.defineProperty(document, 'fullscreenElement', { get: () => null, configurable: true });
    const pointer = vi.spyOn(document, 'pointerLockElement', 'get').mockReturnValue(null);
    const fullscreen = vi.spyOn(document, 'fullscreenElement', 'get').mockReturnValue(null);
    expect(screen.getByLabelText('Mouse look status').textContent).toBe('Move around');
    pointer.mockReturnValue(canvas); fireEvent(document, new Event('pointerlockchange'));
    expect(screen.getByLabelText('Mouse look status').textContent).toBe('Mouse look captured');
    pointer.mockReturnValue(document.body); fireEvent(document, new Event('pointerlockchange'));
    expect(screen.getByLabelText('Mouse look status').textContent).toBe('Move around');
    fireEvent.click(screen.getByRole('button', { name: 'Enter viewport fullscreen' })); expect(request).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Enter viewport fullscreen' }).getAttribute('aria-pressed')).toBe('false');
    fullscreen.mockReturnValue(viewport); fireEvent(document, new Event('fullscreenchange'));
    fireEvent.click(screen.getByRole('button', { name: 'Exit viewport fullscreen' })); expect(exit).toHaveBeenCalled();
    fullscreen.mockReturnValue(null); fireEvent(document, new Event('fullscreenchange'));
    expect(screen.getByRole('button', { name: 'Enter viewport fullscreen' }).getAttribute('aria-pressed')).toBe('false');
    request.mockRejectedValue(new Error('Denied')); fireEvent.click(screen.getByRole('button', { name: 'Enter viewport fullscreen' }));
    await screen.findByText('Fullscreen is unavailable in this window.');
  });
  it('releases canvas capture for building and exits viewport fullscreen before showing dialogs', () => {
    const view = render(<App />), canvas = view.container.querySelector('canvas')!, viewport = canvas.parentElement!;
    Object.defineProperty(document, 'pointerLockElement', { get: () => null, configurable: true });
    Object.defineProperty(document, 'fullscreenElement', { get: () => null, configurable: true });
    const pointer = vi.spyOn(document, 'pointerLockElement', 'get').mockReturnValue(canvas);
    const fullscreen = vi.spyOn(document, 'fullscreenElement', 'get').mockReturnValue(viewport);
    const release = vi.fn(), exit = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, 'exitPointerLock', { value: release, configurable: true });
    Object.defineProperty(document, 'exitFullscreen', { value: exit, configurable: true });
    fireEvent.click(screen.getByTitle('Toggle building mode (B)')); expect(release).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledTimes(1);
    fullscreen.mockReturnValue(null); fireEvent(document, new Event('fullscreenchange'));
    fullscreen.mockReturnValue(viewport); travelDialog(); expect(release).toHaveBeenCalledTimes(2); expect(exit).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' })); fullscreen.mockReturnValue(null); pointer.mockReturnValue(null);
    travelDialog(); expect(exit).toHaveBeenCalledTimes(2);
  });
  it('pauses authored navigation during dialogs/building and while not in a network world', async () => {
    render(<App />); expect(fake.setNavigationActionsEnabled).toHaveBeenLastCalledWith(true);
    travelDialog(); expect(fake.setNavigationActionsEnabled).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' })); expect(fake.setNavigationActionsEnabled).toHaveBeenLastCalledWith(true);
    await connect(); expect(fake.setNavigationActionsEnabled).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTitle('Toggle building mode (B)')); expect(fake.setNavigationActionsEnabled).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByTitle('Toggle building mode (B)')); expect(fake.setNavigationActionsEnabled).toHaveBeenLastCalledWith(true);
    act(() => emit({ type: 'status', phase: 'connected', message: 'World disconnected' })); expect(fake.setNavigationActionsEnabled).toHaveBeenLastCalledWith(false);
  });
  it('restores authored navigation in the offline studio after a network disconnect request', async () => {
    render(<App />); await connect(); fireEvent.click(screen.getByTitle('Return to offline studio'));
    await waitFor(() => expect(screen.getAllByText('The Commons').length).toBeGreaterThan(0));
    expect(fake.setNavigationActionsEnabled).toHaveBeenLastCalledWith(true);
  });
  it('unloads cache objects/pages without fabricating server deletion or resetting history', async () => {
    render(<App />); await connect();
    const object = { id: 10, owner: 3, model: 'bench.rwx', description: 'Saved', action: '', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
    act(() => emit({ type: 'objects', objects: [object] })); const reset = vi.spyOn(BuildHistory.prototype, 'reset');
    act(() => emit({ type: 'stream-unload', world: 'hAvEn', session: 42, objectIds: [10], terrainPages: [{ pageX: 2, pageZ: -1 }], reason: 'distance' }));
    expect(fake.unloadSceneData).toHaveBeenCalledWith([10], [{ pageX: 2, pageZ: -1 }]); expect(fake.deleteObject).not.toHaveBeenCalled(); expect(reset).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
    expect(screen.getByText('0 objects')).toBeTruthy();
    act(() => emit({ type: 'objects', objects: [object] })); expect(screen.getByText('1 objects')).toBeTruthy();
  });
  it('ignores unload notifications from another world/session or while in the studio', async () => {
    render(<App />);
    act(() => emit({ type: 'stream-unload', world: 'Haven', session: 42, objectIds: [10], terrainPages: [], reason: 'distance' })); expect(fake.unloadSceneData).not.toHaveBeenCalled();
    await connect();
    for (const scope of [{ world: 'Other', session: 42 }, { world: 'Haven', session: 41 }]) act(() => emit({ type: 'stream-unload', ...scope, objectIds: [10], terrainPages: [], reason: 'reset' }));
    expect(fake.unloadSceneData).not.toHaveBeenCalled();
  });
  it('retains an inspector draft but disables saving after its object is streamed out', async () => {
    render(<App />); await connect();
    const object = { id: 10, owner: 3, model: 'bench.rwx', description: 'Saved', action: '', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
    act(() => emit({ type: 'objects', objects: [object] })); fireEvent.click(screen.getByTitle('Toggle building mode (B)')); act(() => runtime.options.onSelect(object));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Preserve this draft' } });
    act(() => emit({ type: 'stream-unload', world: 'Haven', session: 42, objectIds: [10], terrainPages: [], reason: 'budget' }));
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Preserve this draft'); expect(screen.getByRole('alert').textContent).toContain('no longer available');
    expect(screen.getByRole('button', { name: /Apply changes/ }).hasAttribute('disabled')).toBe(true); expect(command).not.toHaveBeenCalled(); expect(fake.setNavigationActionsEnabled).toHaveBeenLastCalledWith(false);
  });
  it('disables manual entrance and shows a reason instead of moving', async () => {
    render(<App />); await connect();
    const entrance = screen.getByRole('button', { name: 'Return to world entrance' });
    expect(entrance.hasAttribute('disabled')).toBe(true); expect(entrance.title).toContain('Local teleporting is disabled');
    fireEvent.click(entrance); expect(fake.teleport).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
  });
  it.each(['Haven', '  hAvEn  ', '   '])('blocks manual Travel to the same world %j even when submitting the form directly', async name => {
    render(<App />); await connect(); travelDialog();
    fireEvent.change(screen.getByLabelText('World'), { target: { value: name } });
    const go = screen.getByRole('button', { name: /Take me there/ }); expect(go.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Local teleporting is disabled');
    fireEvent.submit(go.closest('form')!); expect(fake.teleport).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
  });
  it('keeps cross-world travel available as an ordinary manual enter request', async () => {
    render(<App />); await connect(); travelDialog();
    fireEvent.change(screen.getByLabelText('World'), { target: { value: '  Other  ' } });
    fireEvent.change(screen.getByLabelText('X · west / east'), { target: { value: '80' } });
    const go = screen.getByRole('button', { name: /Take me there/ }); expect(go.hasAttribute('disabled')).toBe(false);
    fireEvent.click(go);
    expect(command).toHaveBeenCalledWith({ type: 'enter', world: 'Other', position: expect.objectContaining({ x: 80 }) });
    expect(fake.teleport).not.toHaveBeenCalled();
  });
  it('accepts an untouched fractional terrain position without HTML step mismatch or hidden rounding', async () => {
    render(<App />); await connect();
    const fractional = { ...destination, x: 1.234567, y: 0.11999999731779099, z: -30.456789 };
    vi.spyOn(performance, 'now').mockReturnValue(10000);
    act(() => runtime.options.onPosition(fractional)); command.mockClear();
    travelDialog(); fireEvent.change(screen.getByLabelText('World'), { target: { value: 'Other' } });
    for (const label of ['X · west / east', 'Y · altitude', 'Z · north / south']) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.validity.stepMismatch).toBe(false); expect(input.checkValidity()).toBe(true);
    }
    const altitude = screen.getByLabelText('Y · altitude') as HTMLInputElement;
    expect(Number(altitude.value)).toBe(fractional.y); expect(altitude.form!.checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Take me there/ }));
    expect(command).toHaveBeenCalledWith({ type: 'enter', world: 'Other', position: fractional });
  });
  it('rejects /home at the shared navigation boundary with feedback', async () => {
    render(<App />); await connect(); submitHome();
    expect(screen.getByText(/Local teleporting is disabled in this world/)).toBeTruthy();
    expect(fake.teleport).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
  });
  it('disables same-world bookmarks but leaves cross-world bookmarks available', async () => {
    localStorage.setItem('wayfarer:places', JSON.stringify([
      { id: 'local', name: 'Nearby garden', world: ' hAVen ', studio: false, position: destination },
      { id: 'remote', name: 'Other garden', world: 'Other', studio: false, position: destination },
    ]));
    render(<App />); await connect(); fireEvent.click(screen.getByRole('tab', { name: 'Places' }));
    const local = screen.getByRole('button', { name: /^Nearby garden/ }); expect(local.hasAttribute('disabled')).toBe(true);
    fireEvent.click(local); expect(command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Other garden/ }));
    expect(command).toHaveBeenCalledWith({ type: 'enter', world: 'Other', position: destination });
  });
  it('does not use the worlds list as a manual same-world re-entry bypass', async () => {
    render(<App />); await connect();
    act(() => emit({ type: 'worlds', worlds: [{ name: 'HAVEN', users: 1, status: 'public' }] }));
    fireEvent.click(screen.getByText('HAVEN').closest('button')!);
    expect(command).not.toHaveBeenCalled(); expect(screen.getByText(/Local teleporting is disabled in this world/)).toBeTruthy();
  });
  it('reenables local navigation after effective caretaker permission arrives without resetting the world', async () => {
    render(<App />); await connect(); const worldCalls = fake.setWorld.mock.calls.length;
    act(() => emit({ type: 'world', settings: { ...world, caretaker: true, canTeleport: true } }));
    const entrance = screen.getByRole('button', { name: 'Return to world entrance' }); expect(entrance.hasAttribute('disabled')).toBe(false);
    fireEvent.click(entrance); expect(fake.teleport).toHaveBeenCalledWith(world.entry); expect(fake.setWorld).toHaveBeenCalledTimes(worldCalls);
    submitHome(); expect(fake.teleport).toHaveBeenCalledTimes(2);
  });
  it('uses the trusted engine entry point for server positions, never the user permission path', async () => {
    render(<App />); await connect();
    act(() => emit({ type: 'teleport', world: 'hAVen', position: destination }));
    expect(fake.applyServerPosition).toHaveBeenCalledWith(destination); expect(fake.teleport).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
  });
  it('applies trusted server position while preserving an unsaved inspector draft', async () => {
    render(<App />); await connect();
    const object = { id: 10, owner: 3, model: 'bench.rwx', description: 'Saved', action: '', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
    act(() => emit({ type: 'objects', objects: [object] }));
    fireEvent.click(screen.getByTitle('Toggle building mode (B)'));
    act(() => runtime.options.onSelect(object));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'My unsaved draft' } });
    expect(screen.getByRole('button', { name: 'Discard edits' })).toBeTruthy();
    act(() => emit({ type: 'teleport', position: destination }));
    expect(fake.applyServerPosition).toHaveBeenCalledWith(destination);
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('My unsaved draft');
    expect(screen.getByRole('button', { name: 'Discard edits' })).toBeTruthy(); expect(command).not.toHaveBeenCalled();
  });
  it('does not veto trusted server position or reset a busy build operation', async () => {
    render(<App />); await connect();
    vi.spyOn(BuildHistory.prototype, 'busy', 'get').mockReturnValue(true);
    const reset = vi.spyOn(BuildHistory.prototype, 'reset');
    act(() => emit({ type: 'teleport', position: destination }));
    expect(fake.applyServerPosition).toHaveBeenCalledWith(destination); expect(reset).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
  });
  it('quiesces automatic movement/query synchronously while disconnect status is delayed, then resumes on a new login', async () => {
    render(<App />); await connect(); let resolve!: () => void;
    command.mockImplementation(value => value.type === 'disconnect' ? new Promise<void>(done => { resolve = done; }) : Promise.resolve());
    fireEvent.click(screen.getByTitle('Disconnect from universe'));
    expect(fake.setNavigationActionsEnabled).toHaveBeenLastCalledWith(false);
    vi.spyOn(performance, 'now').mockReturnValue(10000);
    act(() => runtime.options.onPosition(destination));
    expect(command.mock.calls.map(([value]) => value.type)).toEqual(['disconnect']);
    await act(async () => resolve());
    act(() => emit({ type: 'status', phase: 'disconnected', message: 'Disconnected' }));
    act(() => { emit({ type: 'login', citizen: 3, session: 43, name: 'Explorer' }); emit({ type: 'status', phase: 'online', message: 'Online' }); });
    vi.mocked(performance.now).mockReturnValue(11000);
    act(() => runtime.options.onPosition(destination));
    expect(command.mock.calls.map(([value]) => value.type)).toEqual(['disconnect', 'move', 'query']);
  });
  it('reports disconnect failure and resumes automatic movement instead of swallowing unrelated command errors', async () => {
    render(<App />); await connect();
    command.mockImplementation(async value => { if (value.type === 'disconnect') throw new Error('Disconnect request failed'); });
    fireEvent.click(screen.getByTitle('Disconnect from universe'));
    await waitFor(() => expect(screen.getAllByText('Disconnect request failed').length).toBeGreaterThan(0));
    vi.spyOn(performance, 'now').mockReturnValue(10000); act(() => runtime.options.onPosition(destination));
    expect(command.mock.calls.map(([value]) => value.type)).toEqual(['disconnect', 'move', 'query']);
  });
  it('scopes object-authored cross-world travel to the active source world and session', async () => {
    render(<App />); await connect();
    act(() => runtime.options.onAction({ type: 'teleport', value: 'Other 8W 3S' }));
    expect(command).toHaveBeenCalledWith({ type: 'enter', world: 'Other', position: destination, origin: 'action', fromWorld: 'Haven', session: 42 });
    expect(fake.teleport).not.toHaveBeenCalled();
  });
  it('does not send an object travel request after leaving the entered world', async () => {
    render(<App />); await connect(); act(() => emit({ type: 'status', phase: 'connected', message: 'World disconnected' }));
    act(() => runtime.options.onAction({ type: 'teleport', value: 'Other 8W 3S' }));
    expect(command).not.toHaveBeenCalled();
  });
});
