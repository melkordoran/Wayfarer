import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({
  paths: new Map<string, string>(), handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[], order: [] as string[],
  policy: undefined as { authorizeWorldConnection(target: any): void } | undefined,
  command: vi.fn(async (_value: unknown) => {}), disconnect: vi.fn(), ordinaryAsset: vi.fn(async () => ({ bytes: new Uint8Array(), contentType: 'test' })),
  exit: vi.fn(), appHandlers: new Map<string, (...args: any[]) => any>(),
}));
vi.mock('electron', () => ({
  app: {
    isPackaged: true, isReady: () => false, setName: vi.fn(), getVersion: () => '0.7.0', getAppPath: () => '/test/Wayfarer.app/Contents/Resources/app.asar',
    setPath: (name: string, value: string) => { runtime.order.push('path:' + name); runtime.paths.set(name, value); },
    getPath: (name: string) => runtime.paths.get(name) || '/normal-profile', exit: runtime.exit, quit: vi.fn(),
    whenReady: async () => { runtime.order.push('ready'); }, on: (name: string, handler: (...args: any[]) => any) => runtime.appHandlers.set(name, handler),
  },
  BrowserWindow: class {
    events = new Map<string, (...args: any[]) => any>();
    webContents = { mainFrame: { url: '' }, getURL: () => this.webContents.mainFrame.url, send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() };
    constructor(public options: unknown) { runtime.order.push('window'); runtime.windows.push(this); }
    on = (name: string, handler: (...args: any[]) => any) => this.events.set(name, handler);
    loadURL = async (url: string) => { this.webContents.mainFrame.url = url; };
    isDestroyed = () => false; isVisible = () => true; getSize = () => [1480, 960];
  },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => runtime.handlers.set(name, handler) },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() }, dialog: { showMessageBoxSync: vi.fn() },
}));
vi.mock('../src/main/protocol', () => ({ AxisClient: class { constructor(_onEvent: unknown, policy: typeof runtime.policy) { runtime.policy = policy; } command = runtime.command; disconnect = runtime.disconnect; } }));
vi.mock('../src/main/assets', () => ({ fetchAsset: runtime.ordinaryAsset }));
const previousArgv = process.argv;
const base = resolve('.runtime'); mkdirSync(base, { recursive: true });
let profile: string;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); runtime.paths.clear(); runtime.handlers.clear(); runtime.windows = []; runtime.order = []; runtime.appHandlers.clear(); runtime.policy = undefined;
  profile = mkdtempSync(join(base, 'native-ipc-test-'));
  process.argv = ['Wayfarer', '--profile-dir=' + profile, '--qa-network=26670,27000,27400'];
  vi.stubGlobal('__dirname', '/test/Wayfarer.app/Contents/Resources/app.asar/dist-electron');
});
afterEach(() => { process.argv = previousArgv; vi.unstubAllGlobals(); });
async function start() { await import('../src/main/main'); await vi.waitFor(() => expect(runtime.windows.length).toBe(1)); await Promise.resolve(); }
function sender() { const contents = runtime.windows[0].webContents; return { sender: contents, senderFrame: contents.mainFrame }; }
const connect = (port: number) => ({ type: 'connect', options: { host: '127.0.0.1', port, tls: false, username: 'FreshFixture', password: '', world: 'Haven' } });

