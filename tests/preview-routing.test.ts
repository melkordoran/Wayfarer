import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('production preview routing', () => {
  const contexts = Object.keys(config.server?.proxy ?? {});
  const proxied = (url: string) => contexts.some(context => context.startsWith('^') ? new RegExp(context).test(url) : url.startsWith(context));
  it('routes the asset fetch API but never shadows Vite compiled /assets files', () => {
    expect(proxied('/asset?url=http%3A%2F%2F127.0.0.1%3A17400%2Fmodels%2Farch.rwx')).toBe(true);
    expect(proxied('/asset')).toBe(true);
    expect(proxied('/assets/index-example.js')).toBe(false);
    expect(proxied('/assets/index-example.css')).toBe(false);
  });
});
