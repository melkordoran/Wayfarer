// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Inspector } from '../src/renderer/components/Inspector';
import { SelectionInspector } from '../src/renderer/components/SelectionInspector';
import type { WorldObject } from '../src/shared/types';

afterEach(cleanup);
const original: WorldObject = { id: 1, owner: 2, model: 'column.rwx', description: 'Original', action: '', x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
const handlers = () => ({ canBuild: true, pending: false, onSave: vi.fn<(value: WorldObject | WorldObject[]) => Promise<boolean>>(async () => false), onDelete: vi.fn(), onDuplicate: vi.fn(), onClose: vi.fn(), onDirtyChange: vi.fn() });
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const button = (label = 'Apply changes') => screen.getByRole('button', { name: label }) as HTMLButtonElement;
const submit = (label: string) => fireEvent.submit(input(label).closest('form')!);
const objects = [original, { ...original, id: 2, x: 4 }];

describe('character-by-character object numeric drafts', () => {
  it.each([
    ['Position X', 'x', '-18.11'], ['Position Y', 'y', '-.25'], ['Position Z', 'z', '-18.11'],
    ['Rotation pitch', 'pitch', '-15.1250'], ['Rotation yaw', 'yaw', '+1.2345'], ['Rotation roll', 'roll', '-15'],
  ])('retains signed fractional text in %s and submits its exact numeric value', async (label, key, text) => {
    const props = handlers(), user = userEvent.setup(); render(<Inspector object={original} {...props} />);
    const field = input(label); await user.clear(field); await user.type(field, text);
    expect(field.value).toBe(text); expect(field.getAttribute('aria-invalid')).toBe('false'); expect(field.inputMode).toBe('decimal');
    await user.click(button());
    expect(props.onSave).toHaveBeenCalledTimes(1);
    const value = label.startsWith('Rotation') ? Number(text) * Math.PI / 180 : Number(text);
    expect(props.onSave.mock.calls[0][0]).toEqual({ ...original, [key]: value });
    expect(field.value).toBe(text); // A rejection never rounds or rewrites text.
  });
  it.each(['', '-', '.', '-.', '+', '1e', '-2e-'])('keeps incomplete %j dirty across cell refreshes and tabs, never coercing it to a submitted zero', async text => {
    const props = handlers(), user = userEvent.setup(); const view = render(<Inspector object={original} {...props} />);
    await user.clear(input('Position Z')); if (text) await user.type(input('Position Z'), text);
    await user.type(screen.getByLabelText('Description'), ' edited');
    expect(input('Position Z').value).toBe(text); expect(input('Position Z').getAttribute('aria-invalid')).toBe('true');
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true); expect(button().disabled).toBe(true);
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    view.rerender(<Inspector object={{ ...original, cellX: 0, cellZ: 0 }} {...props} />);
    await user.click(screen.getByRole('button', { name: 'Actions' })); await user.click(screen.getByRole('button', { name: 'Properties' }));
    expect(input('Position Z').value).toBe(text); submit('Position Z'); expect(props.onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Discard edits' }));
    expect(input('Position Z').value).toBe('0'); expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  it('does not lose a minus while the user pauses, refreshes, then continues typing a negative decimal', async () => {
    const props = handlers(), user = userEvent.setup(); const view = render(<Inspector object={original} {...props} />);
    await user.clear(input('Position Z')); await user.type(input('Position Z'), '-');
    view.rerender(<Inspector object={{ ...original }} {...props} />);
    expect(input('Position Z').value).toBe('-');
    await user.type(input('Position Z'), '18.11'); expect(input('Position Z').value).toBe('-18.11');
    await user.click(button()); expect(props.onSave).toHaveBeenCalledWith({ ...original, z: -18.11 });
  });
  it.each([
    ['Position X', 'Infinity'], ['Position X', 'NaN'], ['Position X', '0x10'], ['Position X', '1e309'],
    ['Position X', '21474836.48'], ['Position Z', '-21474836.48'], ['Rotation roll', '214748364.8'], ['Rotation pitch', '-214748364.8'],
  ])('rejects malformed/nonfinite/out-of-bounds %s text %s without losing it', async (label, text) => {
    const props = handlers(), user = userEvent.setup(); render(<Inspector object={original} {...props} />);
    await user.clear(input(label)); await user.type(input(label), text);
    expect(input(label).value).toBe(text); expect(input(label).getAttribute('aria-invalid')).toBe('true'); expect(button().disabled).toBe(true);
    submit(label); expect(props.onSave).not.toHaveBeenCalled();
  });
  it('resets partial rotation text without discarding position or description drafts', async () => {
    const props = handlers(), user = userEvent.setup(); render(<Inspector object={{ ...original, pitch: 0.2, roll: 0.5 }} {...props} />);
    await user.clear(input('Position X')); await user.type(input('Position X'), '-1.25');
    await user.clear(input('Rotation roll')); await user.type(input('Rotation roll'), '-');
    await user.type(screen.getByLabelText('Description'), ' edited');
    await user.click(screen.getByRole('button', { name: 'Reset rotation' }));
    for (const key of ['pitch', 'yaw', 'roll']) expect(input('Rotation ' + key).value).toBe('0');
    expect(input('Position X').value).toBe('-1.25'); expect(button().disabled).toBe(false);
    await user.click(button()); expect(props.onSave).toHaveBeenCalledWith({ ...original, description: 'Original edited', x: -1.25 });
  });
  it('preserves incomplete conflict drafts and makes them copyable if their entry becomes unavailable', async () => {
    const props = handlers(), user = userEvent.setup(); const view = render(<Inspector object={original} {...props} />);
    await user.clear(input('Position Z')); await user.type(input('Position Z'), '-');
    view.rerender(<Inspector object={{ ...original, z: 8, x: 5 }} {...props} />);
    await user.click(screen.getByRole('button', { name: 'Keep my edits' }));
    expect(input('Position Z').value).toBe('-'); expect(input('Position X').value).toBe('5'); expect(button().disabled).toBe(true);
    view.rerender(<Inspector object={null} {...props} unavailableReason="Earlier world entry" canBuild={false} />);
    const field = input('Position Z'); expect(field.value).toBe('-'); expect(field.readOnly).toBe(true); expect(field.disabled).toBe(false);
    field.focus(); field.select(); expect(field.selectionEnd! - field.selectionStart!).toBe(1);
    submit('Position Z'); expect(props.onSave).not.toHaveBeenCalled();
  });
  it('does not keep a stale numeric display override when Keep my edits accepts an unedited remote field', async () => {
    const props = handlers(), user = userEvent.setup(); const view = render(<Inspector object={original} {...props} />);
    await user.clear(input('Position X')); await user.type(input('Position X'), '0');
    await user.type(screen.getByLabelText('Description'), ' edited');
    view.rerender(<Inspector object={{ ...original, x: 5 }} {...props} />);
    await user.click(screen.getByRole('button', { name: 'Keep my edits' }));
    expect(input('Position X').value).toBe('5'); await user.click(button());
    expect(props.onSave).toHaveBeenCalledWith({ ...original, x: 5, description: 'Original edited' });
  });
  it('adopts negative canonical rounding only after explicit acceptance and resets raw text with it', async () => {
    let finish!: (accepted: boolean) => void;
    const props = { ...handlers(), onSave: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })) }, user = userEvent.setup();
    const view = render(<Inspector object={original} {...props} />);
    await user.clear(input('Position Z')); await user.type(input('Position Z'), '-18.111'); await user.click(button());
    view.rerender(<Inspector object={{ ...original, z: -18.11 }} {...props} pending />);
    expect(input('Position Z').value).toBe('-18.111');
    await act(async () => { finish(true); }); view.rerender(<Inspector object={{ ...original, z: -18.11 }} {...props} />);
    expect(input('Position Z').value).toBe('-18.11'); expect(props.onDirtyChange).toHaveBeenLastCalledWith(false); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps equivalent text formatting recoverable but does not submit a numeric no-op', async () => {
    const props = handlers(), user = userEvent.setup(); const view = render(<Inspector object={original} {...props} />);
    await user.clear(input('Position X')); await user.type(input('Position X'), '-0.00');
    view.rerender(<Inspector object={{ ...original }} {...props} />);
    expect(input('Position X').value).toBe('-0.00'); expect(props.onDirtyChange).toHaveBeenLastCalledWith(true); expect(button().disabled).toBe(true);
    submit('Position X'); expect(props.onSave).not.toHaveBeenCalled();
  });
});

