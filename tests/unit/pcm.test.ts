// SPDX-License-Identifier: 0BSD
// Raw PCM input (the `pcm` option). The key invariant: encoding samples as raw
// PCM gives exactly the bytes of encoding the same samples wrapped in a WAV.
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  encode, encodeStream, encodeSync, init, Wav2FlacError, type Options, type PcmSampleFormat, type Progress,
} from '../../ts/index.js';
import type { FromWorker, Port, ToWorker } from '../../ts/lib/protocol.js';
import { connect, type WorkerEncoder } from '../../ts/lib/worker-client.js';
import { serve } from '../../ts/lib/worker-host.js';
import { params } from '../helpers/fc.js';
import { collect, rng, streamOf } from '../helpers/wav.js';
import { has } from '../helpers/tools.js';

await init();
const wasm = readFileSync('build/bindgen/wav2flac_bg.wasm');
const FORMATS: PcmSampleFormat[] = ['u8', 's16', 's24', 's32', 'f32'];
const WIDTH: Record<PcmSampleFormat, number> = { u8: 1, s16: 2, s24: 3, s32: 4, f32: 4 };

/**
 * Wraps raw little-endian PCM in a minimal WAV file.
 * @param raw Interleaved sample bytes.
 * @param format Sample format.
 * @param channels Channel count.
 * @param rate Sample rate.
 * @returns The WAV file.
 */
function wavOf(raw: Uint8Array, format: PcmSampleFormat, channels: number, rate: number): Uint8Array {
  const w = WIDTH[format];
  const out = new Uint8Array(44 + raw.length + (raw.length & 1));
  const v = new DataView(out.buffer);
  out.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  v.setUint32(4, out.length - 8, true);
  out.set([...'WAVEfmt '].map((c) => c.charCodeAt(0)), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, format === 'f32' ? 3 : 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * w, true);
  v.setUint16(32, channels * w, true);
  v.setUint16(34, w * 8, true);
  out.set([...'data'].map((c) => c.charCodeAt(0)), 36);
  v.setUint32(40, raw.length, true);
  out.set(raw, 44);
  return out;
}

/**
 * Deterministic noise as raw PCM bytes.
 * @param format Sample format.
 * @param samples Total samples (frames × channels).
 * @param seed PRNG seed.
 * @returns The bytes.
 */
function noise(format: PcmSampleFormat, samples: number, seed: number): Uint8Array {
  const r = rng(seed);
  if (format === 'f32') {
    const f = new Float32Array(samples);
    for (let i = 0; i < samples; i++) f[i] = r() * 2 - 1;
    return new Uint8Array(f.buffer);
  }
  const b = new Uint8Array(samples * WIDTH[format]);
  for (let i = 0; i < b.length; i++) b[i] = Math.floor(r() * 256);
  return b;
}

/**
 * Options for a PCM spec (float needs a target depth, as for WAV).
 * @param format Sample format.
 * @param channels Channel count.
 * @param rate Sample rate.
 * @param explicit Whether to pass `format` explicitly.
 * @returns Encoder options.
 */
function pcmOpts(format: PcmSampleFormat, channels: number, rate: number, explicit = true): Options {
  return {
    pcm: explicit ? { sampleRate: rate, channels, format } : { sampleRate: rate, channels },
    ...(format === 'f32' ? { bitsPerSample: 24 } : {}),
  };
}

/**
 * Encodes a WAV with the same options minus `pcm` (the reference output).
 * @param wav The WAV file.
 * @param opts PCM options.
 * @returns The FLAC file.
 */
function refOf(wav: Uint8Array, opts: Options): Uint8Array {
  const { pcm: _pcm, ...rest } = opts;
  return encodeSync(wav, rest);
}

/**
 * The error code thrown (sync or async) by `f`.
 * @param f The operation.
 * @returns The code, or the error's constructor name for non-wav2flac errors.
 */
async function codeOf(f: () => unknown): Promise<string> {
  try {
    await f();
  } catch (e) {
    return e instanceof Wav2FlacError ? e.code : (e as Error).constructor.name;
  }
  return 'ok';
}

