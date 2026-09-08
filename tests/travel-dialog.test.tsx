// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TravelDialog } from '../src/renderer/App';
import type { Position } from '../src/shared/types';

afterEach(cleanup);
const position: Position = { x: 10, y: .11999999731779099, z: -29, yaw: .123456789, pitch: .01 };
function setup(initial = position, localTeleportAllowed = true) {
  const onTravel = vi.fn(), onClose = vi.fn(), props = { position: initial, world: 'Haven', localTeleportAllowed, onTravel, onClose };
  const view = render(<TravelDialog {...props} />);
  const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
  const go = () => screen.getByRole('button', { name: /Take me there/ }) as HTMLButtonElement;
  return { ...view, user: userEvent.setup(), input, go, onTravel, onClose, props };
}

describe('TravelDialog signed numeric editing', () => {
  it('preserves a typed leading minus and decimal coordinate instead of replacing it with zero', async () => {
    const view = setup(), x = view.input('X · west / east');
    await view.user.clear(x); expect(x.value).toBe(''); expect(view.go().disabled).toBe(true);
    await view.user.type(x, '-'); expect(x.value).toBe('-'); expect(view.go().disabled).toBe(true);
    expect(x.validity.patternMismatch).toBe(true); expect(x.getAttribute('aria-invalid')).toBe('true');
    await view.user.type(x, '12.75'); expect(x.value).toBe('-12.75'); expect(view.go().disabled).toBe(false);
    await view.user.click(view.go()); expect(view.onTravel).toHaveBeenCalledWith({ ...position, x: -12.75 }, 'Haven');
  });
  it('retains -. as an intermediate decimal and accepts -.5 when completed', async () => {
    const view = setup(), y = view.input('Y · altitude'); await view.user.clear(y); await view.user.type(y, '-.');
    expect(y.value).toBe('-.'); expect(view.go().disabled).toBe(true); expect(view.onTravel).not.toHaveBeenCalled();
    await view.user.type(y, '5'); expect(y.value).toBe('-.5'); expect(view.go().disabled).toBe(false);
    await view.user.click(view.go()); expect(view.onTravel).toHaveBeenCalledWith({ ...position, y: -.5 }, 'Haven');
  });
  it('keeps an empty field empty through blur, refuses direct submission, and never substitutes zero', async () => {
    const view = setup(), z = view.input('Z · north / south'); await view.user.clear(z); await view.user.tab();
    expect(z.value).toBe(''); expect(z.validity.valueMissing).toBe(true); expect(view.go().disabled).toBe(true);
    fireEvent.submit(view.go().closest('form')!); expect(view.onTravel).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Enter complete numbers');
    await view.user.type(z, '0'); expect(z.value).toBe('0'); await view.user.click(view.go());
    expect(view.onTravel).toHaveBeenCalledWith({ ...position, z: 0 }, 'Haven');
  });
  it('supports decimal heading with a leading minus without rounding while typing', async () => {
    const view = setup(), heading = view.input('Heading (degrees)'); await view.user.clear(heading); await view.user.type(heading, '-');
    expect(heading.value).toBe('-'); expect(view.go().disabled).toBe(true);
    await view.user.type(heading, '45.25'); expect(heading.value).toBe('-45.25'); expect(view.go().disabled).toBe(false);
    await view.user.click(view.go()); expect(view.onTravel).toHaveBeenCalledWith({ ...position, yaw: -45.25 * Math.PI / 180 }, 'Haven');
  });
  it('allows a leading decimal point only after at least one digit is present', async () => {
    const view = setup(), x = view.input('X · west / east'); await view.user.clear(x); await view.user.type(x, '.');
    expect(x.value).toBe('.'); expect(view.go().disabled).toBe(true);
    await view.user.type(x, '25'); expect(x.value).toBe('.25'); expect(view.go().disabled).toBe(false);
    await view.user.click(view.go()); expect(view.onTravel).toHaveBeenCalledWith({ ...position, x: .25 }, 'Haven');
  });
  it('preserves a trailing decimal separator while entering fractional digits', async () => {
    const view = setup(), x = view.input('X · west / east'); await view.user.clear(x); await view.user.type(x, '1.');
    expect(x.value).toBe('1.'); await view.user.type(x, '25'); expect(x.value).toBe('1.25');
    await view.user.click(view.go()); expect(view.onTravel).toHaveBeenCalledWith({ ...position, x: 1.25 }, 'Haven');
  });
  it('keeps the untouched fractional position and original radian heading exactly', async () => {
    const view = setup();
    expect(view.input('Y · altitude').value).toBe(String(position.y));
    expect(view.input('Heading (degrees)').value).toBe(String(position.yaw * 180 / Math.PI));
    expect(view.go().closest('form')!.checkValidity()).toBe(true); await view.user.click(view.go());
    expect(view.onTravel).toHaveBeenCalledWith(position, 'Haven');
  });
  it('does not overwrite an in-progress text draft when live position props change', async () => {
    const view = setup(), x = view.input('X · west / east'); await view.user.clear(x); await view.user.type(x, '-.');
    view.rerender(<TravelDialog {...view.props} position={{ ...position, x: 999 }} />);
    expect(x.value).toBe('-.'); await view.user.type(x, '5'); await view.user.click(view.go());
    expect(view.onTravel).toHaveBeenCalledWith({ ...position, x: -.5 }, 'Haven');
  });
  it('preserves manual teleport restrictions while allowing a different world', async () => {
    const view = setup(position, false); expect(view.go().disabled).toBe(true);
    await view.user.clear(view.input('World')); await view.user.type(view.input('World'), 'Other');
    expect(view.go().disabled).toBe(false); await view.user.click(view.go()); expect(view.onTravel).toHaveBeenCalledWith(position, 'Other');
  });
});

