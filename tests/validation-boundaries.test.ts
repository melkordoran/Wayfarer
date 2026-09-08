import { describe, expect, it } from 'vitest';
import { assertCommand } from '../src/shared/validation';

describe('Axis integer encoding boundaries', () => {
  it('rejects positions that would silently wrap centimetre coordinates', () => {
    expect(() => assertCommand({ type: 'move', position: { x: 100_000_000, y: 0, z: 0, yaw: 0 } })).toThrow('Invalid x');
    expect(() => assertCommand({ type: 'query', x: -100_000_000, z: 0 })).toThrow();
    expect(() => assertCommand({ type: 'move', position: { x: 21474836.47, y: -21474836.47, z: 0.01, yaw: Math.PI * 3 } })).not.toThrow();
  });
  it.each([-1, 1.5, NaN, Infinity, 65536])('rejects an unencodable avatar number %s', avatar => {
    expect(() => assertCommand({ type: 'avatar-set', avatar })).toThrow();
  });
  it.each([-1, 1.5, 0x100000000])('rejects an unencodable recipient %s', whisperTo => {
    expect(() => assertCommand({ type: 'chat', text: 'hello', whisperTo })).toThrow();
  });
  it('requires the tourist email Axis validates', () => {
    const options = { host: '127.0.0.1', port: 16670, tls: false, username: 'Visitor', password: '', tourist: true };
    expect(() => assertCommand({ type: 'connect', options })).toThrow('email');
    expect(() => assertCommand({ type: 'connect', options: { ...options, email: 'visitor@wayfarer.invalid' } })).not.toThrow();
  });
});