describe('actual native entrypoint IPC and startup isolation', () => {
  it('sets both storage paths before readiness and writes verified packaged startup/ready receipts', async () => {
    await start();
    expect(runtime.order.indexOf('path:userData')).toBeLessThan(runtime.order.indexOf('ready'));
    expect(runtime.order.indexOf('path:sessionData')).toBeLessThan(runtime.order.indexOf('ready'));
    for (const name of ['native-startup.json', 'native-ready.json']) expect(JSON.parse(readFileSync(join(profile, name), 'utf8'))).toMatchObject({ schema: 'wayfarer.native-qa/v1', pid: process.pid, version: '0.7.0', profileDir: profile, userData: profile, sessionData: profile, isPackaged: true, qa: { mode: 'fixture', universePort: 26670, worldPort: 27000, assetPort: 27400 } });
    expect(runtime.windows[0].options).toMatchObject({ title: 'Wayfarer · Isolated QA', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const event = { preventDefault: vi.fn() }; runtime.windows[0].events.get('page-title-updated')(event); expect(event.preventDefault).toHaveBeenCalledOnce();
  });
  it('blocks the saved primary Universe before invoking the protocol adapter', async () => {
    await start(); await expect(runtime.handlers.get('wayfarer:command')!(sender(), connect(16670))).rejects.toThrow(/own loopback/); expect(runtime.command).not.toHaveBeenCalled();
    await runtime.handlers.get('wayfarer:command')!(sender(), connect(26670)); expect(runtime.command).toHaveBeenCalledWith(connect(26670));
  });
  it('passes the World destination guard to AxisClient rather than the window constructor', async () => {
    await start(); expect(runtime.policy?.authorizeWorldConnection).toBeTypeOf('function');
    expect(() => runtime.policy!.authorizeWorldConnection({ host: '127.0.0.1', port: 17000, tls: false })).toThrow();
    expect(() => runtime.policy!.authorizeWorldConnection({ host: '127.0.0.1', port: 27000, tls: false })).not.toThrow();
  });
  it('never calls the ordinary redirect-following fetcher in native QA', async () => {
    const fetch = vi.fn(async () => new Response('original')); vi.stubGlobal('fetch', fetch); await start();
    await expect(runtime.handlers.get('wayfarer:asset')!(sender(), 'http://127.0.0.1:17400/model')).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
    await runtime.handlers.get('wayfarer:asset')!(sender(), 'http://127.0.0.1:27400/model');
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:27400/model', expect.objectContaining({ redirect: 'error', credentials: 'omit' })); expect(runtime.ordinaryAsset).not.toHaveBeenCalled();
  });
  it('offline QA denies every connection and external asset, while ordinary startup is unchanged', async () => {
    process.argv = ['Wayfarer', '--profile-dir=' + profile, '--qa-offline']; await start();
    await expect(runtime.handlers.get('wayfarer:command')!(sender(), connect(26670))).rejects.toThrow(/offline/);
    await expect(runtime.handlers.get('wayfarer:asset')!(sender(), 'http://127.0.0.1:27400/model')).rejects.toThrow(/offline/);
    expect(runtime.command).not.toHaveBeenCalled(); expect(runtime.ordinaryAsset).not.toHaveBeenCalled();
  });
  it('retains unscoped ordinary startup and its normal asset fetcher', async () => {
    process.argv = ['Wayfarer']; await start(); expect(runtime.paths.size).toBe(0); expect(runtime.windows[0].options.title).toBe('Wayfarer');
    await runtime.handlers.get('wayfarer:command')!(sender(), connect(16670)); expect(runtime.command).toHaveBeenCalled();
    await runtime.handlers.get('wayfarer:asset')!(sender(), 'https://assets.example/model'); expect(runtime.ordinaryAsset).toHaveBeenCalledWith('https://assets.example/model');
  });
  it('still rejects untrusted frames and malformed commands before any adapter work', async () => {
    await start();
    await expect(runtime.handlers.get('wayfarer:command')!({ ...sender(), senderFrame: { url: sender().senderFrame.url } }, connect(26670))).rejects.toThrow(/Untrusted/);
    await expect(runtime.handlers.get('wayfarer:command')!(sender(), { type: 'invalid' })).rejects.toThrow(); expect(runtime.command).not.toHaveBeenCalled();
  });
  it('exits on bad QA arguments before creating a window or registering IPC', async () => {
    process.argv = ['Wayfarer', '--qa-network=16670,27000,27400'];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { await expect(import('../src/main/main')).rejects.toThrow(); expect(runtime.exit).toHaveBeenCalledWith(1); expect(runtime.windows).toHaveLength(0); expect(runtime.handlers.size).toBe(0); }
    finally { consoleError.mockRestore(); }
  });
});