/**
 * Wraps a MessagePort as a protocol port.
 * @param p The port.
 * @returns The protocol port.
 */
function wrap<I, O>(p: MessagePort): Port<I, O> {
  return {
    post: (m, t) => p.postMessage(m, t as never),
    listen: (on, onErr) => { p.on('message', on); p.on('messageerror', onErr); },
    ref: (k) => (k ? p.ref() : p.unref()),
    close: () => p.close(),
  };
}

let open: WorkerEncoder[] = [];
afterEach(() => {
  for (const w of open) w.terminate();
  open = [];
});

/**
 * An in-process worker client/host pair.
 * @returns The client.
 */
function worker(): WorkerEncoder {
  const ch = new MessageChannel();
  serve(wrap<ToWorker, FromWorker>(ch.port2));
  const w = connect(wrap<FromWorker, ToWorker>(ch.port1), wasm);
  open.push(w);
  return w;
}

describe('pcm input equals the WAV-wrapped input', () => {
  it.each(FORMATS)('%s, 1–8 channels, as bytes, ArrayBuffer and offset views', (format) => {
    for (let ch = 1; ch <= 8; ch++) {
      const raw = noise(format, 1000 * ch, ch);
      const ref = refOf(wavOf(raw, format, ch, 22050), pcmOpts(format, ch, 22050));
      expect(encodeSync(raw, pcmOpts(format, ch, 22050))).toEqual(ref);
      expect(encodeSync(raw.slice().buffer, pcmOpts(format, ch, 22050))).toEqual(ref);
      const padded = new Uint8Array(raw.length + 5);
      padded.set(raw, 5);
      expect(encodeSync(padded.subarray(5), pcmOpts(format, ch, 22050))).toEqual(ref);
    }
  });

  it('infers the format from Int16Array, Int32Array and Float32Array, including offset views', () => {
    const cases = [['s16', Int16Array], ['s32', Int32Array], ['f32', Float32Array]] as const;
    for (const [format, Ctor] of cases) {
      const raw = noise(format, 3000, 9);
      const ref = refOf(wavOf(raw, format, 2, 48000), pcmOpts(format, 2, 48000));
      const typed = new Ctor(raw.slice().buffer);
      expect(encodeSync(typed, pcmOpts(format, 2, 48000, false))).toEqual(ref);
      expect(encodeSync(typed, pcmOpts(format, 2, 48000, true))).toEqual(ref);
      const big = new Ctor(typed.length + 4);
      big.set(typed, 4);
      expect(encodeSync(big.subarray(4), pcmOpts(format, 2, 48000, false))).toEqual(ref);
      // Typed arrays from another realm (iframe, vm context) infer the same.
      const foreign = runInNewContext(`new ${Ctor.name}(b)`, { b: raw.slice().buffer }) as typeof typed;
      expect(foreign instanceof Ctor).toBe(false);
      expect(encodeSync(foreign, pcmOpts(format, 2, 48000, false))).toEqual(ref);
    }
  });

  it('interleaves planar input (one array per channel)', () => {
    const frames = 5000;
    const planes = [0, 1, 2].map((c) => new Float32Array(noise('f32', frames, 20 + c).buffer));
    const inter = new Float32Array(frames * 3);
    for (let i = 0; i < frames; i++) for (let c = 0; c < 3; c++) inter[i * 3 + c] = planes[c]![i]!;
    const opts = pcmOpts('f32', 3, 32000, false);
    expect(encodeSync(planes, opts)).toEqual(encodeSync(inter, opts));
    const i16 = [new Int16Array([1, 2, 3]), new Int16Array([-1, -2, -3])];
    expect(encodeSync(i16, pcmOpts('s16', 2, 8000, false))).toEqual(
      encodeSync(new Int16Array([1, -1, 2, -2, 3, -3]), pcmOpts('s16', 2, 8000, false)),
    );
  });

  it('gives the same bytes on every path: encode, encodeStream, encodeSync, worker', async () => {
    const raw = noise('s24', 20_000 * 2, 3);
    const opts = pcmOpts('s24', 2, 44100);
    const ref = refOf(wavOf(raw, 's24', 2, 44100), opts);
    expect(encodeSync(raw, opts)).toEqual(ref);
    expect(await encode(raw, opts)).toEqual(ref);
    expect(await encode(streamOf(raw, 7), opts)).toEqual(ref); // chunks split samples
    const w = worker();
    expect(await w.encode(raw.slice(), opts)).toEqual(ref);
    expect(await w.encode(streamOf(raw, 4099), opts)).toEqual(ref);
    // Streaming output: same frames as the WAV path's stream.
    const { pcm: _pcm, ...wavOpts } = opts;
    const refStream = await collect(encodeStream(wavOf(raw, 's24', 2, 44100), wavOpts));
    expect(await collect(encodeStream(raw, opts))).toEqual(refStream);
    expect(await collect(encodeStream(streamOf(raw, 1000), opts))).toEqual(refStream);
    expect(await collect(w.encodeStream(streamOf(raw, 333), opts))).toEqual(refStream);
  });

  it('accepts streams of byte, DataView, ArrayBuffer and matching typed-array chunks', async () => {
    const f = new Float32Array(noise('f32', 4000, 4).buffer);
    const ref = encodeSync(f, pcmOpts('f32', 1, 16000, false));
    const chunks: (ArrayBufferView | ArrayBuffer)[] = [f.subarray(0, 1000), new Uint8Array(f.buffer, 4000, 3)];
    chunks.push(new DataView(f.buffer, 4003, 5), f.slice(1002).buffer);
    const s = new ReadableStream<ArrayBufferView | ArrayBuffer>({
      pull(c) {
        const x = chunks.shift();
        if (x === undefined) c.close();
        else c.enqueue(x);
      },
    });
    expect(await encode(s, pcmOpts('f32', 1, 16000))).toEqual(ref);
  });

  it('checks stream chunks against the format and unlocks the source', async () => {
    const src = (chunks: unknown[]): ReadableStream<unknown> => new ReadableStream({
      pull(c) {
        const x = chunks.shift();
        if (x === undefined) c.close();
        else c.enqueue(x);
      },
    });
    const ok = src([new Int16Array(8)]);
    await encode(ok as never, pcmOpts('s16', 1, 8000));
    expect(ok.locked).toBe(false);
    for (const [chunk, err] of [
      [new Float32Array(8), Wav2FlacError],
      [new Int8Array(8), Wav2FlacError],
      ['text', TypeError],
    ] as const) {
      const s = src([new Int16Array(4), chunk]);
      await expect(encode(s as never, pcmOpts('s16', 1, 8000))).rejects.toBeInstanceOf(err);
      expect(s.locked).toBe(false);
    }
  });

  it('rejects detached pcm input with a TypeError', async () => {
    const s = new Int16Array(16);
    structuredClone(s.buffer, { transfer: [s.buffer] });
    expect(() => encodeSync(s, pcmOpts('s16', 1, 8000, false))).toThrow(/detached/);
    expect(() => encodeSync([s], pcmOpts('s16', 1, 8000, false))).toThrow(/detached/);
    // A detached stream chunk fails the encode and cancels the source.
    let cancelled: unknown;
    const src = new ReadableStream<Int16Array>({
      pull: (c) => c.enqueue(s),
      cancel: (why) => { cancelled = why; },
    });
    await expect(encode(src, pcmOpts('s16', 1, 8000))).rejects.toThrow(/stream chunk was transferred/);
    expect(cancelled).toBeInstanceOf(TypeError);
  });

  it('gives a TypeError when two worker jobs transfer the same buffer', async () => {
    const w = worker();
    const s = new Int16Array(noise('s16', 2000, 1).buffer);
    const a = w.encode(s, pcmOpts('s16', 1, 8000, false));
    const b = w.encode(s, pcmOpts('s16', 1, 8000, false));
    // Attach both handlers now: b may reject before a settles.
    await Promise.all([
      expect(a).resolves.toBeInstanceOf(Uint8Array),
      expect(b).rejects.toThrow(/detached/),
    ]);
  });

  it('transfers typed-array input to the worker unless copy is set', async () => {
    const w = worker();
    const s = new Int16Array(noise('s16', 2000, 1).buffer);
    const ref = encodeSync(s, pcmOpts('s16', 1, 8000, false));
    const kept = s.slice();
    expect(await w.encode(kept, { ...pcmOpts('s16', 1, 8000, false), copy: true })).toEqual(ref);
    expect(kept.length).toBe(2000);
    const moved = s.slice();
    expect(await w.encode(moved, pcmOpts('s16', 1, 8000, false))).toEqual(ref);
    expect(moved.length).toBe(0);
  });

  it('property: random spec, samples and chunking match the WAV path', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...FORMATS), fc.integer({ min: 1, max: 8 }), fc.constantFrom(8000, 16000, 44100, 96000),
      fc.integer({ min: 0, max: 5000 }), fc.integer(), fc.integer({ min: 1, max: 5000 }), fc.boolean(),
      async (format, ch, rate, frames, seed, chunk, streamIn) => {
        const raw = noise(format, frames * ch, seed);
        const opts = pcmOpts(format, ch, rate);
        const ref = refOf(wavOf(raw, format, ch, rate), opts);
        expect(await encode(streamIn ? streamOf(raw, chunk) : raw, opts)).toEqual(ref);
      },
    ), params(20));
  });
});

