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
 * in FIFO order while all workers are busy. A worker that crashed is replaced.
 */
export function createEncoderPool(size = Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1)) {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`pool size must be a positive integer, got ${size}`);
  }
  const workers = new Set(Array.from({ length: size }, () => createWorkerEncoder()));
  const idle = [...workers];
  const waiting = []; // { resolve, reject } of jobs waiting for a worker
  let closed = false;
  const terminated = () => new DOMException('The pool was terminated.', 'AbortError');

  const acquire = () => {
    if (closed) return Promise.reject(terminated());
    const w = idle.shift();
    return w !== undefined ? Promise.resolve(w) : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  const release = (w) => {
    if (closed) return;
    const next = waiting.shift();
    if (next !== undefined) next.resolve(w);
    else idle.push(w);
  };
  // After a failed job, check that the worker is still alive:
  // wasmMemoryBytes() rejects only once the worker has crashed or was terminated.
  const check = async (w) => {
    try {
      await w.wasmMemoryBytes();
      return w;
    } catch {
      w.terminate();
      workers.delete(w);
      if (closed) return w;
      const fresh = createWorkerEncoder();
      workers.add(fresh);
      return fresh;
    }
  };

  return {
    async encode(input, options) {
      const w = await acquire();
      try {
        const flac = await w.encode(input, options);
        release(w);
        return flac;
      } catch (e) {
        release(await check(w));
        throw e;
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

Encode a batch, and get the results back in input order. `Promise.allSettled`
keeps the other results when a file fails; with `Promise.all`, one bad file
would lose them all:

```js
const pool = createEncoderPool();
let results;
try {
  results = await Promise.allSettled(files.map((wav) => pool.encode(wav, { compressionLevel: 8 })));
} finally {
  pool.terminate();
}
// results[i] is the outcome for files[i].
for (const [i, r] of results.entries()) {
  if (r.status === 'rejected') console.error(`file ${i} failed`, r.reason);
}
```

Or keep one pool for the lifetime of the page and call `pool.encode()`
whenever a new recording comes in.

## Things to know

- **Pool size.** Leaving one core for the UI thread is a good default, and
  never fewer than one worker. More workers than cores doesn't make encoding
  faster. Each worker costs a thread and its own wasm memory, a few MiB.
- **Memory.** Up to `size` jobs run at once. Each running job holds its
  input and its growing output in JS memory until it finishes, so peak memory
  is roughly the sum of the `size` largest jobs in flight. The encoder's own
  state in wasm memory is small and doesn't depend on the job size.
- **Transfers.** In-memory input is transferred to the worker, which detaches
  your copy, when the job *starts*, not when you call `pool.encode()`. Pass
  `copy: true` to keep it.
- **Cancelling.** `signal` works as usual. A job whose signal aborts while it
  waits for a worker rejects as soon as it gets one.
- **Crashes.** If a worker crashes, for example because it runs out of
  memory, its job rejects and so would every later job sent to it. A job can
  also fail while its worker is fine: the input is not a valid WAV, the
  signal aborted, or `onProgress` threw. So after a failed job, the pool asks
  the worker for `wasmMemoryBytes()`, which only fails once the worker is
  dead, and replaces a dead worker with a fresh one.
- **Node.** The same code works with `worker_threads`.
  `navigator.hardwareConcurrency` is available in Node ≥ 21, or use
  `os.availableParallelism()`.
