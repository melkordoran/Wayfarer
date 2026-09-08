// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorldDetailsDialog } from '../src/renderer/components/WorldDetailsDialog';
import { createDemoWorld } from '../src/renderer/engine/demo';
import type { WorldSettings } from '../src/shared/types';

afterEach(cleanup);
const base = { ...createDemoWorld().settings, demo: false };
const props = { studio: false, environmentMode: 'world' as const, onFollowWorld: vi.fn(), onClose: vi.fn() };
const value = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe('read-only teleport rules and effective navigation capability', () => {
  it.each([
    ['restricted visitor', { allowTeleport: false, canTeleport: false, caretaker: false }, 'No', 'No'],
    ['normalized caretaker exception', { allowTeleport: false, canTeleport: true, caretaker: true }, 'No', 'Yes'],
    ['explicit effective denial takes precedence', { allowTeleport: true, canTeleport: false, caretaker: true }, 'Yes', 'No'],
    ['legacy visitor fallback', { allowTeleport: false, canTeleport: undefined, caretaker: false }, 'No', 'No'],
    ['legacy caretaker fallback', { allowTeleport: false, canTeleport: undefined, caretaker: true }, 'No', 'Yes'],
    ['missing authored value is not invented', { allowTeleport: undefined, canTeleport: undefined, caretaker: false }, 'Not provided', 'Yes'],
    ['original studio navigation is local', { demo: true, allowTeleport: false, canTeleport: false, caretaker: false }, 'No', 'Yes'],
  ] as const)('shows %s consistently with shared navigation', (_name, override, authored, effective) => {
    const settings: WorldSettings = { ...base, ...override };
    const { container } = render(<WorldDetailsDialog {...props} settings={settings} studio={settings.demo === true} />);
    expect(value('World teleport rule')).toBe(authored); expect(value('You can teleport')).toBe(effective);
    expect(container.querySelectorAll('input,select,textarea')).toHaveLength(0);
    expect(screen.getByText(/Teleport permission here applies to local manual travel/)).toBeTruthy();
  });
  it('reflects changed effective rights without a server mutation or stale displayed capability', () => {
    const follow = vi.fn(), close = vi.fn();
    const settings = { ...base, allowTeleport: false, canTeleport: false, caretaker: false };
    const view = render(<WorldDetailsDialog {...props} onFollowWorld={follow} onClose={close} settings={settings} />);
    expect(value('You can teleport')).toBe('No');
    view.rerender(<WorldDetailsDialog {...props} onFollowWorld={follow} onClose={close} settings={{ ...settings, canTeleport: true, caretaker: true }} />);
    expect(value('World teleport rule')).toBe('No'); expect(value('You can teleport')).toBe('Yes');
    expect(follow).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
});
