type Job = { start: () => void };

/** Shared preview-only budget. Cancelling a queued job removes it immediately.
 * Already-started bridge requests cannot be aborted by today's AssetFetcher;
 * their slot stays occupied until actual work settles, even after cancellation.
 */
export class PreviewWorkQueue {
  private active = 0;
  private pending: Job[] = [];
  constructor(private concurrency = 2, private maxPending = 32) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxPending) || maxPending < 0) throw new Error('Invalid preview queue limits');
  }
  run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error('Preview cancelled.'));
    if (this.active >= this.concurrency && this.pending.length >= this.maxPending) return Promise.reject(new Error('Preview queue is full. Wait for current downloads to finish.'));
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const cancel = () => {
        if (!started) {
          const index = this.pending.indexOf(job); if (index >= 0) this.pending.splice(index, 1);
        }
        reject(new Error('Preview cancelled.'));
      };
      const job: Job = { start: () => {
        started = true; this.active++;
        Promise.resolve().then(() => {
          if (signal.aborted) throw new Error('Preview cancelled.');
          return task();
        }).then(resolve, reject).finally(() => {
          signal.removeEventListener('abort', cancel);
          this.active--;
          while (this.active < this.concurrency && this.pending.length) this.pending.shift()!.start();
        });
      } };
      signal.addEventListener('abort', cancel, { once: true });
      if (this.active < this.concurrency) job.start(); else this.pending.push(job);
    });
  }
}

// Shared by every ModelPreviewSession, not recreated on each user click.
export const previewWorkQueue = new PreviewWorkQueue();