describe('pcm semantics', () => {
  it.skipIf(!has('flac'))('encodes 16 kHz mono float to exact 16-bit samples (dither off)', () => {
    const want = new Int16Array(16000 * 5);
    for (let i = 0; i < want.length; i++) want[i] = Math.round(12000 * Math.sin(i / 7)) + (i % 3);
    const f = Float32Array.from(want, (v) => v / 32768);
    const flac = encodeSync(f, { pcm: { sampleRate: 16000, channels: 1 }, bitsPerSample: 16, dither: 'none' });
    const d = spawnSync('flac', ['-d', '-s', '-c', '--force-raw-format', '--endian=little', '--sign=signed', '-'],
      { input: flac });
    expect(d.status).toBe(0);
    expect(new Int16Array(d.stdout.buffer, d.stdout.byteOffset, d.stdout.length / 2)).toEqual(want);
  });

  it('reports a progress fraction only when the length is known', async () => {
    const raw = noise('s16', 200_000, 2);
    const seen: Progress[] = [];
    await encode(raw, { ...pcmOpts('s16', 1, 16000), onProgress: (p) => seen.push(p) });
    expect(seen.at(-1)?.fraction).toBe(1);
    const streamed: Progress[] = [];
    await encode(streamOf(raw, 65536), { ...pcmOpts('s16', 1, 16000), onProgress: (p) => streamed.push(p) });
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.every((p) => p.fraction === null)).toBe(true);
    expect(streamed.at(-1)?.samplesOut).toBe(200_000);
  });
});

