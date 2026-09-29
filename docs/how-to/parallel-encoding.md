<!-- SPDX-License-Identifier: 0BSD -->
# Encode in parallel with a worker pool

Calls to `encode()` on one thread
[take turns](../concurrency.md#on-one-thread-interleaved-not-parallel)
rather than run at the same time. To use several CPU cores, spread the jobs
over several workers. This pool keeps a fixed number of workers. It hands
each job to the next idle worker, and jobs wait in FIFO order while all
workers are busy.

```js
import { createWorkerEncoder } from 'wav2flac';

/**
 * A fixed set of workers. `encode()` runs on the next idle worker; jobs wait
 * in FIFO order while all workers are busy.
 */
export function createEncoderPool(size = Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1)) {
  const workers = Array.from({ length: size }, () => createWorkerEncoder());
  const idle = [...workers];
  const waiting = []; // { resolve, reject } of jobs waiting for a worker
  let closed = false;
  const terminated = () => new DOMException('The pool was terminated.', 'AbortError');

  const acquire = () => {
    if (closed) return Promise.reject(terminated());
    const w = idle.pop();
    return w !== undefined ? Promise.resolve(w) : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  const release = (w) => {
    const next = waiting.shift();
    if (next !== undefined) next.resolve(w);
    else idle.push(w);
  };

  return {
    async encode(input, options) {
      const w = await acquire();
      try {
        return await w.encode(input, options);
      } finally {
        release(w);
      }
    },
    terminate() {
      closed = true;
      for (const { reject } of waiting.splice(0)) reject(terminated());
      for (const w of workers) w.terminate();
    },
  };
}
```

Encode a batch, and get the results back in input order:

```js
const pool = createEncoderPool();
try {
  const flacs = await Promise.all(files.map((wav) => pool.encode(wav, { compressionLevel: 8 })));
} finally {
  pool.terminate();
}
```

Or keep one pool for the lifetime of the page and call `pool.encode()`
whenever a new recording comes in.

## Things to know

- **Pool size.** Leaving one core for the UI thread is a good default.
  More workers than cores doesn't make encoding faster. Each worker costs a
  thread and its own wasm memory, which grows to fit its largest job and
  never shrinks.
- **Memory.** Up to `size` jobs run at once, so peak memory is roughly the
  sum of the `size` largest jobs in flight.
- **Transfers.** In-memory input is transferred to the worker, which detaches
  your copy, when the job *starts*, not when you call `pool.encode()`. Pass
  `copy: true` to keep it.
- **Cancelling.** `signal` works as usual. A job whose signal aborts while it
  waits for a worker rejects as soon as it gets one.
- **Crashes.** If a worker crashes, every later job sent to it rejects. For a
  long-lived pool, replace a worker whose job failed with a plain `Error`
  (not a `Wav2FlacError`) with a fresh `createWorkerEncoder()`.
- **Node.** The same code works with `worker_threads`.
  `navigator.hardwareConcurrency` is available in Node ≥ 21, or use
  `os.availableParallelism()`.
