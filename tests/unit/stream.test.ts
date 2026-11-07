// SPDX-License-Identifier: 0BSD
// The stateful resampler and the chunk encoder. Their contract: however the
// input is split, the output is that of one `encode()` of the whole signal.
import fc from 'fast-check';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createChunkEncoder,
  createChunkEncoderSync,
  createResampler,
  createResamplerSync,
  encodeSync,
  init,
  wasmMemoryBytes,
  type Bytes,
  type CallbackChunkEncoder,
  type CallbackChunkEncoderOptions,
  type ChunkEncoder,
  type ChunkEncoderOptions,
  type ExactChunkEncoder,
  type ResampleQuality,
  type ResamplerOutput,
} from '../../ts/index.js';
import { WasmChunkEncoder, WasmResampler } from '../../build/bindgen/wav2flac.js';
import { liveSessions } from '../../ts/lib/engine.js';
import { params } from '../helpers/fc.js';
import { flacDecode, has, tier } from '../helpers/tools.js';
import { rng } from '../helpers/wav.js';

await init();
const QUALITIES: ResampleQuality[] = ['fast', 'balanced', 'best'];
const RATES = [8000, 22050, 44100, 48000, 96000];
const SECONDS = tier === 'quick' ? 1 : 5;

/**
 * Two tones plus a little noise, interleaved.
 * @param rate Sample rate.
 * @param channels Channel count.
 * @param frames Frames.
 * @param seed Noise seed.
 * @returns The samples.
 */
function signal(rate: number, channels: number, frames: number, seed = 1): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const t = i / rate;
      out[i * channels + c] =
        0.45 * Math.sin(2 * Math.PI * (440 + 110 * c) * t) +
        0.3 * Math.sin(2 * Math.PI * 1370 * t) +
        0.05 * (r() * 2 - 1);
    }
  }
  return out;
}

/**
 * Joins typed arrays.
 * @param parts The pieces.
 * @param Ctor Their type.
 * @returns One array.
 */
