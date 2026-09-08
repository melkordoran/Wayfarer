// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientCommand, ClientEvent, WorldSettings } from '../src/shared/types';
import type { WorldSettingsSetCommand } from '../src/shared/world-settings-edit';
import { createDemoWorld } from '../src/renderer/engine/demo';
const runtime = vi.hoisted(() => ({ options: null as any, listeners: new Set<(event: ClientEvent) => void>() }));
const fake = vi.hoisted(() => ({ setWorld: vi.fn(), updateWorld: vi.fn(), setObjects: vi.fn(), setTerrain: vi.fn(), teleport: vi.fn(), dispose: vi.fn(), setBuildMode: vi.fn(), setSelection: vi.fn(), setTransformMode: vi.fn(), setTransformSnap: vi.fn(), setTransformEnabled: vi.fn(), setTimeOfDay: vi.fn(), setWireframe: vi.fn(), setCameraMode: vi.fn(), setAvatarType: vi.fn(), setGesture: vi.fn(() => 0), setFlying: vi.fn() }));
const command = vi.hoisted(() => vi.fn<(value: ClientCommand) => Promise<void>>());
vi.mock('../src/renderer/engine', () => ({ WorldEngine: vi.fn(function (_canvas: unknown, options: unknown) { runtime.options = options; return fake; }) }));
vi.mock('../src/renderer/client', () => ({ bridge: { mode: 'preview', asset: vi.fn(), command, subscribe: (listener: (event: ClientEvent) => void) => { runtime.listeners.add(listener); return () => runtime.listeners.delete(listener); } } }));
import App from '../src/renderer/App';
const initial: WorldSettings = { ...createDemoWorld().settings, name: 'CaretakerWorld', title: 'CaretakerWorld', demo: false, caretaker: true, objectPath: 'https://objects.invalid/', rawAttributes: { 112: 'CaretakerWorld', 129: 'Welcome', 47: '0N 0W 0a 0' }, editContext: { entryId: 'entry-1', revision: 2, blocked: false } };
let submit: (value: WorldSettingsSetCommand) => Promise<void>;
function emit(event: ClientEvent) { runtime.listeners.forEach(listener => listener(event)); }
function answer(value: WorldSettingsSetCommand, extra: Partial<Extract<ClientEvent, { type: 'world-settings-result' }>> = {}) {
  emit({ type: 'world-settings-result', requestId: value.requestId, world: value.world, session: value.session, entryId: value.entryId, status: 'observed', message: '', ...extra });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  localStorage.clear(); runtime.listeners.clear();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: vi.fn(), configurable: true });
  submit = async value => {
    emit({ type: 'world', settings: { ...initial, title: 'Edited title', rawAttributes: { ...initial.rawAttributes, 112: 'Edited title' }, editContext: { ...initial.editContext!, revision: 3 } } });
    answer(value);
  };
  command.mockImplementation(async value => {
    if (value.type === 'connect') { emit({ type: 'login', citizen: 3, session: 42, name: 'Caretaker' }); emit({ type: 'status', phase: 'entering', message: 'Entering' }); emit({ type: 'world', settings: initial }); emit({ type: 'status', phase: 'online', message: 'Online' }); }
    if (value.type === 'world-settings-set') await submit(value);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
async function open() {
  const view = render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect to a universe' })); fireEvent.click(screen.getByRole('button', { name: 'Enter universe' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'World details' })); fireEvent.click(screen.getByRole('button', { name: 'Edit world settings' }));
  return view;
}
const title = () => screen.getByRole('textbox', { name: 'World title' }) as HTMLInputElement;
const edit = () => fireEvent.change(title(), { target: { value: 'Edited title' } });
const apply = () => fireEvent.click(screen.getByRole('button', { name: /Apply changes|Awaiting broadcast/ }));
const sent = () => command.mock.calls.flatMap(([value]) => value.type === 'world-settings-set' ? [value] : []);

describe('world-settings App integration', () => {
  it('captures a synchronous result before command resolution and updates scenery only from a world broadcast', async () => {
    await open(); const calls = fake.updateWorld.mock.calls.length; edit(); expect(fake.updateWorld).toHaveBeenCalledTimes(calls);
    apply(); await waitFor(() => expect(screen.getByText(/durable-save acknowledgement/)).toBeTruthy());
    expect(sent()).toHaveLength(1); expect(sent()[0]).toMatchObject({ world: 'CaretakerWorld', session: 42, entryId: 'entry-1', revision: 2, changes: [{ id: 112, before: 'CaretakerWorld', value: 'Edited title' }] });
    expect(fake.updateWorld).toHaveBeenCalledTimes(calls + 1); expect(screen.getByText('No unsaved changes')).toBeTruthy(); expect(runtime.listeners.size).toBe(1);
  });
  it('ignores mismatched result scopes and waits for both matching observation and command completion', async () => {
    const pending = deferred<void>(); let request!: WorldSettingsSetCommand;
    submit = async value => { request = value; answer(value, { entryId: 'another-entry' }); answer(value, { session: 99 }); answer(value, { requestId: 'another-request' }); await pending.promise; };
    await open(); edit(); apply(); await waitFor(() => expect(sent()).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Awaiting broadcast…' })).toBeTruthy();
    act(() => answer(request)); expect(screen.getByRole('button', { name: 'Awaiting broadcast…' })).toBeTruthy();
    await act(async () => pending.resolve()); expect(screen.getByText(/durable-save acknowledgement/)).toBeTruthy(); expect(runtime.listeners.size).toBe(1);
  });
  it('blocks a same-render disconnect race before any mutation reaches the bridge', async () => {
    await open(); edit();
    await act(async () => { emit({ type: 'status', phase: 'disconnected', message: 'Disconnected' }); apply(); });
    expect(sent()).toHaveLength(0); expect(title().value).toBe('Edited title'); expect(title().readOnly).toBe(true);
  });
  it.each(['offline', 'permission'] as const)('remembers even a batched transient %s loss followed by apparent recovery', async cause => {
    await open(); edit();
    act(() => {
      if (cause === 'offline') { emit({ type: 'status', phase: 'disconnected', message: 'Disconnected' }); emit({ type: 'status', phase: 'online', message: 'Online' }); }
      else { emit({ type: 'world', settings: { ...initial, caretaker: false } }); emit({ type: 'world', settings: initial }); }
    });
    expect(title().readOnly).toBe(true); apply(); expect(sent()).toHaveLength(0);
  });
  it('preserves a draft across same-world reentry and requires closing it before a new editor can send', async () => {
    await open(); edit();
    act(() => { emit({ type: 'status', phase: 'entering', message: 'Reentering' }); emit({ type: 'world', settings: { ...initial, editContext: { entryId: 'entry-2', revision: 0, blocked: false } } }); emit({ type: 'status', phase: 'online', message: 'Online' }); });
    expect(title().readOnly).toBe(true); apply(); expect(sent()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' })); fireEvent.click(screen.getByRole('button', { name: 'Discard and close' }));
    fireEvent.click(screen.getByRole('button', { name: 'World details' })); fireEvent.click(screen.getByRole('button', { name: 'Edit world settings' }));
    expect(title().readOnly).toBe(false); edit(); apply(); await waitFor(() => expect(sent()).toHaveLength(1)); expect(sent()[0].entryId).toBe('entry-2');
  });
  it('guards global dialog replacement and explicit return-to-studio navigation while dirty', async () => {
    await open(); edit(); fireEvent.click(screen.getByRole('button', { name: 'Preferences' }));
    expect(screen.getByRole('dialog', { name: 'Discard unsaved world settings?' })).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    fireEvent.click(screen.getByRole('button', { name: 'wayfarer.' })); expect(screen.getByRole('dialog', { name: 'World settings' })).toBeTruthy(); expect(title().value).toBe('Edited title'); expect(command.mock.calls.some(([value]) => value.type === 'disconnect')).toBe(false);
  });
  it('cleans pending result subscriptions on unmount without issuing a retry', async () => {
    submit = async () => new Promise(() => {});
    const view = await open(); edit(); apply(); await waitFor(() => expect(sent()).toHaveLength(1)); expect(runtime.listeners.size).toBe(2);
    await act(async () => view.unmount()); expect(runtime.listeners.size).toBe(0); expect(sent()).toHaveLength(1);
  });
  it('times out even when an observation arrives but bridge command completion never does', async () => {
    submit = async value => { answer(value); await new Promise(() => {}); };
    await open(); vi.useFakeTimers(); edit(); apply(); await act(async () => { await Promise.resolve(); });
    expect(sent()).toHaveLength(1); await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(title().readOnly).toBe(true); expect(screen.getByRole('button', { name: 'Apply changes' }).hasAttribute('disabled')).toBe(true); expect(runtime.listeners.size).toBe(1); expect(sent()).toHaveLength(1);
  });
});