describe('pcm errors', () => {
  const s16 = new Int16Array(100);
  const mono = (format?: PcmSampleFormat): Options => ({
    pcm: format === undefined ? { sampleRate: 16000, channels: 1 } : { sampleRate: 16000, channels: 1, format },
  });

  it.each<[string, () => unknown, string]>([
    ['typed array contradicts format', () => encodeSync(s16, mono('s24')), 'INVALID_OPTIONS'],
    ['bytes without format', () => encodeSync(new Uint8Array(4), mono()), 'INVALID_OPTIONS'],
    ['ArrayBuffer without format', () => encodeSync(new ArrayBuffer(4), mono()), 'INVALID_OPTIONS'],
    ['stream without format', () => encode(streamOf(new Uint8Array(4), 1), mono()), 'INVALID_OPTIONS'],
    ['unsupported typed array', () => encodeSync(new Uint16Array(4) as never, mono('s16')), 'INVALID_OPTIONS'],
    ['DataView', () => encodeSync(new DataView(new ArrayBuffer(4)) as never, mono('s16')), 'TypeError'],
    ['string', () => encodeSync('abc' as never, mono('s16')), 'TypeError'],
    ['planar count ≠ channels', () => encodeSync([s16, s16], mono()), 'INVALID_OPTIONS'],
    ['planar unequal lengths', () =>
      encodeSync([s16, new Int16Array(3)], { pcm: { sampleRate: 8000, channels: 2 } }), 'INVALID_OPTIONS'],
    ['planar mixed types', () =>
      encodeSync([s16, new Float32Array(100)] as never, { pcm: { sampleRate: 8000, channels: 2 } }), 'INVALID_OPTIONS'],
    ['planar numbers', () => encodeSync([[1], [2]] as never, { pcm: { sampleRate: 8000, channels: 2 } }), 'INVALID_OPTIONS'],
    ['empty planar', () => encodeSync([], { pcm: { sampleRate: 8000, channels: 0 } } as never), 'INVALID_OPTIONS'],
    ['partial frame (buffer)', () => encodeSync(new Uint8Array(3), mono('s16')), 'INVALID_OPTIONS'],
    ['partial frame (stream)', () => encode(streamOf(new Uint8Array(3), 1), mono('s16')), 'TRUNCATED'],
    ['9 channels', () => encodeSync(new Int16Array(900), { pcm: { sampleRate: 8000, channels: 9 } }), 'TOO_MANY_CHANNELS'],
    ['rate above FLAC max', () => encodeSync(s16, { pcm: { sampleRate: 2_000_000, channels: 1 } }), 'INVALID_OPTIONS'],
    ['stream of non-bytes', () => encode(new ReadableStream({ start(c) { c.enqueue('x' as never); c.close(); } }),
      mono('s16')), 'TypeError'],
    ['typed array without pcm', () => encodeSync(s16 as never), 'TypeError'],
  ])('%s', async (_name, f, code) => {
    expect(await codeOf(f)).toBe(code);
  });

  it('float without a target depth fails like float WAV', async () => {
    const f = new Float32Array(10);
    const wav = wavOf(new Uint8Array(f.buffer), 'f32', 1, 16000);
    expect(await codeOf(() => encodeSync(f, mono()))).toBe(await codeOf(() => encodeSync(wav)));
  });

  it('leaves a stream input unlocked when the options are invalid', async () => {
    const s = streamOf(new Uint8Array(8), 4);
    const bad = { pcm: { sampleRate: 16000, channels: 99, format: 's16' as const } };
    expect(await codeOf(() => encode(s, bad))).toBe('TOO_MANY_CHANNELS');
    expect(await codeOf(() => collect(encodeStream(s, bad)))).toBe('TOO_MANY_CHANNELS');
    expect(s.locked).toBe(false);
  });

  it('cancels a PCM stream on bad chunks and when the output is cancelled', async () => {
    let cancelled: unknown;
    const src = (chunks: unknown[]): ReadableStream<unknown> => new ReadableStream<unknown>({
      pull(c) { const v = chunks.shift(); if (v === undefined) return; c.enqueue(v); },
      cancel(r) { cancelled = r; },
    }, { highWaterMark: 0 });
    const opts = { pcm: { sampleRate: 8000, channels: 1, format: 's16' as const } };
    await expect(encode(src([new Int16Array(4), 'x']) as never, opts)).rejects.toThrow(TypeError);
    expect(cancelled).toBeInstanceOf(TypeError);
    // Cancelled before the first read: the source is cancelled without being locked.
    cancelled = undefined;
    await encodeStream(src([]) as never, opts).cancel('early');
    expect(cancelled).toBe('early');
    // Cancelled mid-way.
    cancelled = undefined;
    const r = encodeStream(src([new Int16Array(4)]) as never, opts).getReader();
    await r.read();
    await r.cancel('late');
    expect(cancelled).toBe('late');
  });

  it('rejects on the worker path too', async () => {
    const w = worker();
    expect(await codeOf(() => w.encode(new Uint8Array(4), mono()))).toBe('INVALID_OPTIONS');
    expect(await codeOf(() => w.encode(streamOf(new Uint8Array(3), 1), mono('s16')))).toBe('TRUNCATED');
  });
});
