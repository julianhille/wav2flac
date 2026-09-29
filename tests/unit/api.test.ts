// SPDX-License-Identifier: 0BSD
import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { encode, encodeStream, encodeSync, probe, version, Wav2FlacError, wasmMemoryBytes, type Progress } from '../../ts/index.js';
import { liveSessions, PROGRESS_INTERVAL_MS } from '../../ts/lib/engine.js';
import { SLICE_BYTES } from '../../ts/lib/input.js';
import { collect, makeWav, streamOf } from '../helpers/wav.js';
import { flacTest, nativeEncode } from '../helpers/tools.js';

const wav = makeWav({ frames: 44100 * 3, channels: 2, bits: 16, seed: 3 });

/** Byte length of the FLAC metadata (everything before the first frame). */
function metadataLength(flac: Uint8Array): number {
  let o = 4;
  for (;;) {
    const last = (flac[o]! & 0x80) !== 0;
    o += 4 + ((flac[o + 1]! << 16) | (flac[o + 2]! << 8) | flac[o + 3]!);
    if (last) return o;
  }
}

describe('encode / encodeSync / encodeStream', () => {
  it('produce valid, identical frames', async () => {
    const a = await encode(wav);
    const b = encodeSync(wav);
    const c = await collect(encodeStream(wav));
    expect(Array.from(a.subarray(0, 4), (x) => String.fromCharCode(x)).join('')).toBe('fLaC');
    expect(b).toEqual(a);
    expect(c.subarray(metadataLength(c))).toEqual(a.subarray(metadataLength(a)));
    expect(flacTest(a) ?? '').toBe('');
    expect(flacTest(c) ?? '').toBe('');
  });

  it('return bytes backed by a plain ArrayBuffer', async () => {
    const tag = (x: Uint8Array): string => Object.prototype.toString.call(x.buffer);
    expect(tag(await encode(wav))).toBe('[object ArrayBuffer]');
    expect(tag(encodeSync(wav))).toBe('[object ArrayBuffer]');
    for await (const chunk of encodeStream(wav)) expect(tag(chunk)).toBe('[object ArrayBuffer]');
  });

  it('is byte-identical to the native build', async () => {
    const native = nativeEncode(wav, ['--level', '8']);
    if (native === null) return;
    expect(await encode(wav, { compressionLevel: 8 })).toEqual(native);
  });

  it('agrees across paths on input larger than one wasm slice', async () => {
    // 24-bit stereo, so the 1 MiB slice boundary falls inside a sample frame.
    const big = makeWav({ frames: 200_000, channels: 2, bits: 24, seed: 4 });
    expect(big.length).toBeGreaterThan(SLICE_BYTES);
    const ref = encodeSync(big);
    expect(await encode(big)).toEqual(ref);
    expect(await encode(streamOf(big, SLICE_BYTES + 3))).toEqual(ref);
    const st = await collect(encodeStream(big));
    expect(st.subarray(metadataLength(st))).toEqual(ref.subarray(metadataLength(ref)));
    expect(flacTest(ref) ?? '').toBe('');
    const native = nativeEncode(big);
    if (native !== null) expect(ref).toEqual(native);
  });

  it('accepts ArrayBuffer, offset views and streams with any chunking', async () => {
    const ref = encodeSync(wav);
    const padded = new Uint8Array(wav.length + 7);
    padded.set(wav, 7);
    expect(encodeSync(padded.subarray(7))).toEqual(ref);
    expect(encodeSync(wav.slice().buffer)).toEqual(ref);
    for (const size of [1, 4093, 65536, 3 << 20]) {
      const n = size === 1 ? 20_000 : wav.length;
      const part = makeWavPrefix(n);
      expect(await encode(streamOf(part, size))).toEqual(encodeSync(part));
    }
  });

  it('streams from a stream input', async () => {
    const out = await collect(encodeStream(streamOf(wav, 10_000)));
    expect(out.subarray(metadataLength(out))).toEqual(encodeSync(wav).subarray(metadataLength(encodeSync(wav))));
  });

  it('reports throttled, monotonic progress ending at 1', async () => {
    const big = makeWav({ frames: 44100 * 20, signal: 'noise' });
    const seen: Progress[] = [];
    const at: number[] = [];
    await encode(big, { onProgress: (p) => { seen.push(p); at.push(performance.now()); } });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toMatchObject({ fraction: 1, bytesIn: big.length, samplesOut: 44100 * 20 });
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.bytesIn).toBeGreaterThanOrEqual(seen[i - 1]!.bytesIn);
      expect(seen[i]!.samplesOut).toBeGreaterThanOrEqual(seen[i - 1]!.samplesOut);
      expect(seen[i]!.fraction!).toBeGreaterThanOrEqual(seen[i - 1]!.fraction!);
      // Only the final, forced report may come sooner than the interval.
      if (i < seen.length - 1) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(PROGRESS_INTERVAL_MS - 1);
    }
    const sync: Progress[] = [];
    encodeSync(wav, { onProgress: (p) => sync.push(p) });
    expect(sync.at(-1)?.fraction).toBe(1);
    const st: Progress[] = [];
    await collect(encodeStream(wav, { onProgress: (p) => st.push(p) }));
    expect(st.at(-1)?.fraction).toBe(1);
  });

  it('reports fraction null before the header is known', async () => {
    const seen: Progress[] = [];
    await encode(streamOf(wav, 16), { onProgress: (p) => seen.push(p) });
    expect(seen[0]).toMatchObject({ fraction: null });
  });

  it('surfaces errors as Wav2FlacError', async () => {
    await expect(encode(new Uint8Array(100))).rejects.toMatchObject({ code: 'INVALID_WAV' });
    await expect(encode(wav.subarray(0, 30))).rejects.toMatchObject({ code: 'TRUNCATED' });
    const f = makeWav({ frames: 1000, bits: 32, float: true });
    expect(() => encodeSync(f)).toThrow(Wav2FlacError);
    expect(encodeSync(f, { bitsPerSample: 24 }).length).toBeGreaterThan(0);
    await expect(encode(wav, { maxInputBytes: 1000 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(encode(wav, { compressionLevel: 9 })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(encode(wav, { nope: 1 } as never)).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(collect(encodeStream(new Uint8Array(100)))).rejects.toMatchObject({ code: 'INVALID_WAV' });
    // encodeStream never throws: invalid options and bad input error the stream.
    await expect(collect(encodeStream(wav, { compressionLevel: 99 }))).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(collect(encodeStream('x' as never))).rejects.toThrow(TypeError);
    await expect(collect(encodeStream(wav, { blockSize: 15 }))).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(encode('x' as never)).rejects.toThrow(TypeError);
  });

  it('rejects unsupported bit depths with UNSUPPORTED_BIT_DEPTH', async () => {
    // WAVE_FORMAT_EXTENSIBLE with 3 valid bits in a 16-bit container.
    const f = makeWav({ frames: 100, channels: 1, bits: 16, channelMask: 0x4 });
    new DataView(f.buffer).setUint16(38, 3, true);
    await expect(encode(f)).rejects.toMatchObject({ code: 'UNSUPPORTED_BIT_DEPTH' });
    expect(() => encodeSync(f)).toThrow(/4..=32/);
    // 4-bit audio (the minimum) round-trips.
    new DataView(f.buffer).setUint16(38, 4, true);
    for (let i = 68; i < f.length; i += 2) { f[i] = 0; f[i + 1]! &= 0xf0; } // low 12 padding bits stay 0
    expect((await encode(f)).length).toBeGreaterThan(0);
  });

  it('aborts: before start, during encode and during streaming', async () => {
    const reason = new Error('stop');
    await expect(encode(wav, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(() => encodeSync(wav, { signal: AbortSignal.abort(reason) })).toThrow(reason);
    await expect(collect(encodeStream(wav, { signal: AbortSignal.abort(reason) }))).rejects.toBe(reason);

    const ac = new AbortController();
    const slow = streamOf(wav, 4096);
    const p = encode(slow, { signal: ac.signal, onProgress: () => ac.abort(reason) });
    await expect(p).rejects.toBe(reason);

    const ac2 = new AbortController();
    const s = encodeStream(streamOf(wav, 4096), { signal: ac2.signal });
    const r = s.getReader();
    await r.read();
    ac2.abort(reason);
    await expect(r.read()).rejects.toBe(reason);
  });

  it('aborts and cancels while the input read is stalled', async () => {
    const reason = new Error('stop');
    let cancelled: unknown;
    const stalled = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(wav.subarray(0, 4096)); },
      cancel(r) { cancelled = r; },
    }, { highWaterMark: 0 });

    const ac = new AbortController();
    const p = encode(stalled(), { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(cancelled).toBe(reason);

    cancelled = undefined;
    const r = encodeStream(stalled()).getReader();
    await r.read(); // header
    const pending = r.read();
    await new Promise((res) => setTimeout(res, 20));
    await r.cancel(reason);
    expect((await pending).done).toBe(true);
    expect(cancelled).toBe(reason);
  });

  it('frees the encoder synchronously on every exit path', async () => {
    const reason = new Error('stop');
    const erroring = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(wav.subarray(0, 8192)); },
      pull(c) { c.error(new Error('src')); },
    });
    const paths: [string, () => Promise<unknown>][] = [
      ['encode', () => encode(wav)],
      ['encode, invalid WAV', () => encode(new Uint8Array(100)).catch(() => 0)],
      ['encode, truncated', () => encode(streamOf(wav.subarray(0, 5001), 1000)).catch(() => 0)],
      ['encode, input error', () => encode(erroring()).catch(() => 0)],
      ['encode, aborted', async () => {
        const ac = new AbortController();
        await encode(streamOf(wav, 4096), { signal: ac.signal, onProgress: () => ac.abort(reason) }).catch(() => 0);
      }],
      ['encodeSync', async () => encodeSync(wav)],
      ['encodeSync, throws', async () => { expect(() => encodeSync(wav.subarray(0, 5001))).toThrow(); }],
      ['encodeSync, callback throws', async () => {
        expect(() => encodeSync(wav, { onProgress: () => { throw reason; } })).toThrow(reason);
      }],
      ['encodeStream', () => collect(encodeStream(streamOf(wav, 4096)))],
      ['encodeStream, truncated', () => collect(encodeStream(wav.subarray(0, 5001))).catch(() => 0)],
      ['encodeStream, input error', () => collect(encodeStream(erroring())).catch(() => 0)],
      ['encodeStream, cancelled before reading', () => encodeStream(streamOf(wav, 4096)).cancel(reason)],
      ['encodeStream, cancelled after a read', async () => {
        const r = encodeStream(streamOf(wav, 4096)).getReader();
        await r.read();
        await r.cancel(reason);
      }],
      ['encodeStream, aborted mid-stream', async () => {
        const ac = new AbortController();
        const r = encodeStream(streamOf(wav, 4096), { signal: ac.signal }).getReader();
        await r.read();
        ac.abort(reason);
        await r.read().catch(() => 0);
      }],
    ];
    for (const [name, run] of paths) {
      await run();
      expect(liveSessions(), name).toBe(0);
    }
  });

  it('removes its abort listeners from a long-lived signal', async () => {
    const signal = new AbortController().signal;
    await encode(wav, { signal });
    await encode(streamOf(wav, 65536), { signal });
    await encode(streamOf(new Uint8Array(100), 7), { signal }).catch(() => 0);
    encodeSync(wav, { signal });
    await collect(encodeStream(streamOf(wav, 65536), { signal }));
    await collect(encodeStream(new Uint8Array(100), { signal })).catch(() => 0);
    await encodeStream(streamOf(wav, 4096), { signal }).cancel();
    const r = encodeStream(streamOf(wav, 4096), { signal }).getReader();
    await r.read();
    await r.cancel();
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('does not grow wasm memory over repeated runs (incl. failures)', async () => {
    for (let i = 0; i < 3; i++) encodeSync(wav);
    const before = wasmMemoryBytes();
    for (let i = 0; i < 100; i++) {
      encodeSync(wav);
      await encode(wav);
      await expect(encode(wav.subarray(0, 5000))).rejects.toBeDefined();
    }
    expect(wasmMemoryBytes()).toBe(before);
  });

  it.each([
    ['encode', (w: Uint8Array) => encode(w)],
    ['encodeStream', (w: Uint8Array) => collect(encodeStream(w))],
  ])('%s lets timers run while it works', async (_, run) => {
    const wav = makeWav({ frames: 44100 * 20 });
    let firedAt = Infinity;
    const job = run(wav);
    setTimeout(() => { firedAt = performance.now(); }, 0);
    await job;
    expect(firedAt).toBeLessThan(performance.now());
  });

  it('keeps concurrent encodes separate', async () => {
    const inputs = Array.from({ length: 12 }, (_, i) => makeWav({ frames: 20_000 + i * 997, channels: 1 + (i % 3), seed: i }));
    const outs = await Promise.all(inputs.map((w) => encode(streamOf(w, 8192))));
    outs.forEach((o, i) => expect(o).toEqual(encodeSync(inputs[i]!)));
  });

  it('probes headers from a prefix', async () => {
    const big = makeWav({ frames: 44100 * 5, channels: 6, bits: 24, rate: 48000, channelMask: 0x3f });
    await expect(probe(big)).resolves.toMatchObject({
      sampleRate: 48000, channels: 6, bitsPerSample: 24, format: 'int', frames: 44100 * 5, channelMask: 0x3f,
    });
    await expect(probe(big.subarray(0, 68).slice().buffer)).resolves.toMatchObject({ channels: 6 });
    await expect(probe(big.subarray(0, 10))).rejects.toMatchObject({ code: 'TRUNCATED' });
    await expect(probe(new Uint8Array(100))).rejects.toMatchObject({ code: 'INVALID_WAV' });
  });

  it('probes headers larger than its first 64 KiB read', async () => {
    const plain = makeWav({ frames: 1000, channels: 1 });
    // One and two retries (64 KiB → 256 KiB → 1 MiB, capped at the length).
    for (const junk of [70_000, 300_000]) {
      const b = new Uint8Array(plain.length + 8 + junk);
      b.set(plain.subarray(0, 12));
      b.set(new TextEncoder().encode('JUNK'), 12);
      new DataView(b.buffer).setUint32(16, junk, true);
      b.set(plain.subarray(12), 20 + junk);
      new DataView(b.buffer).setUint32(4, b.length - 8, true);
      await expect(probe(b)).resolves.toMatchObject({ channels: 1, frames: 1000 });
      await expect(probe(b.subarray(0, 20 + junk))).rejects.toMatchObject({ code: 'TRUNCATED' });
    }
  });

  it('reports the version', () => {
    expect(version()).toMatch(/^wav2flac \d+\.\d+\.\d+ \(libflac-rs/);
  });
});

/** A valid WAV of `n` bytes at most (whole frames). */
function makeWavPrefix(n: number): Uint8Array {
  return makeWav({ frames: Math.max(0, Math.floor((n - 44) / 4)), seed: 9 });
}
