import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientEvent } from '../src/shared/types';
import type { TerrainSetCommand } from '../src/shared/terrain-edit';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(value: string) { this.sent.push(value); }
  open() { this.readyState = 1; this.onopen?.(); }
  error() { this.onerror?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  reply(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

beforeEach(() => {
  vi.resetModules(); FakeWebSocket.instances = [];
  vi.stubGlobal('window', {});
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:5173' });
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => { vi.unstubAllGlobals(); if (vi.isFakeTimers()) { vi.clearAllTimers(); vi.useRealTimers(); } });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('PreviewBridge connection lifecycle', () => {
  it('uses the replacement socket when an old failed handshake closes later', async () => {
    const { bridge } = await import('../src/renderer/client');
    const first = bridge.command({ type: 'disconnect' });
    const old = FakeWebSocket.instances[0]; old.error();
    await expect(first).rejects.toThrow(/unavailable/);

    const events: ClientEvent[] = [];
    const unsubscribe = bridge.subscribe(event => events.push(event));
    const pending = bridge.command({ type: 'disconnect' }).then(() => ({ ok: true }), error => ({ ok: false, error: String(error) }));
    const replacement = FakeWebSocket.instances[1]; replacement.open();
    await flush();
    const request = JSON.parse(replacement.sent[0]);
    old.close();
    replacement.reply({ id: request.id, ok: true });
    expect(await pending).toEqual({ ok: true });
    expect(events.filter(event => event.type === 'status' && event.phase === 'disconnected')).toEqual([]);
    unsubscribe(); replacement.close();
  });

  it('rejects outstanding commands when their active socket closes', async () => {
    const { bridge } = await import('../src/renderer/client');
    const pending = bridge.command({ type: 'disconnect' }).catch(error => error as Error);
    const socket = FakeWebSocket.instances[0]; socket.open(); await flush(); socket.close();
    expect(await pending).toBeInstanceOf(Error);
  });
});

describe('PreviewBridge command deadlines', () => {
  beforeEach(() => vi.useFakeTimers());
  const terrain: TerrainSetCommand = {
    type: 'terrain-set', requestId: 'terrain-timeout', world: 'Haven', session: 41,
    cellX: 0, cellZ: 0, heights: [.01], texture: 0, previousHeights: [0], previousTextures: [0],
  };

  it('allows terrain readback beyond 35 seconds and rejects only at 70 with uncertainty guidance', async () => {
    const { bridge } = await import('../src/renderer/client');
    const resolved = vi.fn(), rejected = vi.fn();
    const pending = bridge.command(terrain).then(resolved, rejected);
    const socket = FakeWebSocket.instances[0]; socket.open(); await flush();
    expect(socket.sent).toHaveLength(1); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(resolved).not.toHaveBeenCalled(); expect(rejected).not.toHaveBeenCalled();
    expect(Reflect.get(bridge, 'pending').size).toBe(1);
    await vi.advanceTimersByTimeAsync(34_999); expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(rejected).toHaveBeenCalledTimes(1);
    expect((rejected.mock.calls[0][0] as Error).message).toMatch(/Terrain confirmation timed out.*Re-enter.*inspect.*uncertain/);
    expect(resolved).not.toHaveBeenCalled(); expect(Reflect.get(bridge, 'pending').size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    // A timeout is not an automatic retry; a late ACK cannot change the outcome.
    socket.reply({ id: JSON.parse(socket.sent[0]).id, ok: true }); await flush();
    expect(socket.sent).toHaveLength(1); expect(resolved).not.toHaveBeenCalled(); socket.close();
  });

  it('still accepts terrain confirmation just before 70 seconds and clears its timeout', async () => {
    const { bridge } = await import('../src/renderer/client');
    const pending = bridge.command(terrain);
    const socket = FakeWebSocket.instances[0]; socket.open(); await flush();
    await vi.advanceTimersByTimeAsync(69_999);
    socket.reply({ id: JSON.parse(socket.sent[0]).id, ok: true }); await expect(pending).resolves.toBeUndefined();
    expect(Reflect.get(bridge, 'pending').size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(70_000); expect(socket.sent).toHaveLength(1); socket.close();
  });

  it('preserves the 35-second deadline and ordinary error for standard commands', async () => {
    const { bridge } = await import('../src/renderer/client');
    const rejected = vi.fn(), pending = bridge.command({ type: 'query', x: 0, z: 0 }).catch(rejected);
    const socket = FakeWebSocket.instances[0]; socket.open(); await flush();
    await vi.advanceTimersByTimeAsync(34_999); expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(rejected).toHaveBeenCalledTimes(1); expect((rejected.mock.calls[0][0] as Error).message).toBe('The server did not answer in time.');
    expect(Reflect.get(bridge, 'pending').size).toBe(0); expect(vi.getTimerCount()).toBe(0); expect(socket.sent).toHaveLength(1); socket.close();
  });

  it('keeps independent deadlines for simultaneous standard and terrain commands', async () => {
    const { bridge } = await import('../src/renderer/client');
    const terrainRejected = vi.fn(), ordinaryRejected = vi.fn();
    const terrainPending = bridge.command(terrain).catch(terrainRejected);
    const ordinaryPending = bridge.command({ type: 'chat', text: 'fixture-only fake socket' }).catch(ordinaryRejected);
    const socket = FakeWebSocket.instances[0]; socket.open(); await flush();
    expect(socket.sent).toHaveLength(2); expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(35_000); await ordinaryPending;
    expect(ordinaryRejected).toHaveBeenCalledTimes(1); expect(terrainRejected).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    socket.close(); await terrainPending;
    expect((terrainRejected.mock.calls[0][0] as Error).message).toContain('bridge closed');
    expect(vi.getTimerCount()).toBe(0); expect(Reflect.get(bridge, 'pending').size).toBe(0);
    await vi.advanceTimersByTimeAsync(70_000); expect(terrainRejected).toHaveBeenCalledTimes(1);
  });
});
