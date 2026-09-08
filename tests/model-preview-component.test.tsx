// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ModelPreview } from '../src/renderer/components/ModelPreview';

const recorded = vi.hoisted(() => ({
  renderers: [] as Array<{ dispose: Mock; render: Mock; forceContextLoss: Mock; canvas: HTMLCanvasElement }>,
  failRenderer: false,
}));
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  class Renderer {
    disposed = false;
    canvas: HTMLCanvasElement;
    setPixelRatio = vi.fn();
    setSize = vi.fn();
    render = vi.fn(() => { if (this.disposed) throw new Error('Render after disposal'); });
    dispose = vi.fn(() => { this.disposed = true; });
    forceContextLoss = vi.fn();
    constructor(options: { canvas: HTMLCanvasElement }) {
      if (recorded.failRenderer) throw new Error('WebGL unavailable');
      this.canvas = options.canvas; recorded.renderers.push(this);
    }
  }
  return { ...actual, WebGLRenderer: Renderer };
});

const observers: Array<{ callback: () => void; disconnect: Mock }> = [];
beforeEach(() => {
  recorded.renderers.length = 0; recorded.failRenderer = false; observers.length = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn(); observe = vi.fn();
    constructor(public callback: () => void) { observers.push(this); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const model = 'ModelBegin\nClumpBegin\nVertex 0 0 0\nVertex 1 0 0\nVertex 0 1 0\nTriangle 1 2 3\nClumpEnd\nModelEnd';
const downloaded = { bytes: new TextEncoder().encode(model), contentType: 'text/plain' };

describe('ModelPreview mounted lifecycle with actual Three models and OrbitControls', () => {
  it('reuses one renderer, controls instance and observer across requests without a global animation loop', async () => {
    const connect = vi.spyOn(OrbitControls.prototype, 'connect'), dispose = vi.spyOn(OrbitControls.prototype, 'dispose');
    const asset = vi.fn(async () => downloaded);
    const view = render(<ModelPreview model="wayfarer:cube" objectPath="" asset={asset} requestId={1} />);
    await waitFor(() => expect(screen.getByText('1.00 × 1.00 × 1.00 m')).toBeTruthy());
    for (let requestId = 2; requestId <= 6; requestId++) {
      view.rerender(<ModelPreview model="wayfarer:cube" objectPath="" asset={asset} requestId={requestId} />);
      await waitFor(() => expect(screen.getByText('1.00 × 1.00 × 1.00 m')).toBeTruthy());
    }
    expect(recorded.renderers).toHaveLength(1); expect(connect).toHaveBeenCalledTimes(1); expect(observers).toHaveLength(1);
    expect(asset).not.toHaveBeenCalled(); expect(requestAnimationFrame).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset model preview view' }));
    const renderer = recorded.renderers[0]; expect(renderer.render).toHaveBeenCalled(); view.unmount();
    expect(renderer.dispose).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1); expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(renderer.forceContextLoss).not.toHaveBeenCalled();
    const renders = renderer.render.mock.calls.length;
    act(() => { observers[0].callback(); (connect.mock.contexts[0] as OrbitControls).dispatchEvent({ type: 'change' }); });
    expect(renderer.render).toHaveBeenCalledTimes(renders);
  });
  it('cleans up StrictMode probe resources while keeping the reused canvas usable', async () => {
    const connect = vi.spyOn(OrbitControls.prototype, 'connect'), dispose = vi.spyOn(OrbitControls.prototype, 'dispose');
    const asset = vi.fn(async () => downloaded);
    const view = render(<StrictMode><ModelPreview model="wayfarer:cube" objectPath="" asset={asset} /></StrictMode>);
    await waitFor(() => expect(screen.getByText('1.00 × 1.00 × 1.00 m')).toBeTruthy());
    expect(recorded.renderers).toHaveLength(2);
    expect(recorded.renderers[0].canvas).toBe(recorded.renderers[1].canvas);
    expect(recorded.renderers[0].dispose).toHaveBeenCalledTimes(1); expect(recorded.renderers[1].dispose).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2); expect(dispose).toHaveBeenCalledTimes(1);
    view.unmount(); expect(dispose).toHaveBeenCalledTimes(2);
    for (const renderer of recorded.renderers) { expect(renderer.dispose).toHaveBeenCalledTimes(1); expect(renderer.forceContextLoss).not.toHaveBeenCalled(); }
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
  it('ignores asynchronous model completion after unmount and starts no fallback work', async () => {
    let finish!: (result: typeof downloaded) => void;
    const asset = vi.fn(() => new Promise<typeof downloaded>(resolve => { finish = resolve; }));
    const view = render(<ModelPreview model="piece.rwx" objectPath="https://example.test/" asset={asset} />);
    await waitFor(() => expect(asset).toHaveBeenCalledTimes(1));
    view.unmount(); const renderer = recorded.renderers[0], renders = renderer.render.mock.calls.length;
    await act(async () => { finish(downloaded); for (let i = 0; i < 12; i++) await Promise.resolve(); });
    expect(renderer.render).toHaveBeenCalledTimes(renders); expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(asset).toHaveBeenCalledTimes(1); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('never starts a model download when WebGL initialization fails', async () => {
    recorded.failRenderer = true; const asset = vi.fn(async () => downloaded);
    render(<ModelPreview model="piece.rwx" objectPath="https://example.test/" asset={asset} />);
    expect(screen.getByRole('alert').textContent).toBe('WebGL unavailable'); expect(asset).not.toHaveBeenCalled();
  });
  it('cleans partially initialized controls and renderer immediately if resize setup fails', () => {
    vi.stubGlobal('ResizeObserver', class { constructor() { throw new Error('Resize observer unavailable'); } });
    const dispose = vi.spyOn(OrbitControls.prototype, 'dispose'), asset = vi.fn(async () => downloaded);
    const view = render(<ModelPreview model="piece.rwx" objectPath="https://example.test/" asset={asset} />);
    expect(screen.getByRole('alert').textContent).toBe('Resize observer unavailable');
    expect(recorded.renderers[0].dispose).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1); expect(asset).not.toHaveBeenCalled();
    view.unmount(); expect(recorded.renderers[0].dispose).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
  });
});
