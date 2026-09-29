<!-- SPDX-License-Identifier: 0BSD -->
# Concurrent encodes

wav2flac doesn't queue or lock anything. Each `encode()` or `encodeStream()`
call gets its own encoder instance. If you start several calls without
awaiting them, what happens depends on the thread they run on.

## On one thread: interleaved, not parallel

This covers the main thread and any single `createWorkerEncoder()`.

```js
const [a, b, c] = await Promise.all([encode(x), encode(y), encode(z)]);
```

- **All three start immediately.** They start in call order, once the wasm
  is loaded.
- **They take turns.** Each job feeds its input to wasm in 64 KiB slices and
  yields to the event loop about every 8 ms. It yields through a macrotask,
  so timers, input events and the other jobs get their turn. The effect is
  roughly round-robin. Only one slice runs at any moment.
- **They finish in any order.** A job resolves when its own input is done.
  A short clip started last usually finishes first, so completion order
  is not FIFO. `Promise.all` still returns results in call order.
- **Total time doesn't go down.** Three interleaved jobs take about as
  long as three sequential ones. You gain responsiveness and overlapping
  progress callbacks, not speed.
- **Memory adds up.** Each running job holds its input and its growing
  output in JS memory until it finishes, so peak memory is about the sum of
  all jobs. The encoders themselves share one wasm memory. With the default
  block size they need well under 1 MiB each. The largest `blockSize`,
  65535, needs much more: with 8 channels, the first job grows the wasm
  memory to up to about 20 MiB, and each more job at once adds about 5 MiB.
  wasm memory never shrinks once it has grown.

Jobs don't share any state, so interleaving is always safe. An error or an
abort in one job doesn't affect the others.

## Across workers: parallel

Each worker from `createWorkerEncoder()` runs on its own thread with its own
wasm memory. The module is compiled once and shared. Jobs on different
workers really do run at the same time, one CPU core each.

## Which one to use

| You want | Use |
|---|---|
| A few encodes that don't block the UI | plain `encode()`, or one worker |
| Faster throughput for many files | a [worker pool](how-to/parallel-encoding.md) |
| One job at a time, finishing in submission order, bounded memory | a [FIFO queue](how-to/fifo-queue.md) |
