import { describe, expect, it, vi } from 'vitest';
import { PreviewWorkQueue } from '../src/renderer/engine/preview-work-queue';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('shared bounded preview work', () => {
  it('cancels queued work immediately without executing it', async () => {
    const queue = new PreviewWorkQueue(1), first = deferred<number>(), cancellation = new AbortController();
    const active = queue.run(new AbortController().signal, () => first.promise);
    const task = vi.fn(async () => 2), queued = queue.run(cancellation.signal, task);
    cancellation.abort(); await expect(queued).rejects.toThrow('cancelled');
    first.resolve(1); expect(await active).toBe(1); await flush(); expect(task).not.toHaveBeenCalled();
  });
  it('retains an in-flight slot after cancellation until actual work settles', async () => {
    const queue = new PreviewWorkQueue(1), first = deferred<number>(), cancellation = new AbortController();
    const active = queue.run(cancellation.signal, () => first.promise); await flush();
    cancellation.abort(); await expect(active).rejects.toThrow('cancelled');
    const task = vi.fn(async () => 2), queued = queue.run(new AbortController().signal, task);
    await flush(); expect(task).not.toHaveBeenCalled();
    first.resolve(1); expect(await queued).toBe(2); expect(task).toHaveBeenCalledTimes(1);
  });
  it('enforces capacity and releases slots after both resolution and failure', async () => {
    const queue = new PreviewWorkQueue(1, 1), first = deferred<number>(), signal = new AbortController().signal;
    const active = queue.run(signal, () => first.promise), queued = queue.run(signal, async () => { throw new Error('decode failed'); });
    const rejected = expect(queued).rejects.toThrow('decode failed');
    await expect(queue.run(signal, async () => 3)).rejects.toThrow('queue is full');
    first.resolve(1); await active; await rejected; await flush();
    expect(await queue.run(signal, async () => 4)).toBe(4);
  });
  it('never starts already aborted tasks and validates its limits', async () => {
    const cancellation = new AbortController(); cancellation.abort(); const task = vi.fn(async () => 1);
    await expect(new PreviewWorkQueue().run(cancellation.signal, task)).rejects.toThrow('cancelled');
    expect(task).not.toHaveBeenCalled();
    expect(() => new PreviewWorkQueue(0)).toThrow('Invalid'); expect(() => new PreviewWorkQueue(1, -1)).toThrow('Invalid');
  });
});
