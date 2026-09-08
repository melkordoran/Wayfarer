// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorldSettingsDialog, type WorldSettingsCloseGuard } from '../src/renderer/components/WorldSettingsDialog';
import { WorldDetailsDialog } from '../src/renderer/components/WorldDetailsDialog';
import { createDemoWorld } from '../src/renderer/engine/demo';
import type { WorldSettings } from '../src/shared/types';
import type { WorldSettingsResult, WorldSettingsSetCommand } from '../src/shared/world-settings-edit';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const initial: WorldSettings = {
  ...createDemoWorld().settings, name: 'ReviewWorld', title: 'Original title', demo: false, caretaker: true,
  rawAttributes: { 112: 'Original title', 129: 'Original welcome', 47: '0N 0W 0a 0', 3: 'Y', 53: '0', 52: '300', 12: '10', 11: '20', 10: '30' },
  editContext: { entryId: 'entry-1', revision: 10, blocked: false },
};
const result = (command: WorldSettingsSetCommand, status: WorldSettingsResult['status'] = 'observed'): WorldSettingsResult => ({ type: 'world-settings-result', requestId: command.requestId, world: command.world, session: command.session, entryId: command.entryId, status, message: 'Server text is not displayed verbatim.' });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function show(extra: Partial<Parameters<typeof WorldSettingsDialog>[0]> = {}) {
  const props = { settings: initial, studio: false, online: true, session: 42, onApply: vi.fn(async (command: WorldSettingsSetCommand) => result(command)), onClose: vi.fn(), ...extra };
  const view = render(<WorldSettingsDialog {...props} />);
  return { ...view, props, update: (next: Partial<typeof props>) => { Object.assign(props, next); view.rerender(<WorldSettingsDialog {...props} />); } };
}
const title = () => screen.getByRole('textbox', { name: /World title/ }) as HTMLInputElement;
const changeTitle = (value = 'My edited title') => fireEvent.change(title(), { target: { value } });
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(name) }));
const apply = () => fireEvent.click(screen.getByRole('button', { name: /Apply changes|Awaiting broadcast/ }));

