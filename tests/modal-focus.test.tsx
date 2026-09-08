// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../src/renderer/components/Modal';

const outside: HTMLElement[] = [];
function outsideButton() {
  const button = document.createElement('button'); button.textContent = 'Fullscreen underlay'; document.body.appendChild(button); outside.push(button); return button;
}
function content(onClose = vi.fn()) {
  return <Modal title="Travel" onClose={onClose}><label>Destination<input /></label><button>Travel now</button></Modal>;
}
afterEach(() => { cleanup(); outside.splice(0).forEach(element => element.remove()); vi.restoreAllMocks(); });

describe('modal focus containment across native fullscreen transitions', () => {
  it('starts inside the dialog and recovers outside focus to the last active dialog field', () => {
    const trigger = outsideButton(); trigger.focus(); render(content());
    const close = screen.getByRole('button', { name: 'Close dialog' }), input = screen.getByLabelText('Destination');
    expect(document.activeElement).toBe(close);
    input.focus(); trigger.focus(); expect(document.activeElement).toBe(input);
    fireEvent(document, new Event('fullscreenchange')); expect(document.activeElement).toBe(input);
    // Fullscreen focus restoration may happen after fullscreenchange as well.
    trigger.focus(); expect(document.activeElement).toBe(input);
  });
  it('does not refocus or disturb a valid field selection on fullscreenchange', () => {
    render(content()); const input = screen.getByLabelText('Destination') as HTMLInputElement;
    input.value = 'Haven'; input.focus(); input.setSelectionRange(1, 4);
    const focus = vi.spyOn(input, 'focus'); fireEvent(document, new Event('fullscreenchange'));
    expect(focus).not.toHaveBeenCalled(); expect(input.selectionStart).toBe(1); expect(input.selectionEnd).toBe(4);
  });
  it('recovers a fullscreen focus escape even when the platform omitted focusin', () => {
    const trigger = outsideButton(); render(content()); const input = screen.getByLabelText('Destination'); input.focus();
    const focus = vi.spyOn(input, 'focus'), active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(trigger);
    fireEvent(document, new Event('fullscreenchange')); active.mockRestore();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true }); expect(document.activeElement).toBe(input);
  });
  it.each([false, true])('recovers Tab from outside instead of allowing underlay navigation (shift=%s)', shiftKey => {
    const trigger = outsideButton(); render(content());
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(trigger);
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    act(() => { document.dispatchEvent(event); }); active.mockRestore();
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: shiftKey ? 'Travel now' : 'Close dialog' }));
  });
  it('cycles within available controls, skipping hidden, disabled and negative-tabindex elements', async () => {
    const user = userEvent.setup();
    render(<Modal title="Controls" onClose={vi.fn()}>
      <button disabled>Disabled</button><div hidden><button>Hidden parent</button></div>
      <div style={{ display: 'none' }}><button>CSS hidden</button></div><input type="hidden" />
      <button tabIndex={-1}>Programmatic only</button><label>Editable<input /></label><button>Last</button>
    </Modal>);
    const first = screen.getByRole('button', { name: 'Close dialog' }), input = screen.getByLabelText('Editable'), last = screen.getByRole('button', { name: 'Last' });
    expect(document.activeElement).toBe(first); await user.tab(); expect(document.activeElement).toBe(input);
    await user.tab(); expect(document.activeElement).toBe(last); await user.tab(); expect(document.activeElement).toBe(first);
    await user.tab({ shift: true }); expect(document.activeElement).toBe(last);
  });
  it('falls back to a focusable panel when no controls remain available', () => {
    render(content()); const dialog = screen.getByRole('dialog');
    dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(control => { control.disabled = true; });
    const trigger = outsideButton(); trigger.focus(); expect(document.activeElement).toBe(dialog);
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    fireEvent(document, event); expect(event.defaultPrevented).toBe(true); expect(document.activeElement).toBe(dialog);
  });
  it('replaces an unavailable remembered field with an available dialog control', () => {
    const trigger = outsideButton(); render(content()); const input = screen.getByLabelText('Destination') as HTMLInputElement;
    input.focus(); input.disabled = true; trigger.focus();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close dialog' }));
  });
  it('restores its connected opener on close and removes all focus/fullscreen containment', () => {
    const trigger = outsideButton(); trigger.focus(); const view = render(content());
    screen.getByLabelText('Destination').focus(); view.unmount(); expect(document.activeElement).toBe(trigger);
    const other = outsideButton(); other.focus(); fireEvent(document, new Event('fullscreenchange'));
    expect(document.activeElement).toBe(other);
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    fireEvent(document, event); expect(event.defaultPrevented).toBe(false);
  });
  it.each(['removed', 'disabled'])('does not restore an opener that became %s', state => {
    const trigger = outsideButton(); trigger.focus(); const view = render(content()), focus = vi.spyOn(trigger, 'focus');
    if (state === 'removed') trigger.remove(); else trigger.disabled = true;
    view.unmount(); expect(focus).not.toHaveBeenCalled();
  });
  it('lets only the topmost modal trap focus and restores the parent field after nested close', () => {
    const outerClose = vi.fn(), innerClose = vi.fn();
    const nested = (show: boolean) => <Modal title="Outer" onClose={outerClose}><label>Parent field<input /></label>{show && <Modal title="Inner" onClose={innerClose}><input aria-label="Inner field" /></Modal>}</Modal>;
    const view = render(nested(false)), parent = screen.getByLabelText('Parent field'); parent.focus();
    view.rerender(nested(true)); const inner = screen.getByRole('dialog', { name: 'Inner' });
    expect(document.activeElement).toBe(within(inner).getByRole('button', { name: 'Close dialog' }));
    const trigger = outsideButton(); trigger.focus(); expect(inner.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' }); expect(innerClose).toHaveBeenCalledOnce(); expect(outerClose).not.toHaveBeenCalled();
    view.rerender(nested(false)); expect(document.activeElement).toBe(parent);
  });
  it('uses the latest close callback without reinstalling or losing focus', () => {
    const original = vi.fn(), latest = vi.fn(), view = render(content(original));
    const input = screen.getByLabelText('Destination'); input.focus(); view.rerender(content(latest));
    expect(document.activeElement).toBe(input); fireEvent.keyDown(document, { key: 'Escape' });
    expect(latest).toHaveBeenCalledOnce(); expect(original).not.toHaveBeenCalled();
  });
});
