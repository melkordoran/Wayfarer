// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorldDetailsDialog } from '../src/renderer/components/WorldDetailsDialog';
import { defaultWorldSettings, normalizeWorldSettings, WORLD_ATTRIBUTE } from '../src/main/protocol/world-settings';

afterEach(cleanup);
const fields = [
  ['Ground', 'Ground model'], ['Skybox', 'Skybox model'],
  ['Backdrop', 'Backdrop'], ['WaterTexture', 'Surface texture'],
] as const;

describe('independent normalized world-details privacy regressions', () => {
  it.each(fields)('never reveals credential or URL parameter text from the %s attribute', (attribute, label) => {
    const settings = normalizeWorldSettings(defaultWorldSettings('Elsewhere'), new Map([
      [WORLD_ATTRIBUTE[attribute], 'https://private-user:private-password@objects.example/asset.rwx?secret-token=private-token#private-fragment'],
    ]));
    const { container } = render(<WorldDetailsDialog settings={settings} studio={false} environmentMode="world" onFollowWorld={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(label).nextElementSibling?.textContent).toBeTruthy();
    for (const secret of ['private-user', 'private-password', 'secret-token', 'private-token', 'private-fragment']) {
      expect(container.textContent).not.toContain(secret);
    }
    expect(container.querySelectorAll('a,img,iframe')).toHaveLength(0);
  });

  it('keeps safe authored filenames identifiable without inventing a fixture asset', () => {
    const settings = normalizeWorldSettings(defaultWorldSettings('Elsewhere'), new Map(fields.map(([attribute], index) => [WORLD_ATTRIBUTE[attribute], `authored-${index}.${index < 2 ? 'rwx' : 'png'}`])));
    render(<WorldDetailsDialog settings={settings} studio={false} environmentMode="world" onFollowWorld={vi.fn()} onClose={vi.fn()} />);
    fields.forEach(([, label], index) => expect(screen.getByText(label).nextElementSibling?.textContent).toBe(`authored-${index}.${index < 2 ? 'rwx' : 'png'}`));
  });
});