describe('TravelDialog complete-value validation', () => {
  it.each([
    ['X · west / east', '21474836.48'], ['X · west / east', '-21474836.48'], ['Y · altitude', 'NaN'], ['Y · altitude', 'Infinity'],
    ['Z · north / south', '1e309'], ['Z · north / south', '0x10'], ['X · west / east', '--1'], ['X · west / east', '1,5'],
    ['Heading (degrees)', '214748364.8'], ['Heading (degrees)', '-214748364.8'], ['Heading (degrees)', '-.'], ['Heading (degrees)', ''],
  ])('rejects invalid %s value %j even when the form is submitted directly', async (label, value) => {
    const view = setup(), input = view.input(label); await view.user.clear(input); if (value) await view.user.type(input, value);
    expect(input.value).toBe(value); expect(input.getAttribute('aria-invalid')).toBe('true'); expect(view.go().disabled).toBe(true);
    fireEvent.submit(view.go().closest('form')!); expect(view.onTravel).not.toHaveBeenCalled();
  });
  it.each([1, -1])('accepts the exact coordinate and heading bounds with sign %i', async sign => {
    const view = setup();
    fireEvent.change(view.input('X · west / east'), { target: { value: String(sign * 21474836.47) } });
    fireEvent.change(view.input('Heading (degrees)'), { target: { value: String(sign * 214748364.7) } });
    expect(view.go().disabled).toBe(false); await view.user.click(view.go());
    expect(view.onTravel).toHaveBeenCalledWith({ ...position, x: sign * 21474836.47, yaw: sign * 2147483647 * Math.PI / 1800 }, 'Haven');
  });
  it('keeps incomplete exponent text and accepts its completed finite value', async () => {
    const view = setup(), x = view.input('X · west / east'); await view.user.clear(x); await view.user.type(x, '-1e-');
    expect(x.value).toBe('-1e-'); expect(view.go().disabled).toBe(true);
    await view.user.type(x, '2'); expect(view.go().disabled).toBe(false); await view.user.click(view.go());
    expect(view.onTravel).toHaveBeenCalledWith({ ...position, x: -.01 }, 'Haven');
  });
});