describe('caretaker world-settings draft safety', () => {
  it('submits only edited authored attributes with the latest revision, never normalized defaults', async () => {
    const { props, update } = show(); changeTitle();
    update({ settings: { ...initial, rawAttributes: { ...initial.rawAttributes, 129: 'Live welcome', 117: 'Y' }, editContext: { ...initial.editContext!, revision: 11 } } });
    expect((screen.getByRole('textbox', { name: /Welcome message/ }) as HTMLTextAreaElement).value).toBe('Live welcome');
    expect(title().value).toBe('My edited title'); apply();
    await waitFor(() => expect(props.onApply).toHaveBeenCalledOnce());
    expect(vi.mocked(props.onApply).mock.calls[0][0]).toMatchObject({ type: 'world-settings-set', world: 'ReviewWorld', session: 42, entryId: 'entry-1', revision: 11, changes: [{ id: 112, before: 'Original title', value: 'My edited title' }] });
  });
  it('does not apply pristine values and removes a draft reverted to its authored baseline', () => {
    const { props } = show(); expect(screen.getByRole('button', { name: 'Apply changes' }).hasAttribute('disabled')).toBe(true);
    changeTitle(); changeTitle('Original title'); expect(screen.getByText('No unsaved changes')).toBeTruthy(); apply(); expect(props.onApply).not.toHaveBeenCalled();
  });
  it.each(['x', 'escape', 'backdrop'] as const)('protects a dirty draft through the %s close path', operation => {
    const { props, container } = show(); changeTitle();
    if (operation === 'x') fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    if (operation === 'escape') fireEvent.keyDown(document, { key: 'Escape' });
    if (operation === 'backdrop') fireEvent.mouseDown(container.querySelector('.modal-backdrop')!);
    expect(props.onClose).not.toHaveBeenCalled(); expect(screen.getByRole('dialog', { name: 'Discard unsaved world settings?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' })); expect(title().value).toBe('My edited title');
    fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.click(screen.getByRole('button', { name: 'Discard and close' }));
    expect(props.onClose).toHaveBeenCalledOnce(); expect(props.onApply).not.toHaveBeenCalled();
  });
  it('registers an App-level guard for dialog replacement, and does not persist drafts to storage', () => {
    let guard: WorldSettingsCloseGuard | null = null;
    const storage = vi.spyOn(Storage.prototype, 'setItem'), proceed = vi.fn();
    const view = show({ onGuardChange: value => { guard = value; } }); changeTitle();
    act(() => guard!(proceed)); expect(proceed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard and close' })); expect(proceed).toHaveBeenCalledOnce();
    view.unmount(); expect(guard).toBeNull(); expect(storage).not.toHaveBeenCalled();
  });
  it('guards window closure only while a draft or an update exists', () => {
    show(); let event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
    changeTitle(); event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' })); event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
  });
  it.each(['offline', 'studio', 'permission', 'session', 'entry', 'epoch', 'blocked'] as const)('permanently invalidates a preserved draft after %s changes', cause => {
    const view = show(); changeTitle();
    const settings = { ...initial, editContext: { ...initial.editContext! } };
    if (cause === 'permission') settings.caretaker = false;
    if (cause === 'entry') settings.editContext.entryId = 'entry-2';
    if (cause === 'blocked') settings.editContext.blocked = true;
    view.update({ settings, ...(cause === 'offline' ? { online: false } : {}), ...(cause === 'studio' ? { studio: true } : {}), ...(cause === 'session' ? { session: 99 } : {}), ...(cause === 'epoch' ? { invalidationEpoch: 1 } : {}) });
    view.update({ settings: initial, online: true, studio: false, session: 42, invalidationEpoch: 0 });
    expect(title().value).toBe('My edited title'); expect(title().readOnly).toBe(true); expect(title().disabled).toBe(false); title().focus(); expect(document.activeElement).toBe(title()); apply(); expect(view.props.onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
  it('preserves a changed-field conflict until explicit review, then sends the exact new baseline', async () => {
    const view = show(); changeTitle();
    view.update({ settings: { ...initial, rawAttributes: { ...initial.rawAttributes, 112: 'Other caretaker title' }, editContext: { ...initial.editContext!, revision: 12 } } });
    expect(title().value).toBe('My edited title'); expect(screen.getByText('Current: Other caretaker title')).toBeTruthy(); apply(); expect(view.props.onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep my draft' })); expect(view.props.onApply).not.toHaveBeenCalled(); apply();
    await waitFor(() => expect(view.props.onApply).toHaveBeenCalledOnce());
    expect(vi.mocked(view.props.onApply).mock.calls[0][0].changes).toEqual([{ id: 112, before: 'Other caretaker title', value: 'My edited title' }]);
  });
  it('can accept the current server value without sending an update', () => {
    const view = show(); changeTitle(); view.update({ settings: { ...initial, rawAttributes: { ...initial.rawAttributes, 112: 'Other title' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Use current value' })); expect(title().value).toBe('Other title'); expect(screen.getByText('No unsaved changes')).toBeTruthy(); expect(view.props.onApply).not.toHaveBeenCalled();
  });
  it('detects live conflicts across a logical RGB group, including an unchanged channel', () => {
    const view = show(); tab('Lighting & sky'); fireEvent.change(screen.getByRole('textbox', { name: /Ambient light/ }), { target: { value: '#0b141e' } });
    view.update({ settings: { ...initial, rawAttributes: { ...initial.rawAttributes, 11: '22' } } });
    expect(screen.getByText('Current: #0a161e')).toBeTruthy(); apply(); expect(view.props.onApply).not.toHaveBeenCalled();
  });
  it.each(['', 'NaN', 'Infinity', '-1', '0.5', '1e2'])('rejects invalid integer draft %j and focuses the field', value => {
    const view = show(); tab('Fog'); const near = screen.getByRole('textbox', { name: /Fog near/ });
    fireEvent.change(near, { target: { value } }); apply(); expect(view.props.onApply).not.toHaveBeenCalled(); expect(near.getAttribute('aria-invalid')).toBe('true'); expect(document.activeElement).toBe(near);
  });
  it('finds a fog cross-field error even when Apply is pressed from another section', () => {
    const view = show(); tab('Fog'); fireEvent.change(screen.getByRole('textbox', { name: /Fog near/ }), { target: { value: '400' } }); tab('General'); apply();
    expect(screen.getByRole('tab', { name: /Fog/ }).getAttribute('aria-selected')).toBe('true'); expect(screen.getByRole('textbox', { name: /Fog far/ }).getAttribute('aria-invalid')).toBe('true'); expect(view.props.onApply).not.toHaveBeenCalled();
  });
  it('leaves unknown or preexisting unsupported authored values unchanged during a title edit', async () => {
    const view = show({ settings: { ...initial, rawAttributes: { ...initial.rawAttributes, 56: 'https://user:password@assets.invalid/private?token=secret', 53: 'bad fog' } } });
    tab('Terrain & scenery'); expect((screen.getByRole('textbox', { name: /Ground model/ }) as HTMLInputElement).value).toBe(''); expect(screen.getByText(/existing value is unsupported/)).toBeTruthy();
    tab('General'); changeTitle(); apply(); await waitFor(() => expect(view.props.onApply).toHaveBeenCalledOnce());
    expect(vi.mocked(view.props.onApply).mock.calls[0][0].changes).toEqual([{ id: 112, before: 'Original title', value: 'My edited title' }]);
  });
  it('hides private baseline URL data in every field and requires deliberate staging to clear the object path', async () => {
    const privatePath = 'https://private-user:private-password@objects.example/world/?private-token=secret#private-fragment';
    const view = show({ settings: { ...initial, objectPath: privatePath, rawAttributes: { ...initial.rawAttributes, 76: privatePath, 56: privatePath, 83: privatePath, 14: privatePath, 125: privatePath } } });
    for (const name of ['General', 'Terrain & scenery', 'Water', 'Object path']) {
      tab(name);
      const values = [...view.container.querySelectorAll('input,textarea')].map(input => (input as HTMLInputElement).value).join(' ');
      for (const secret of ['private-user', 'private-password', 'private-token', 'secret', 'private-fragment']) { expect(view.container.textContent).not.toContain(secret); expect(values).not.toContain(secret); }
      expect(view.container.querySelector('a,img,iframe')).toBeNull();
    }
    expect((screen.getByRole('textbox', { name: /Object path replacement/ }) as HTMLInputElement).value).toBe(''); apply(); expect(view.props.onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear object path…' })); expect(view.props.onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stage empty object path' })); expect(view.props.onApply).not.toHaveBeenCalled(); expect(screen.getByText('Object path will be cleared when you apply.')).toBeTruthy(); expect(screen.queryByPlaceholderText('Leave blank to keep the existing path')).toBeNull(); apply();
    await waitFor(() => expect(view.props.onApply).toHaveBeenCalledOnce());
    expect(vi.mocked(view.props.onApply).mock.calls[0][0].changes).toEqual([{ id: 76, before: privatePath, value: '' }]);
  });
  it('rejects a replacement URL with private parts without copying it into error text', () => {
    const view = show(); tab('Object path'); fireEvent.change(screen.getByRole('textbox', { name: /Object path replacement/ }), { target: { value: 'https://draft-user:draft-password@objects.example/?draft-secret=123' } }); apply();
    expect(view.props.onApply).not.toHaveBeenCalled(); expect(view.container.textContent).not.toContain('draft-password'); expect(view.container.textContent).not.toContain('draft-secret');
  });
  it('prevents duplicate Apply and close while pending, then marks an observed update honestly', async () => {
    const pending = deferred<WorldSettingsResult>(), onApply = vi.fn((_command: WorldSettingsSetCommand) => pending.promise), view = show({ onApply }); changeTitle(); apply(); apply();
    expect(onApply).toHaveBeenCalledOnce(); fireEvent.click(screen.getByRole('button', { name: 'Close dialog' })); expect(view.props.onClose).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog', { name: 'Discard unsaved world settings?' })).toBeNull();
    const command = onApply.mock.calls[0][0] as WorldSettingsSetCommand;
    await act(async () => { view.update({ settings: { ...initial, rawAttributes: { ...initial.rawAttributes, 112: 'My edited title' }, editContext: { ...initial.editContext!, revision: 11 } } }); pending.resolve(result(command)); });
    expect(screen.getByText(/does not provide a durable-save acknowledgement/)).toBeTruthy(); expect(screen.getByText('No unsaved changes')).toBeTruthy(); expect(title().value).toBe('My edited title');
  });
  it.each(['uncertain', 'conflict', 'reject'] as const)('retains the draft and prohibits blind retry on %s outcome', async status => {
    const onApply = vi.fn(async (command: WorldSettingsSetCommand) => { if (status === 'reject') throw new Error('Do not reflect sensitive transport detail'); return result(command, status); });
    const view = show({ onApply }); changeTitle(); apply(); await waitFor(() => expect(title().readOnly).toBe(true));
    expect(title().value).toBe('My edited title'); view.update({ settings: { ...initial, editContext: { ...initial.editContext!, revision: 12 } } }); apply(); expect(onApply).toHaveBeenCalledOnce(); expect(view.container.textContent).not.toContain('sensitive transport');
  });
  it('supports arrow navigation between section tabs', () => {
    show(); const general = screen.getByRole('tab', { name: 'General' }); general.focus(); fireEvent.keyDown(general, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Movement rules' })); expect(screen.getByRole('tab', { name: 'Movement rules' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('read-only details edit affordance', () => {
  it.each(['allowed', 'visitor', 'offline', 'studio', 'blocked', 'missing-context'] as const)('offers editing only for a supported online caretaker: %s', state => {
    const onEdit = vi.fn(); const settings = { ...initial, caretaker: state !== 'visitor', editContext: state === 'missing-context' ? undefined : { ...initial.editContext!, blocked: state === 'blocked' } };
    render(<WorldDetailsDialog settings={settings} studio={state === 'studio'} online={state !== 'offline'} environmentMode="world" onFollowWorld={vi.fn()} onClose={vi.fn()} onEdit={onEdit} />);
    const button = screen.queryByRole('button', { name: 'Edit world settings' }); expect(!!button).toBe(state === 'allowed');
    if (button) { fireEvent.click(button); expect(onEdit).toHaveBeenCalledOnce(); }
  });
});
