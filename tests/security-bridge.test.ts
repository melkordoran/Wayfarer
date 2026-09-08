import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ handler: undefined as undefined | ((request: unknown, response: unknown) => Promise<void>) }));
vi.mock('node:http', () => ({ createServer: (handler: typeof state.handler) => {
  state.handler = handler;
  return { on: vi.fn(), listen: vi.fn(), close: vi.fn() };
} }));
vi.mock('ws', () => ({ WebSocketServer: class { on = vi.fn(); close = vi.fn(); clients = new Set(); }, WebSocket: { OPEN: 1 } }));
vi.mock('../src/main/protocol', () => ({ AxisClient: class {} }));
vi.mock('../src/main/assets', () => ({ fetchAsset: vi.fn() }));

describe('preview HTTP bridge rejects hostile headers without crashing', () => {
  beforeAll(async () => {
    vi.spyOn(process, 'once').mockImplementation(() => process);
    await import('../scripts/bridge');
  });
  afterAll(() => vi.restoreAllMocks());

  function response() {
    const res = { writeHead: vi.fn(), end: vi.fn() };
    res.writeHead.mockReturnValue(res); res.end.mockReturnValue(res); return res;
  }
  it('rejects unrecognized origin', async () => {
    const res = response();
    await expect(state.handler!({ headers: { origin: 'https://attacker.example', referer: 'http://127.0.0.1:5173/' }, method: 'GET', url: '/asset' }, res)).resolves.toBeUndefined();
    expect(res.writeHead).toHaveBeenCalledWith(403);
  });
  it.each(['%', 'not a url', 'http://[bad', '\u0000'])('rejects malformed Referer %s with an HTTP error instead of an unhandled promise rejection', async referer => {
    const res = response();
    await expect(state.handler!({ headers: { referer }, method: 'GET', url: '/asset' }, res)).resolves.toBeUndefined();
    expect([400, 403]).toContain(res.writeHead.mock.calls[0]?.[0]);
    expect(res.end).toHaveBeenCalled();
  });
  it('requires an allowed Referer even when Origin is omitted', async () => {
    const res = response();
    await state.handler!({ headers: {}, method: 'GET', url: '/asset' }, res);
    expect(res.writeHead).toHaveBeenCalledWith(403);
  });
});
