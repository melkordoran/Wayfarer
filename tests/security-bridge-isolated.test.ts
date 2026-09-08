import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: any[]) => any;
const state = vi.hoisted(() => ({ http: undefined as Handler | undefined, server: new Map<string, Handler>(), websocket: new Map<string, Handler>(), commands: vi.fn(async () => {}), policy: undefined as { authorizeWorldConnection: Handler } | undefined, fetch: vi.fn(async () => new Response('original-rwx')) }));
vi.mock('node:http', () => ({ createServer: (handler: Handler) => {
  state.http = handler; return { on: (name: string, handler: Handler) => state.server.set(name, handler), listen: vi.fn(), close: vi.fn() };
} }));
vi.mock('ws', () => ({ WebSocketServer: class { clients = new Set(); on = (name: string, handler: Handler) => state.websocket.set(name, handler); close = vi.fn(); handleUpgrade = vi.fn(); }, WebSocket: { OPEN: 1 } }));
vi.mock('../src/main/protocol', () => ({ AxisClient: class { constructor(_event: unknown, policy: typeof state.policy) { state.policy = policy; } command = state.commands; disconnect = vi.fn(); } }));

describe('isolated bridge enforces endpoint policy before protocol/network work', () => {
  beforeAll(async () => {
    vi.spyOn(process, 'once').mockImplementation(() => process);
    for (const [key, value] of Object.entries({ WAYFARER_PREVIEW_ISOLATED: '1', WAYFARER_PREVIEW_BRIDGE_PORT: '5184', WAYFARER_PREVIEW_ORIGIN: 'http://127.0.0.1:5183', WAYFARER_PREVIEW_ISOLATED_UNIVERSE_PORT: '26670', WAYFARER_PREVIEW_ISOLATED_WORLD_PORT: '27000', WAYFARER_PREVIEW_ISOLATED_ASSET_PORT: '27400' })) vi.stubEnv(key, value);
    vi.stubGlobal('fetch', state.fetch); await import('../scripts/bridge');
  });
  beforeEach(() => { state.commands.mockClear(); state.fetch.mockClear(); });
  afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  function socket() {
    const handlers = new Map<string, Handler>(); const ws = { readyState: 1, send: vi.fn(), on: (name: string, handler: Handler) => handlers.set(name, handler) };
    state.websocket.get('connection')!(ws); return { ws, message: handlers.get('message')! };
  }
  function response() { const response = { writeHead: vi.fn(), end: vi.fn() }; response.writeHead.mockReturnValue(response); response.end.mockReturnValue(response); return response; }
  const command = (port: number) => ({ type: 'connect', options: { host: '127.0.0.1', port, tls: false, world: 'Haven', username: 'Wayfarer', password: 'fixture-only' } });

  it('rejects a saved primary Universe command without invoking AxisClient.command', async () => {
    const { ws, message } = socket(); await message(Buffer.from(JSON.stringify({ id: 1, command: command(16670) })));
    expect(state.commands).not.toHaveBeenCalled(); expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({ id: 1, error: expect.stringContaining('own loopback test Universe') });
  });
  it('passes an exact fixture Universe command and retains its correlated acknowledgement', async () => {
    const { ws, message } = socket(); await message(Buffer.from(JSON.stringify({ id: 2, command: command(26670) })));
    expect(state.commands).toHaveBeenCalledWith(command(26670)); expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({ id: 2, ok: true });
  });
  it('supplies the World-transport hook and rejects a primary World lookup', () => {
    socket(); expect(state.policy?.authorizeWorldConnection).toBeTypeOf('function');
    expect(() => state.policy!.authorizeWorldConnection({ host: '127.0.0.1', port: 17000, tls: false })).toThrow(/own loopback test World/);
    expect(() => state.policy!.authorizeWorldConnection({ host: '127.0.0.1', port: 27000, tls: false })).not.toThrow();
  });
  it('rejects primary-preview WebSocket origins', () => {
    const socket = { destroy: vi.fn() }; state.server.get('upgrade')!({ url: '/bridge', headers: { origin: 'http://127.0.0.1:5173' } }, socket, Buffer.alloc(0)); expect(socket.destroy).toHaveBeenCalledOnce();
  });
  it('rejects primary assets without any HTTP fetch', async () => {
    const res = response(); await state.http!({ method: 'GET', url: '/asset?url=' + encodeURIComponent('http://127.0.0.1:17400/models/arch.rwx'), headers: { origin: 'http://127.0.0.1:5183', referer: 'http://127.0.0.1:5183/' } }, res);
    expect(state.fetch).not.toHaveBeenCalled(); expect(res.writeHead.mock.calls[0][0]).toBe(400);
  });
  it('uses redirect-refusing bounded fetch for actual copied fixture asset requests', async () => {
    const res = response(); await state.http!({ method: 'GET', url: '/asset?url=' + encodeURIComponent('http://127.0.0.1:27400/models/arch.rwx'), headers: { origin: 'http://127.0.0.1:5183', referer: 'http://127.0.0.1:5183/' } }, res);
    expect(state.fetch).toHaveBeenCalledWith('http://127.0.0.1:27400/models/arch.rwx', expect.objectContaining({ redirect: 'error', credentials: 'omit' })); expect(res.writeHead.mock.calls[0][0]).toBe(200);
  });
});
