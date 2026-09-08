import { describe, expect, it } from 'vitest';
import { previewOptions } from '../scripts/preview-options';

describe('additional isolated preview options', () => {
  it('keeps existing local defaults without an opt-in override', () => {
    const options = previewOptions({}); expect(options.port).toBe(5174);
    expect([...options.allowedOrigins]).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173']);
  });
  it('allows one exact explicit loopback QA origin and port', () => {
    const options = previewOptions({ WAYFARER_PREVIEW_BRIDGE_PORT: '5184', WAYFARER_PREVIEW_ORIGIN: 'http://127.0.0.1:5183' });
    expect(options.port).toBe(5184); expect(options.allowedOrigins.has('http://127.0.0.1:5183')).toBe(true);
    expect(options.allowedOrigins.has('http://localhost:5183')).toBe(false);
  });
  it.each(['0', '80', '65536', '-5184', '5184.1', ' 5184', 'NaN', '5184;evil'])('rejects malformed port %s', port => {
    expect(() => previewOptions({ WAYFARER_PREVIEW_BRIDGE_PORT: port })).toThrow();
  });
  it.each(['https://attacker.example', 'http://0.0.0.0:5183', 'http://127.0.0.1:80', 'http://127.0.0.1:65536', 'http://user@127.0.0.1:5183', 'http://127.0.0.1:5183/', 'http://127.0.0.1:5183?token=x', '*'])('rejects broadened or malformed origin %s', origin => {
    expect(() => previewOptions({ WAYFARER_PREVIEW_ORIGIN: origin })).toThrow();
  });
});