function concat<T extends Int16Array | Float32Array | Int32Array>(
  parts: readonly T[],
  Ctor: new (n: number) => T,
): T {
  const out = new Ctor(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Splits samples into pieces of the given sizes (cycled), in samples.
 * @param x The samples.
 * @param sizes Piece sizes.
 * @returns The pieces.
 */
function split(x: Float32Array, sizes: readonly number[]): Float32Array[] {
  const out: Float32Array[] = [];
  for (let o = 0, i = 0; o < x.length; i++) {
    const n = sizes[i % sizes.length]!;
    out.push(x.subarray(o, o + n));
    o += n;
  }
  return out;
}

/**
 * Resamples `x` in pieces with a fresh resampler.
 * @param x The samples.
 * @param sizes Piece sizes.
 * @param o Resampler settings.
 * @param o.inputRate Input rate.
 * @param o.channels Channels.
 * @param o.quality Quality.
 * @param o.output Output format.
 * @returns The joined output.
 */
function resample(
  x: Float32Array,
  sizes: readonly number[],
  o: { inputRate: number; channels?: number; quality?: ResampleQuality; output?: ResamplerOutput },
): Int16Array | Float32Array {
  const r = createResamplerSync({ outputRate: 16000, ...o });
  try {
    const parts = split(x, sizes).map((p) => r.push(p));
    parts.push(r.flush());
    return o.output === 'f32'
      ? concat(parts as Float32Array[], Float32Array)
      : concat(parts as Int16Array[], Int16Array);
  } finally {
    r.free();
  }
}

/**
 * Compares two sample arrays.
 * @param a Actual.
 * @param b Expected.
 * @returns `null` when identical, else where they first differ.
 */
function diff(a: ArrayLike<number>, b: ArrayLike<number>): string | null {
  if (a.length !== b.length) return `length ${a.length}, expected ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return `sample ${i}: ${a[i]}, expected ${b[i]}`;
  }
  return null;
}

// First in the file, before other tests grow wasm memory (it never shrinks).
describe('huge pushes', () => {
  it('go into wasm in slices, so wasm memory grows by far less than the input', () => {
    const before = wasmMemoryBytes();
    const r = createResamplerSync({ inputRate: 48000, outputRate: 16000, quality: 'fast' });
    try {
      r.push(new Float32Array(1 << 21).fill(0.1)); // 8 MiB
    } finally {
      r.free();
    }
    expect(wasmMemoryBytes() - before).toBeLessThan(4 << 20);
  });

  // Rule 1 with one big piece: frames of 3 channels straddle the slices.
  it('give the same output as small pushes (3 channels)', () => {
    const x = signal(48000, 3, 100_000);
    for (const output of ['s16', 'f32'] as const) {
      const o = { inputRate: 48000, channels: 3, output };
      expect(diff(resample(x, [x.length], o), resample(x, [128 * 3], o)), output).toBeNull();
    }
    const file = (sizes: number[]): Uint8Array => {
      const e = createChunkEncoderSync({ ...CHUNK_OPTS, channels: 3 });
      try {
        for (const p of split(x, sizes)) e.push(p);
        return e.finish()!;
      } finally {
        e.free();
      }
    };
    expect(file([x.length])).toEqual(file([128 * 3]));
  });

  it('never pass wasm more than 1 MiB in one call', () => {
    const x = signal(48000, 3, 100_000);
    const spies = [
      vi.spyOn(WasmResampler.prototype, 'push'),
      vi.spyOn(WasmChunkEncoder.prototype, 'push'),
    ];
    try {
      const r = createResamplerSync({ inputRate: 48000, outputRate: 16000, channels: 3 });
      const e = createChunkEncoderSync({ ...CHUNK_OPTS, channels: 3 });
      r.push(x);
      e.push(x);
      r.free();
      e.free();
      for (const s of spies) {
        expect(s.mock.calls.length).toBeGreaterThan(1);
        expect(s.mock.calls.every(([a]) => a.length <= 1 << 18)).toBe(true);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe('createResampler', () => {
  it('returns Int16Array by default and Float32Array for output f32', async () => {
    const s16 = await createResampler({ inputRate: 48000, outputRate: 16000 });
    const f32 = await createResampler({ inputRate: 48000, outputRate: 16000, output: 'f32' });
    try {
      const x = signal(48000, 1, 4800);
      const a = s16.push(x);
      const b = f32.push(x);
      expect(a).toBeInstanceOf(Int16Array);
      expect(b).toBeInstanceOf(Float32Array);
      expect(s16.push(new Float32Array(0))).toHaveLength(0);
      expect(s16.flush()).toBeInstanceOf(Int16Array);
      expect(f32.flush()).toBeInstanceOf(Float32Array);
      expect(liveSessions()).toBe(2);
    } finally {
      s16.free();
      f32.free();
      f32.free();
    }
    expect(liveSessions()).toBe(0);
  });

  // Rule 2: the same samples as encode(), checked through the FLAC bytes:
  // encoding the resampled samples losslessly must give encode()'s file.
  // f32 output must be within one 16-bit step of those samples.
  for (const quality of QUALITIES) {
    it(`s16 equals encode() bit for bit, f32 within 1 LSB (${quality})`, () => {
      for (const rate of RATES) {
        const x = signal(rate, 1, rate * SECONDS, rate);
        const pcm = { sampleRate: rate, channels: 1 };
        const whole = encodeSync(x, {
          pcm,
          sampleRate: 16000,
          resampleQuality: quality,
          bitsPerSample: 16,
          dither: 'none',
        });
        const y = resample(x, [128], { inputRate: rate, quality }) as Int16Array;
        const viaResampler = encodeSync(y, { pcm: { sampleRate: 16000, channels: 1 } });
        expect(Buffer.compare(viaResampler, whole), `${rate} Hz`).toBe(0);
        const f32 = resample(x, [128], { inputRate: rate, quality, output: 'f32' });
        expect(f32, `${rate} Hz`).toHaveLength(y.length);
        let worst = 0;
        for (let i = 0; i < y.length; i++) {
          worst = Math.max(worst, Math.abs(f32[i]! * 32768 - y[i]!));
        }
        expect(worst, `${rate} Hz`).toBeLessThanOrEqual(1);
      }
    });
  }

  // Rule 1: the split does not change the output.
  it('gives the same output for any split', () => {
    const rates = fc.constantFrom(8000, 44100, 48000, 96000);
    fc.assert(
      fc.property(
        rates,
        fc.integer({ min: 1, max: 2 }),
        fc.array(fc.integer({ min: 0, max: 3000 }), { minLength: 1, maxLength: 8 }),
        fc.constantFrom<ResampleQuality>(...QUALITIES),
        fc.constantFrom<ResamplerOutput>('s16', 'f32'),
        (rate, channels, sizes, quality, output) => {
          const x = signal(rate, channels, Math.round(rate * 0.3), sizes.length);
          const o = { inputRate: rate, channels, quality, output };
          const sz = sizes.some((n) => n > 0) ? sizes : [1];
          expect(diff(resample(x, sz, o), resample(x, [x.length], o))).toBeNull();
        },
      ),
      params(20),
    );
  });

  it('carries a frame split across pushes over (stereo, odd sizes)', () => {
    const x = signal(48000, 2, 9600);
    const o = { inputRate: 48000, channels: 2 };
    expect(diff(resample(x, [1, 3, 127, 5], o), resample(x, [x.length], o))).toBeNull();
  });

  // Rule 5: about 0.3 % of a core (`npm run bench:stream` measures it). The
  // bound is 2 %, on the best of three runs, so a busy machine passes too.
  it.each(['resampler', 'chunk encoder'])(
    'runs the %s 48 → 16 kHz in 128-frame pushes on under 2 % of a core',
    (kind) => {
      const pushes = split(signal(48000, 1, 48000 * 10), [128]);
      const run = (): number => {
        const start = performance.now();
        if (kind === 'resampler') {
          const r = createResamplerSync({ inputRate: 48000, outputRate: 16000, quality: 'fast' });
          for (const p of pushes) r.push(p);
          r.flush();
          r.free();
        } else {
          const e = createChunkEncoderSync({
            inputRate: 48000,
            sampleRate: 16000,
            bitsPerSample: 16,
            resampleQuality: 'fast',
            chunkSamples: 80000,
          });
          for (const p of pushes) e.encode(p);
          e.finish();
          e.free();
        }
        return performance.now() - start;
      };
      expect(Math.min(run(), run(), run())).toBeLessThan(10_000 * 0.02);
    },
  );

  it('returns all of a big upsampling push at once', () => {
    const r = createResamplerSync({ inputRate: 1000, outputRate: 256000, quality: 'fast' });
    try {
      const n = r.push(new Float32Array(70_000).fill(0.1)).length;
      expect(n).toBeGreaterThan(69_000 * 256);
      expect(n + r.flush().length).toBe(70_000 * 256);
    } finally {
      r.free();
    }
  });

  // Rule 3: exact total length.
  it('makes 80000 samples of 5 s at 44.1 and 48 kHz', () => {
    for (const rate of [44100, 48000]) {
      expect(resample(new Float32Array(rate * 5), [128], { inputRate: rate })).toHaveLength(80000);
    }
  });

  it('passes samples through at equal rates', () => {
    const r = createResamplerSync({ inputRate: 16000, outputRate: 16000, output: 'f32' });
    try {
      const x = Float32Array.of(0.5, -0.25, Number.NaN, Infinity, -Infinity);
      expect([...r.push(x), ...r.flush()]).toEqual([0.5, -0.25, 0, 1, -1]);
    } finally {
      r.free();
    }
  });

  it('accepts input rates above the FLAC limit, as encode() does', () => {
    const r = createResamplerSync({ inputRate: 2 ** 21, outputRate: 16000 });
    const e = createChunkEncoderSync({ inputRate: 2 ** 21, sampleRate: 16000, bitsPerSample: 16 });
    expect(r.flush()).toHaveLength(0);
    expect(e.finish()).toBeNull();
    r.free();
    e.free();
  });

  it('frees on Symbol.dispose, for `using`', () => {
    const r = createResamplerSync({ inputRate: 48000, outputRate: 16000 });
    const e = createChunkEncoderSync({ inputRate: 16000, bitsPerSample: 16 });
    r[Symbol.dispose]();
    e[Symbol.dispose]();
    expect(liveSessions()).toBe(0);
    expect(() => r.flush()).toThrow('already freed');
    expect(() => e.finish()).toThrow('already freed');
  });

  it('frees without throwing after a wasm trap', () => {
    // After a trap wasm-bindgen refuses to free the object; free() must not throw.
    const trap = (): never => {
      throw new Error('recursive use of an object detected');
    };
    const spies = [
      vi.spyOn(WasmResampler.prototype, 'free').mockImplementationOnce(trap),
      vi.spyOn(WasmChunkEncoder.prototype, 'free').mockImplementationOnce(trap),
    ];
    try {
      const r = createResamplerSync({ inputRate: 48000, outputRate: 16000 });
      const e = createChunkEncoderSync({ inputRate: 16000, bitsPerSample: 16 });
      expect(() => r.free()).not.toThrow();
      expect(() => e.free()).not.toThrow();
      expect(liveSessions()).toBe(0);
      r.free();
      e.free();
      expect(() => r.push(new Float32Array(1))).toThrow('already freed');
      expect(() => e.push(new Float32Array(1))).toThrow('already freed');
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it('fails as encode() does when the input ends inside a frame', () => {
    const x = Float32Array.of(0.1, 0.2, 0.3);
    const code = expect.objectContaining({ code: 'INVALID_OPTIONS' });
    expect(() =>
      encodeSync(x, { pcm: { sampleRate: 16000, channels: 2 }, bitsPerSample: 16 }),
    ).toThrow(code);
    const r = createResamplerSync({ inputRate: 16000, outputRate: 16000, channels: 2 });
    const e = createChunkEncoderSync({ inputRate: 16000, channels: 2, bitsPerSample: 16 });
    try {
      r.push(x);
      e.push(x);
      expect(() => r.flush()).toThrow(code);
      expect(() => e.finish()).toThrow(code);
      // A failed call ends the stream, as flush() and finish() do.
      const state = expect.objectContaining({ code: 'ENCODER_STATE' });
      expect(() => r.push(x)).toThrow(state);
      expect(() => e.push(x)).toThrow(state);
      expect(() => e.encode()).toThrow(state);
      expect(() => e.finish()).toThrow(state);
    } finally {
      r.free();
      e.free();
    }
  });

  it('fails after flush and after free', () => {
    const r = createResamplerSync({ inputRate: 48000, outputRate: 16000 });
    r.flush();
    expect(() => r.push(new Float32Array(1))).toThrow(
      expect.objectContaining({ code: 'ENCODER_STATE' }),
    );
    expect(() => r.flush()).toThrow(expect.objectContaining({ code: 'ENCODER_STATE' }));
    r.free();
    expect(() => r.push(new Float32Array(1))).toThrow('already freed');
    expect(() => r.flush()).toThrow('already freed');
  });

  it('rejects bad samples with a TypeError', () => {
    const r = createResamplerSync({ inputRate: 48000, outputRate: 16000 });
    try {
      for (const bad of [new Float64Array(4), [0.1, 0.2], new Int16Array(2), null]) {
        expect(() => r.push(bad as unknown as Float32Array)).toThrow(TypeError);
      }
      const x = new Float32Array(8);
      structuredClone(x.buffer, { transfer: [x.buffer] });
      expect(() => r.push(x)).toThrow(/detached/);
    } finally {
      r.free();
    }
  });

  it('rejects bad settings', async () => {
    const code = (c: string): unknown => expect.objectContaining({ code: c });
    const bad: [unknown, string][] = [
      [null, 'INVALID_OPTIONS'],
      [[], 'INVALID_OPTIONS'],
      [{ outputRate: 16000 }, 'INVALID_OPTIONS'],
      [{ inputRate: 48000 }, 'INVALID_OPTIONS'],
      [{ inputRate: 0, outputRate: 16000 }, 'INVALID_OPTIONS'],
      [{ inputRate: 1.5, outputRate: 16000 }, 'INVALID_OPTIONS'],
      [{ inputRate: '48000', outputRate: 16000 }, 'INVALID_OPTIONS'],
      [{ inputRate: 48000, outputRate: 2 ** 20 }, 'INVALID_OPTIONS'],
      [{ inputRate: 48000, outputRate: 16000, channels: 0 }, 'INVALID_OPTIONS'],
      [{ inputRate: 48000, outputRate: 16000, channels: 9 }, 'TOO_MANY_CHANNELS'],
      [{ inputRate: 48000, outputRate: 16000, quality: 'max' }, 'INVALID_OPTIONS'],
      [{ inputRate: 48000, outputRate: 16000, output: 's24' }, 'INVALID_OPTIONS'],
      [{ inputRate: 48000, outputRate: 16000, quality: null }, 'INVALID_OPTIONS'],
      [{ inputRate: 48000, outputRate: 16000, output: null }, 'INVALID_OPTIONS'],
      [{ inputRate: 48000, outputRate: 16000, rate: 1 }, 'INVALID_OPTIONS'],
      [{ inputRate: 100, outputRate: 30000 }, 'UNSUPPORTED_FORMAT'],
    ];
    for (const [o, c] of bad) {
      const opts = o as Parameters<typeof createResamplerSync>[0];
      expect(() => createResamplerSync(opts), JSON.stringify(o)).toThrow(code(c));
      await expect(createResampler(opts)).rejects.toThrow(code(c));
    }
  });
});

const CHUNK_OPTS = {
  inputRate: 48000,
  sampleRate: 16000,
  bitsPerSample: 16,
  resampleQuality: 'fast',
} as const satisfies ChunkEncoderOptions;

/**
 * Decodes each file and joins the samples.
 * @param files FLAC files.
 * @returns The samples and each file's length in samples.
 */
function join(files: readonly Uint8Array[]): { samples: Int32Array; lengths: number[] } {
  const parts = files.map((f) => {
    expect(new TextDecoder().decode(f.subarray(0, 4))).toBe('fLaC');
    return flacDecode(f)!;
  });
  return { samples: concat(parts, Int32Array), lengths: parts.map((p) => p.length) };
}

/**
 * The metadata block types of a FLAC file, and its Vorbis comment as text.
 * @param f The file.
 * @returns Block types in order, and the comment.
 */
function metadata(f: Uint8Array): { types: number[]; comment: string } {
  const types: number[] = [];
  let comment = '';
  for (let at = 4, last = false; !last;) {
    last = f[at]! >= 0x80;
    const type = f[at]! & 0x7f;
    const len = (f[at + 1]! << 16) | (f[at + 2]! << 8) | f[at + 3]!;
    if (type === 4) comment = new TextDecoder().decode(f.subarray(at + 4, at + 4 + len));
    types.push(type);
    at += 4 + len;
  }
  return { types, comment };
}

/**
 * The samples of one `encode()` of the whole input with the same options.
 * @param x The input.
 * @param o Chunk encoder options.
 * @returns The decoded samples.
 */
function wholeSamples(x: Float32Array, o: ChunkEncoderOptions): Int32Array {
  const { inputRate, channels = 1, chunkSamples: _, ...rest } = o;
  return flacDecode(encodeSync(x, { ...rest, pcm: { sampleRate: inputRate, channels } }))!;
}

describe.skipIf(!has('flac'))('createChunkEncoder', () => {
  // Rule 4, varying length: cuts wherever encode() is called.
  for (const dither of ['tpdf', 'none'] as const) {
    it(`joins varying files to the whole encode() (dither ${dither})`, async () => {
      const o = { ...CHUNK_OPTS, dither };
      const x = signal(48000, 1, 48000 * 3);
      const enc = await createChunkEncoder(o);
      const files: Uint8Array[] = [];
      try {
        split(x, [128]).forEach((p, i) => {
          enc.push(p);
          if (i % 400 === 399) files.push(enc.encode()!);
        });
        files.push(enc.finish()!);
      } finally {
        enc.free();
      }
      expect(files.length).toBeGreaterThanOrEqual(3);
      expect(diff(join(files).samples, wholeSamples(x, o))).toBeNull();
    });
  }

  // Rule 4, exact length; rule 3 for the total.
  it('cuts files of exactly chunkSamples that join to the whole encode()', () => {
    const o = { ...CHUNK_OPTS, chunkSamples: 16000, tags: { TITLE: 'take' } };
    const x = signal(48000, 1, Math.round(48000 * 3.3));
    const enc = createChunkEncoderSync(o);
    const files: Uint8Array[] = [];
    try {
      for (const p of split(x, [128])) files.push(...enc.encode(p));
      expect(files).toHaveLength(3);
      files.push(...enc.finish());
    } finally {
      enc.free();
    }
    const { samples, lengths } = join(files);
    expect(lengths).toEqual([16000, 16000, 16000, 4800]);
    for (const f of files) {
      const { types, comment } = metadata(f);
      expect(types).toContain(3); // SEEKTABLE
      expect(comment).toContain('TITLE=take');
    }
    expect(diff(samples, wholeSamples(x, o))).toBeNull();
  });

  // 8/16/24 bits only: `flac -d` writes no raw output at other depths (the
  // Rust tests cover them).
  it('keeps stereo, bit depth and dither continuous across files', () => {
    for (const [bits, chunkSamples] of [
      [24, undefined],
      [16, 7777],
      [8, 5000],
    ] as const) {
      const o: ChunkEncoderOptions = {
        inputRate: 44100,
        channels: 2,
        sampleRate: 16000,
        bitsPerSample: bits,
        ditherSeed: 42,
        chunkSamples,
      };
      const x = signal(44100, 2, 44100 * 2, bits);
      const enc = createChunkEncoderSync(o);
      const files: Uint8Array[] = [];
      try {
        for (const p of split(x, [1000, 23, 4001])) {
          const r = enc.encode(p);
          if (Array.isArray(r)) files.push(...r);
          else if (r !== null) files.push(r);
        }
        const last = enc.finish();
        files.push(...(Array.isArray(last) ? last : last === null ? [] : [last]));
      } finally {
        enc.free();
      }
      expect(diff(join(files).samples, wholeSamples(x, o))).toBeNull();
    }
  });

  it('works without resampling', () => {
    const o = { inputRate: 16000, bitsPerSample: 16 };
    const x = signal(16000, 1, 40000);
    const enc = createChunkEncoderSync(o);
    try {
      const a = enc.encode(x.subarray(0, 12345))!;
      const b = enc.encode(x.subarray(12345))!;
      expect(enc.finish()).toBeNull();
      const { samples, lengths } = join([a, b]);
      expect(lengths).toEqual([12345, 40000 - 12345]);
      expect(diff(samples, wholeSamples(x, o))).toBeNull();
    } finally {
      enc.free();
    }
  });
});

describe('chunk encoder state and errors', () => {
  it('returns null or [] when nothing is ready', () => {
    const v = createChunkEncoderSync({ inputRate: 16000, bitsPerSample: 16 });
    const e = createChunkEncoderSync({ inputRate: 16000, bitsPerSample: 16, chunkSamples: 100 });
    try {
      expect(v.encode()).toBeNull();
      expect(e.encode(new Float32Array(99))).toEqual([]);
      expect(e.encode(new Float32Array(1))).toHaveLength(1);
      expect(v.finish()).toBeNull();
      expect(e.finish()).toEqual([]);
      expect(liveSessions()).toBe(2);
    } finally {
      v.free();
      e.free();
      e.free();
    }
    expect(liveSessions()).toBe(0);
  });

  it('fails after finish and after free', () => {
    const enc = createChunkEncoderSync({ inputRate: 16000, bitsPerSample: 16 });
    enc.finish();
    const state = expect.objectContaining({ code: 'ENCODER_STATE' });
    expect(() => enc.push(new Float32Array(1))).toThrow(state);
    expect(() => enc.encode()).toThrow(state);
    expect(() => enc.finish()).toThrow(state);
    enc.free();
    expect(() => enc.push(new Float32Array(1))).toThrow('already freed');
    expect(() => enc.encode()).toThrow('already freed');
  });

  it('rejects bad samples with a TypeError', () => {
    const enc = createChunkEncoderSync({ inputRate: 16000, bitsPerSample: 16 });
    try {
      expect(() => enc.push(new Float64Array(2) as unknown as Float32Array)).toThrow(TypeError);
      expect(() => enc.encode([0.5] as unknown as Float32Array)).toThrow(TypeError);
    } finally {
      enc.free();
    }
  });

  it('rejects bad settings', async () => {
    const code = (c: string): unknown => expect.objectContaining({ code: c });
    const ok = { inputRate: 48000, bitsPerSample: 16 };
    const bad: [unknown, string][] = [
      [undefined, 'INVALID_OPTIONS'],
      [{ bitsPerSample: 16 }, 'INVALID_OPTIONS'],
      [{ inputRate: 48000 }, 'UNSUPPORTED_FORMAT'],
      [{ ...ok, channels: 0 }, 'INVALID_OPTIONS'],
      [{ ...ok, channels: 9 }, 'TOO_MANY_CHANNELS'],
      [{ ...ok, chunkSamples: 0 }, 'INVALID_OPTIONS'],
      [{ ...ok, chunkSamples: 2.5 }, 'INVALID_OPTIONS'],
      [{ ...ok, pcm: { sampleRate: 48000, channels: 1 } }, 'INVALID_OPTIONS'],
      [{ ...ok, maxInputBytes: 10 }, 'INVALID_OPTIONS'],
      [{ ...ok, signal: new AbortController().signal }, 'INVALID_OPTIONS'],
      [{ ...ok, onProgress: () => {} }, 'INVALID_OPTIONS'],
      [{ ...ok, copy: true }, 'INVALID_OPTIONS'],
      [{ ...ok, compressionLevel: 9 }, 'INVALID_OPTIONS'],
      [{ ...ok, bogus: 1 }, 'INVALID_OPTIONS'],
      [{ ...ok, chunkSamples: 100, onChunk: 5 }, 'INVALID_OPTIONS'],
      [{ ...ok, chunkSamples: 100, onChunk: null }, 'INVALID_OPTIONS'],
      [{ bitsPerSample: 16, inputRate: 16000, onChunk: () => {} }, 'INVALID_OPTIONS'],
      [{ ...ok, sampleRate: 48000 * 300 }, 'INVALID_OPTIONS'],
      [{ ...ok, inputRate: 2 ** 21 }, 'INVALID_OPTIONS'],
      [{ inputRate: 100, sampleRate: 30000, bitsPerSample: 16 }, 'UNSUPPORTED_FORMAT'],
    ];
    for (const [o, c] of bad) {
      const opts = o as ChunkEncoderOptions;
      expect(() => createChunkEncoderSync(opts), JSON.stringify(o)).toThrow(code(c));
      await expect(createChunkEncoder(opts)).rejects.toThrow(code(c));
    }
  });

  it('treats onChunk: undefined as no callback', () => {
    const o = { inputRate: 16000, bitsPerSample: 16, onChunk: undefined };
    let v: ChunkEncoder | undefined;
    const enc = createChunkEncoderSync({ ...o, chunkSamples: 100 });
    try {
      v = createChunkEncoderSync(o);
      expect(enc.encode(new Float32Array(100))).toHaveLength(1);
      expect(v.encode(new Float32Array(100))).toBeInstanceOf(Uint8Array);
    } finally {
      enc.free();
      v?.free();
    }
  });
});

describe('chunk encoder with onChunk', () => {
  const state = expect.objectContaining({ name: 'Wav2FlacError', code: 'ENCODER_STATE' });
  const o16 = { inputRate: 16000, bitsPerSample: 16, chunkSamples: 100 };

  /**
   * Feeds `x` in `piece`-sample pieces through `encode()` and collects the
   * files from the return values.
   * @param x The input.
   * @param o Options without `onChunk`.
   * @param piece Samples per `encode()` call.
   * @returns The files.
   */
  function returned(
    x: Float32Array,
    o: ChunkEncoderOptions & { chunkSamples: number },
    piece: number,
  ): Bytes[] {
    const enc = createChunkEncoderSync(o);
    const files: Bytes[] = [];
    try {
      for (const p of split(x, [piece])) files.push(...enc.encode(p));
      files.push(...enc.finish());
    } finally {
      enc.free();
    }
    return files;
  }

  it('matches the return values', () => {
    const o = { ...CHUNK_OPTS, inputRate: 48000, chunkSamples: 16000 };
    const x = signal(48000, 1, 144_030); // finish() has a full file and a short one left
    const got: Bytes[] = [];
    const enc = createChunkEncoderSync({ ...o, onChunk: (f) => void got.push(f) });
    try {
      expect('encode' in enc).toBe(false);
      for (const p of split(x, [128])) expect(enc.push(p)).toBeUndefined();
      expect(got).toHaveLength(2);
      expect(enc.finish()).toBeUndefined();
    } finally {
      enc.free();
    }
    expect(got).toHaveLength(4); // 3 full + a shorter one
    expect(got).toEqual(returned(x, o, 128));
    for (const f of got) expect(f.byteLength).toBe(f.buffer.byteLength);
  });

  it('calls onChunk in order before push() and finish() return', () => {
    const log: string[] = [];
    const files: Bytes[] = [];
    const enc = createChunkEncoderSync({
      ...o16,
      onChunk: (f) => {
        files.push(f);
        log.push('file');
      },
    });
    const x = Float32Array.from({ length: 450 }, (_, i) => Math.floor(i / 100) / 8);
    try {
      enc.push(x.subarray(0, 250));
      log.push('return');
      enc.push(x.subarray(250, 260));
      log.push('return');
      enc.push(x.subarray(260));
      log.push('return');
      enc.finish();
      log.push('return');
    } finally {
      enc.free();
    }
    expect(log).toEqual([
      'file',
      'file',
      'return',
      'return',
      'file',
      'file',
      'return',
      'file',
      'return',
    ]);
    expect(files).toEqual(returned(x, o16, 128));
  });

  it('logs what onChunk throws and carries on', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new RangeError('boom');
    const files: Bytes[] = [];
    const enc = createChunkEncoderSync({
      ...o16,
      onChunk: (f) => {
        files.push(f);
        throw boom;
      },
    });
    try {
      enc.push(new Float32Array(250));
      expect(files).toHaveLength(2);
      enc.finish();
      expect(files).toEqual(returned(new Float32Array(250), o16, 250));
      expect(log.mock.calls).toEqual(Array(3).fill([expect.any(String), boom]));
    } finally {
      enc.free();
      log.mockRestore();
    }
  });

  it('carries on when console.error throws too', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('no logs');
    });
    const onChunk = vi.fn<(f: Bytes) => void>(() => {
      throw new Error('boom');
    });
    const enc = createChunkEncoderSync({ ...o16, onChunk });
    try {
      enc.push(new Float32Array(350));
      enc.finish();
      expect(onChunk).toHaveBeenCalledTimes(4);
    } finally {
      enc.free();
      log.mockRestore();
    }
  });

  it('drops samples pushed after finish() with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onChunk = vi.fn<(f: Bytes) => void>();
    const enc = createChunkEncoderSync({ ...o16, onChunk });
    try {
      enc.push(new Float32Array(150));
      enc.finish();
      expect(onChunk).toHaveBeenCalledTimes(2);
      enc.push(new Float32Array(300));
      enc.push(new Float32Array(300));
      enc.push(new Float32Array(0));
      expect(onChunk).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(() => enc.push([0.5] as unknown as Float32Array)).toThrow(TypeError);
      expect(() => enc.finish()).toThrow(state);
    } finally {
      enc.free();
      warn.mockRestore();
    }
  });

  it('drops samples pushed after a failed finish() with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onChunk = vi.fn<(f: Bytes) => void>();
    const enc = createChunkEncoderSync({ ...o16, channels: 2, onChunk });
    try {
      enc.push(new Float32Array(201)); // ends inside a frame
      expect(() => enc.finish()).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
      expect(liveSessions()).toBe(1); // the caller still frees
      expect(() => enc.finish()).toThrow(state);
      enc.push(new Float32Array(2));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(onChunk).toHaveBeenCalledTimes(1);
    } finally {
      enc.free();
      warn.mockRestore();
    }
  });

  it('calls onChunk for nothing when finish() has no file left', () => {
    const onChunk = vi.fn<(f: Bytes) => void>();
    const enc = createChunkEncoderSync({ ...o16, onChunk });
    try {
      enc.push(new Float32Array(200));
      expect(onChunk).toHaveBeenCalledTimes(2);
      enc.finish();
      expect(onChunk).toHaveBeenCalledTimes(2);
    } finally {
      enc.free();
    }
  });

  it('throws ENCODER_STATE for calls from inside onChunk, and keeps working', () => {
    const errors: unknown[] = [];
    const files: Bytes[] = [];
    const enc: CallbackChunkEncoder = createChunkEncoderSync({
      ...o16,
      onChunk: (f) => {
        files.push(f);
        for (const call of [
          () => enc.push(new Float32Array(1)),
          () => enc.finish(),
          () => enc.free(),
          () => enc[Symbol.dispose](),
        ]) {
          try {
            call();
            errors.push('no error');
          } catch (e) {
            errors.push(e);
          }
        }
      },
    });
    try {
      enc.push(new Float32Array(200));
      expect(files).toHaveLength(2);
      expect(errors).toHaveLength(8);
      for (const e of errors) expect(e).toEqual(state);
      expect(liveSessions()).toBe(1);
      // The encoder still works after the nested calls, also inside finish().
      enc.push(new Float32Array(50));
      enc.finish();
      expect(errors).toHaveLength(12);
      for (const e of errors) expect(e).toEqual(state);
      expect(files).toEqual(returned(new Float32Array(250), o16, 250));
    } finally {
      enc.free();
    }
    expect(liveSessions()).toBe(0);
  });

  it('cuts a push bigger than one wasm slice per slice', () => {
    const o = { ...o16, chunkSamples: 100_000 };
    const x = new Float32Array((1 << 18) + 1000); // 2 wasm slices, 2 full files
    const push = vi.spyOn(WasmChunkEncoder.prototype, 'push');
    const at: number[] = []; // wasm pushes made before each file
    const got: Bytes[] = [];
    const enc = createChunkEncoderSync({
      ...o,
      onChunk: (f) => {
        got.push(f);
        at.push(push.mock.calls.length);
      },
    });
    try {
      enc.push(x);
      expect(at).toEqual([1, 1]); // out before the second slice goes in
      enc.finish();
    } finally {
      enc.free();
      push.mockRestore();
    }
    expect(got).toEqual(returned(x, o, x.length));
  });

  it('works from the async factory', async () => {
    const onChunk = vi.fn<(f: Bytes) => void>();
    const enc = await createChunkEncoder({ ...o16, onChunk });
    enc.push(new Float32Array(150));
    expect(onChunk).toHaveBeenCalledTimes(1);
    enc.free();
    expect(() => enc.push(new Float32Array(100))).toThrow('already freed');
    expect(() => enc.push(new Float32Array(0))).toThrow('already freed');
    expect(() => enc.finish()).toThrow('already freed');
  });

  it('types the encoder by the options', () => {
    // Type-checked by `npm run typecheck`, never called.
    const typesOnly = async (): Promise<void> => {
      const base = { inputRate: 48000, bitsPerSample: 16 } satisfies ChunkEncoderOptions;
      const make = createChunkEncoderSync;
      const cb = { ...base, chunkSamples: 10, onChunk: () => {} };
      expectTypeOf(make(cb)).toEqualTypeOf<CallbackChunkEncoder>();
      expectTypeOf(make({ ...base, chunkSamples: 10 })).toEqualTypeOf<ExactChunkEncoder>();
      expectTypeOf(make(base)).toEqualTypeOf<ChunkEncoder>();
      const wide: ChunkEncoderOptions = base;
      expectTypeOf(make(wide)).toEqualTypeOf<ChunkEncoder | ExactChunkEncoder>();
      // Untyped options keep their 1.1.0 type.
      const untyped: any = { ...base, chunkSamples: 10 };
      expectTypeOf(make(untyped)).toEqualTypeOf<ExactChunkEncoder>();
      expectTypeOf(await createChunkEncoder(untyped)).toEqualTypeOf<ExactChunkEncoder>();
      expectTypeOf(createChunkEncoder(cb)).toEqualTypeOf<Promise<CallbackChunkEncoder>>();
      expectTypeOf<CallbackChunkEncoder>().not.toHaveProperty('encode');
      expectTypeOf<CallbackChunkEncoder['push']>().returns.toEqualTypeOf<void>();
      expectTypeOf<CallbackChunkEncoder['finish']>().returns.toEqualTypeOf<void>();
      expectTypeOf<CallbackChunkEncoderOptions['onChunk']>().toEqualTypeOf<
        (file: Bytes) => void | undefined
      >();
      // @ts-expect-error onChunk needs chunkSamples.
      make({ ...base, onChunk: () => {} });
      // @ts-expect-error onChunk must be synchronous.
      make({ ...cb, onChunk: async () => {} });
      // @ts-expect-error Nor may it return a promise.
      make({ ...cb, onChunk: () => Promise.resolve() });
      expectTypeOf<ExactChunkEncoder['encode']>().returns.toEqualTypeOf<Bytes[]>();
      expectTypeOf<ChunkEncoder['finish']>().returns.toEqualTypeOf<Bytes | null>();
      // @ts-expect-error onChunk must be a function.
      make({ ...cb, onChunk: 5 });
      // @ts-expect-error Not even when the options are not a literal.
      const widened: ChunkEncoderOptions = cb;
      void widened;
    };
    void typesOnly;
  });
});
