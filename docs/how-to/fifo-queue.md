<!-- SPDX-License-Identifier: 0BSD -->
# Encode one at a time with a FIFO queue

Concurrent calls to `encode()` all start at once and
[finish in any order](../concurrency.md#on-one-thread-interleaved-not-parallel).
To run them strictly one after another, in the order you submit them,
chain each job onto the previous one:

```js
import { encode } from 'wav2flac';

/**
 * Wraps an encode function so calls run one at a time, in call order. A
 * failed job rejects its own promise and the queue moves on.
 */
export function createQueue(run) {
  let tail = Promise.resolve();
  return (input, options) => {
    const job = tail.then(() => run(input, options));
    tail = job.catch(() => {});
    return job;
  };
}

const enqueue = createQueue(encode);

// Each call returns right away; the jobs run one after another.
const first = enqueue(wavA, { compressionLevel: 8 });
const second = enqueue(wavB, { compressionLevel: 8 });
```

Each promise resolves in submission order, so you can act on results as they
arrive, for example uploading each file as soon as it's ready:

```js
for (const rec of recordings) {
  enqueue(rec, { pcm: { sampleRate: 48000, channels: 1 }, bitsPerSample: 16 })
    .then((flac) => upload(flac))
    .catch((e) => console.error('encode failed', e));
}
```

To keep the page responsive during long jobs, run the queue in a worker:

```js
import { createWorkerEncoder } from 'wav2flac';

const worker = createWorkerEncoder();
const enqueue = createQueue((input, options) => worker.encode(input, options));
```

## Why use a queue

- **Bounded memory.** Only one encoder is alive at a time, so peak memory is
  set by the largest job, not the sum of all jobs.
- **Ordered results.** Jobs start and finish in the order you submitted them.
- **Same total time.** On one thread, interleaved jobs aren't faster anyway.
  A queue gives the first result sooner, because the first job doesn't share
  the CPU with the others. For speed, use a
  [worker pool](parallel-encoding.md). Its jobs also wait in FIFO order, but
  up to `size` of them run at once.

## Things to know

- **Stream inputs wait too.** A `ReadableStream` isn't read until its job
  starts. A live source, such as a `MediaRecorder` or a network response,
  buffers in the meantime. Queue finished recordings, or use
  `encodeStream()` directly for live input.
- **Cancelling.** A job whose `signal` aborts while it waits rejects with the
  abort reason when its turn comes, without encoding anything.
- **Errors don't block the queue.** A failed job rejects its own promise, and
  the next job starts as usual.
