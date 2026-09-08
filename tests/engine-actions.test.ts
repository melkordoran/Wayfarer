import { describe, expect, it } from 'vitest';
import { actionColor, parseActions, parseTeleport } from '../src/renderer/engine/actions';

describe('AW action parser', () => {
  it('separates triggers and comma-separated commands without splitting quoted text', () => {
    const actions = parseActions('create color red, name "welcome, traveler"; activate url "https://example.org/a;b", teleport 10N 2W');
    expect(actions.map(a => [a.trigger, a.command, a.args])).toEqual([
      ['create', 'color', ['red']], ['create', 'name', ['welcome, traveler']],
      ['activate', 'url', ['https://example.org/a;b']], ['activate', 'teleport', ['10N', '2W']],
    ]);
  });
  it('ignores prose and unsupported trigger names', () => {
    expect(parseActions('not an action; imaginary destroy universe')).toEqual([]);
  });
  it('maps north and west coordinates to positive Z and X and altitude to metres', () => {
    expect(parseTeleport('Haven 10N 2W 1.5A 90', { x: 1, y: 2, z: 3, yaw: 0 })).toEqual({ world: 'Haven', position: { x: 20, y: 15, z: 100, yaw: Math.PI / 2 } });
    expect(parseTeleport('3S 4E', { x: 0, y: 8, z: 0, yaw: 1 })).toEqual({ world: undefined, position: { x: -40, y: 8, z: -30, yaw: 1 } });
  });
  it('rejects malformed coordinates', () => {
    expect(parseTeleport('10N bad garbage', { x: 0, y: 0, z: 0, yaw: 0 })).toBeNull();
    expect(parseTeleport('', { x: 0, y: 0, z: 0, yaw: 0 })).toBeNull();
  });
  it('accepts named, hex and RGB colors', () => {
    expect(actionColor(['red'])).toBe('red');
    expect(actionColor(['ff0000'])).toBe('#ff0000');
    expect(actionColor(['255', '128', '0'])).toBe('#ff8000');
  });
});
