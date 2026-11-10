// SPDX-License-Identifier: 0BSD
// Memory-leak checks of long-lived sessions through the wasm bindings: one
// stream, resampler or chunk encoder fed many pushes. wasm memory only grows,
// so a leak of even a few bytes per push eventually takes another page. After
// a warm-up that sizes every buffer, the memory must not grow at all. (The
// setup file already checks that every test frees its wasm objects; the Rust
// tests in tests/leaks.rs count the core's heap bytes directly.)
import { describe, expect, it } from 'vitest';
import {
  createChunkEncoderSync,
  createResamplerSync,
  encodeStream,
  wasmMemoryBytes,
  type Options,
} from '../../ts/index.js';
import { tier } from '../helpers/tools.js';

/** Pushes after the warm-up. At 8 bytes leaked per push, the quick tier takes 2.4 pages. */
const PUSHES = { quick: 20_000, full: 100_000, soak: 1_000_000 }[tier];
const WARMUP = 200;
/** Frames per push. Odd, so pushes end at every offset within a FLAC block. */
const FRAMES = 251;

/** Interleaved stereo float samples of a sine. */
function sine(frames: number): Float32Array<ArrayBuffer> {
  const s = new Float32Array(frames * 2);
  for (let i = 0; i < s.length; i++) s[i] = 0.5 * Math.sin(i * 0.01);
  return s;
}

/** Runs `step` for the warm-up, then `PUSHES` times; wasm memory must not grow. */
function expectFlat(step: (i: number) => void): void {
  for (let i = 0; i < WARMUP; i++) step(i);
  const settled = wasmMemoryBytes();
  for (let i = 0; i < PUSHES; i++) step(WARMUP + i);
  expect(wasmMemoryBytes() - settled, 'wasm memory growth after the warm-up').toBe(0);
}

describe('long sessions keep wasm memory flat', () => {
  it.each<[string, Options]>([
    ['copy', {}],
    ['resample', { sampleRate: 48_000, resampleQuality: 'fast' }],
    ['requantize', { bitsPerSample: 12 }],
  ])('encodeStream (%s)', async (_, opts) => {
    const s16 = new Int16Array(FRAMES * 2).map((_, i) => Math.round(8000 * Math.sin(i * 0.01)));
    let i = 0;
    let settled = 0;
    let atEnd = 0;
    const input = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i === WARMUP) settled = wasmMemoryBytes();
        if (i === WARMUP + PUSHES) {
          atEnd = wasmMemoryBytes();
          c.close();
          return;
        }
        i++;
        c.enqueue(new Uint8Array(s16.buffer.slice(0)));
      },
    });
    const pcm = { sampleRate: 44_100, channels: 2, format: 's16' } as const;
    let bytes = 0;
    for await (const b of encodeStream(input, { ...opts, pcm })) bytes += b.length;
    expect(bytes).toBeGreaterThan(0);
    expect(atEnd - settled, 'wasm memory growth after the warm-up').toBe(0);
  });

  it.each([
    [44_100, 48_000],
    [48_000, 16_000],
  ])('resampler %i → %i Hz', (inputRate, outputRate) => {
    const input = sine(FRAMES);
    using r = createResamplerSync({ inputRate, outputRate, channels: 2, quality: 'fast' });
    let n = 0;
    expectFlat(() => (n += r.push(input).length));
    n += r.flush().length;
    expect(n).toBeGreaterThan(0);
  });

  it('chunk encoder cut on every push', () => {
    const input = sine(FRAMES);
    using e = createChunkEncoderSync({
      inputRate: 44_100,
      channels: 2,
      bitsPerSample: 16,
      sampleRate: 48_000,
    });
    let files = 0;
    expectFlat(() => void (e.encode(input) !== null && files++));
    e.finish();
    // The resampler lags, so not every push completes a file.
    expect(files).toBeGreaterThan(PUSHES / 10);
  });

  it('exact chunk encoder', () => {
    const input = sine(FRAMES);
    using e = createChunkEncoderSync({
      inputRate: 44_100,
      channels: 2,
      bitsPerSample: 16,
      chunkSamples: 4_000,
    });
    let files = 0;
    expectFlat(() => (files += e.encode(input).length));
    files += e.finish().length;
    expect(files).toBe(Math.ceil(((WARMUP + PUSHES) * FRAMES) / 4_000));
  });

  it('callback chunk encoder', () => {
    const input = sine(FRAMES);
    let files = 0;
    using e = createChunkEncoderSync({
      inputRate: 44_100,
      channels: 2,
      bitsPerSample: 16,
      chunkSamples: 4_000,
      onChunk: () => void files++,
    });
    expectFlat(() => e.push(input));
    e.finish();
    expect(files).toBeGreaterThan(0);
  });
});