describe('character-by-character selection numeric drafts', () => {
  it('submits signed relative movement and high precision negative rotation without per-keystroke coercion', async () => {
    const props = handlers(), user = userEvent.setup(); render(<SelectionInspector objects={objects} {...props} />);
    await user.clear(input('Move selection Z')); await user.type(input('Move selection Z'), '-'); expect(input('Move selection Z').value).toBe('-');
    await user.type(input('Move selection Z'), '18.11');
    await user.clear(input('Rotate selection')); await user.type(input('Rotate selection'), '-15.1250');
    expect(input('Rotate selection').value).toBe('-15.1250'); expect(input('Rotate selection').getAttribute('aria-invalid')).toBe('false');
    await user.click(button('Apply to selection'));
    const saved = props.onSave.mock.calls[0][0] as unknown as WorldObject[];
    expect(saved).toHaveLength(2); expect(saved[0].yaw).toBeCloseTo(-15.125 * Math.PI / 180, 12);
    expect((saved[0].z + saved[1].z) / 2).toBeCloseTo(-18.11, 10);
    expect(input('Move selection Z').value).toBe('-18.11'); expect(input('Rotate selection').value).toBe('-15.1250');
    expect(button('Apply to selection').disabled).toBe(true); // Explicit failure review still required.
  });
  it.each(['', '-', '.', '-.', '+', '1e', '1e309', '21474836.48'])('blocks incomplete/invalid selection offset %j while retaining a copyable draft', async text => {
    const props = handlers(), user = userEvent.setup(); const view = render(<SelectionInspector objects={objects} {...props} />);
    await user.clear(input('Move selection X')); if (text) await user.type(input('Move selection X'), text);
    expect(input('Move selection X').value).toBe(text); expect(input('Move selection X').getAttribute('aria-invalid')).toBe('true'); expect(button('Apply to selection').disabled).toBe(true);
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true); submit('Move selection X'); expect(props.onSave).not.toHaveBeenCalled();
    view.rerender(<SelectionInspector objects={objects} {...props} canBuild={false} unavailableReason="Earlier world entry" />);
    expect(input('Move selection X').value).toBe(text); expect(input('Move selection X').readOnly).toBe(true); expect(input('Move selection X').disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Discard edits' })); expect(input('Move selection X').value).toBe('0'); expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  it('shows a field-specific incomplete rotation and only clears valid draft text after accepted completion', async () => {
    let finish!: (accepted: boolean) => void;
    const props = { ...handlers(), onSave: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })) }, user = userEvent.setup();
    render(<SelectionInspector objects={objects} {...props} />);
    await user.clear(input('Rotate selection')); await user.type(input('Rotate selection'), '-.');
    expect(input('Rotate selection').getAttribute('aria-invalid')).toBe('true'); expect(input('Move selection X').getAttribute('aria-invalid')).toBe('false');
    submit('Rotate selection'); expect(props.onSave).not.toHaveBeenCalled();
    await user.type(input('Rotate selection'), '25'); await user.click(button('Apply to selection'));
    expect(input('Rotate selection').value).toBe('-.25'); expect(input('Rotate selection').disabled).toBe(true);
    await act(async () => { finish(true); }); expect(input('Rotate selection').value).toBe('0'); expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  it('does not apply a formatting-only zero selection transform', async () => {
    const props = handlers(), user = userEvent.setup(); render(<SelectionInspector objects={objects} {...props} />);
    await user.clear(input('Rotate selection')); await user.type(input('Rotate selection'), '-0.00');
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true); expect(button('Apply to selection').disabled).toBe(true);
    submit('Rotate selection'); expect(props.onSave).not.toHaveBeenCalled();
  });
});
