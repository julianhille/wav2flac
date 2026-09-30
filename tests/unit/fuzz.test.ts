// SPDX-License-Identifier: 0BSD
// Property-based / fuzz-style tests of the JS API (fast-check). Every property
// prints a seed and a shrunk counterexample on failure; see tests/helpers/fc.ts
// for replaying one and how the runs scale with WAV2FLAC_TEST_TIER.
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  encode,
  encodeStream,
  encodeSync,
  probe,
  Wav2FlacError,
  type Options,
} from '../../ts/index.js';
import { liveSessions } from '../../ts/lib/engine.js';
import type { ErrorCode } from '../../ts/lib/errors.js';
import { normalizeOptions } from '../../ts/lib/options.js';
import type { FromWorker, Port, ToWorker } from '../../ts/lib/protocol.js';
import { connect, type WorkerEncoder } from '../../ts/lib/worker-client.js';
import { serve } from '../../ts/lib/worker-host.js';
import { params } from '../helpers/fc.js';
import { collect, makeWav, type WavSpec } from '../helpers/wav.js';
import { flacTest } from '../helpers/tools.js';

const CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'INVALID_WAV',
  'UNSUPPORTED_FORMAT',
  'UNSUPPORTED_BIT_DEPTH',
  'TOO_MANY_CHANNELS',
  'TRUNCATED',
  'INVALID_OPTIONS',
  'ENCODER_STATE',
  'LIMIT_EXCEEDED',
]);

/** Result of one API call: the output or the error code. */
type Outcome = { ok: Uint8Array } | { code: ErrorCode };

/**
 * Runs `fn` and classifies the result. Anything but a documented
 * `Wav2FlacError` (a wasm trap, a TypeError, `INTERNAL`) is re-thrown.
 * @param fn The call.
 * @returns The outcome.
 */
async function outcome(fn: () => Uint8Array | Promise<Uint8Array>): Promise<Outcome> {
  try {
    const out = await fn();
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out.subarray(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43]); // fLaC
    return { ok: out };
  } catch (e) {
    if (e instanceof Wav2FlacError && CODES.has(e.code)) return { code: e.code };
    throw e;
  }
}

/**
 * A stream that yields `bytes` in the given chunk sizes (cycled).
 * @param bytes Input.
 * @param sizes Chunk sizes (≥ 1).
 * @returns The stream.
 */
function chunked(bytes: Uint8Array, sizes: number[]): ReadableStream<Uint8Array> {
  let off = 0;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (off >= bytes.length) {
        c.close();
        return;
      }
      const n = sizes[i++ % sizes.length]!;
      c.enqueue(bytes.slice(off, off + n));
      off += n;
    },
  });
}

/** Arbitrary valid WAV spec (small, to keep runs fast). */
const wavSpec: fc.Arbitrary<WavSpec> = fc
  .record({
    frames: fc.oneof(fc.integer({ min: 0, max: 64 }), fc.integer({ min: 0, max: 12_000 })),
    rate: fc.constantFrom(8000, 11025, 22050, 44100, 48000, 96000, 192000, 12345),
    channels: fc.integer({ min: 1, max: 8 }),
    bits: fc.constantFrom<8 | 16 | 24 | 32>(8, 16, 24, 32),
    signal: fc.constantFrom('silence', 'sine', 'noise', 'music' as const),
    seed: fc.nat(),
  })
  .chain((s) =>
    fc
      .record({
        float: s.bits === 32 ? fc.boolean() : fc.constant(false),
        extensible: fc.boolean(),
      })
      .map(({ float, extensible }) => ({
        ...s,
        float,
        ...(extensible ? { channelMask: (1 << s.channels) - 1 } : {}),
      })),
  );

/** Chunk sizes for stream inputs, biased towards tiny and odd sizes. */
const chunkSizes = fc.array(
  fc.oneof(
    fc.integer({ min: 1, max: 7 }),
    fc.integer({ min: 1, max: 5000 }),
    fc.constantFrom(4095, 4096, 65536),
  ),
  { minLength: 1, maxLength: 8 },
);

/**
 * Options that 32-bit int/float input needs.
 * @param s The spec.
 * @returns Required options.
 */
function required(s: WavSpec): Options {
  return s.bits === 32 ? { bitsPerSample: 24 } : {};
}

// A client/host worker pair over an in-process channel (the protocol, without threads).
const wasm = readFileSync('build/bindgen/wav2flac_bg.wasm');
/**
 * Wraps a MessagePort as a protocol port.
 * @param p The port.
 * @returns The protocol port.
 */
function wrap<I, O>(p: MessagePort): Port<I, O> {
  return {
    post: (m, t) => p.postMessage(m, t as never),
    listen: (on, onErr) => {
      p.on('message', on);
      p.on('messageerror', onErr);
    },
    ref: (k) => (k ? p.ref() : p.unref()),
    close: () => p.close(),
  };
}
const ch = new MessageChannel();
serve(wrap<ToWorker, FromWorker>(ch.port2));
const worker: WorkerEncoder = connect(wrap<FromWorker, ToWorker>(ch.port1), wasm);
afterAll(() => worker.terminate());

describe('fuzz: valid input', () => {
  it('encodes any valid WAV identically for every path and chunking', async () => {
    await fc.assert(
      fc.asyncProperty(wavSpec, chunkSizes, async (spec, sizes) => {
        const wav = makeWav(spec);
        const opts = required(spec);
        const ref = encodeSync(wav, opts);
        expect(flacTest(ref) ?? '').toBe('');
        expect(await encode(chunked(wav, sizes), opts)).toEqual(ref);
        expect(await worker.encode(chunked(wav, sizes), opts)).toEqual(ref);
        const streamed = await collect(encodeStream(chunked(wav, sizes), opts));
        expect(await collect(encodeStream(wav, opts))).toEqual(streamed);
        expect(await collect(worker.encodeStream(wav.slice(), opts))).toEqual(streamed);
        expect(flacTest(streamed) ?? '').toBe('');
        const info = await probe(wav);
        expect(info).toMatchObject({
          channels: spec.channels,
          sampleRate: spec.rate,
          frames: spec.frames,
        });
      }),
      params(40),
    );
  });

  it('transcodes with random rate/depth/level/block size into valid, chunk-invariant FLAC', async () => {
    const tx = fc.record(
      {
        sampleRate: fc.constantFrom(8000, 16000, 22050, 44100, 48000, 88200, 96000, 7919),
        bitsPerSample: fc.integer({ min: 4, max: 32 }),
        resampleQuality: fc.constantFrom('fast', 'balanced', 'best' as const),
        dither: fc.constantFrom('tpdf', 'none' as const),
        ditherSeed: fc.nat(),
        compressionLevel: fc.integer({ min: 0, max: 8 }),
        blockSize: fc.integer({ min: 16, max: 65535 }),
        padding: fc.integer({ min: 0, max: 20000 }),
        seekPointInterval: fc.double({ min: 0, max: 5, noNaN: true }),
      },
      { requiredKeys: [] },
    );
    await fc.assert(
      fc.asyncProperty(wavSpec, tx, chunkSizes, async (spec, o, sizes) => {
        const wav = makeWav({ ...spec, frames: Math.min(spec.frames, 4000) });
        const opts: Options = { ...required(spec), ...o };
        if (spec.bits === 32 && o.bitsPerSample === undefined) opts.bitsPerSample = 24;
        const ref = encodeSync(wav, opts);
        expect(flacTest(ref) ?? '').toBe('');
        expect(await encode(chunked(wav, sizes), opts)).toEqual(ref);
      }),
      params(30),
    );
  });
});

describe('fuzz: hostile input', () => {
  const base = makeWav({ frames: 3000, channels: 2, seed: 3 });
  const baseExt = makeWav({ frames: 3000, channels: 6, bits: 24, channelMask: 0x3f, seed: 4 });

  /** Mutations of a valid WAV: byte flips focused on the header, truncation, splicing. */
  const mutated = fc
    .tuple(
      fc.constantFrom(base, baseExt),
      fc.array(
        fc.tuple(
          fc.oneof(fc.integer({ min: 0, max: 80 }), fc.nat()),
          fc.integer({ min: 0, max: 255 }),
        ),
        { maxLength: 8 },
      ),
      fc.option(fc.nat(), { nil: undefined }),
      fc.option(fc.tuple(fc.integer({ min: 0, max: 80 }), fc.uint8Array({ maxLength: 64 })), {
        nil: undefined,
      }),
    )
    .map(([src, flips, cut, splice]) => {
      let b: Uint8Array = src.slice();
      for (const [pos, val] of flips) b[pos % b.length] = val;
      if (splice !== undefined) {
        const [at, ins] = splice;
        const out = new Uint8Array(b.length + ins.length);
        out.set(b.subarray(0, at));
        out.set(ins, at);
        out.set(b.subarray(at), at + ins.length);
        b = out;
      }
      if (cut !== undefined) b = b.slice(0, cut % (b.length + 1));
      return b;
    });

  /** Random bytes, sometimes behind a plausible RIFF/WAVE/fmt prefix. */
  const garbage = fc
    .tuple(
      fc.constantFrom(
        new Uint8Array(0),
        new TextEncoder().encode('RIFF'),
        new TextEncoder().encode('RIFF\xff\xff\xff\xffWAVE'),
        base.subarray(0, 12),
        base.subarray(0, 36),
      ),
      fc.uint8Array({ maxLength: 2048 }),
    )
    .map(([head, tail]) => {
      const b = new Uint8Array(head.length + tail.length);
      b.set(head);
      b.set(tail, head.length);
      return b;
    });

  it('never crashes and agrees across paths on mutated WAVs', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(mutated, garbage), chunkSizes, async (bytes, sizes) => {
        const sync = await outcome(() => encodeSync(bytes));
        const promise = await outcome(() => encode(chunked(bytes, sizes)));
        const viaWorker = await outcome(() => worker.encode(bytes.slice()));
        expect(promise).toEqual(sync);
        expect(viaWorker).toEqual(sync);
        const stream = await outcome(() => collect(encodeStream(chunked(bytes, sizes))));
        expect('code' in stream).toBe('code' in sync);
        if ('code' in stream && 'code' in sync) expect(stream.code).toBe(sync.code);
        if ('ok' in sync) expect(flacTest(sync.ok) ?? '').toBe('');
        // probe must also classify, never trap.
        await outcome(async () => {
          await probe(bytes);
          return new TextEncoder().encode('fLaC');
        });
        // Failures free their encoders (the worker's host runs in this realm).
        await vi.waitFor(() => expect(liveSessions()).toBe(0));
      }),
      params(200),
    );
    // And the module is still healthy afterwards.
    expect(encodeSync(base).length).toBeGreaterThan(0);
  });

  it('reports TRUNCATED for every prefix', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(base, baseExt), fc.nat(), async (src, n) => {
        const cut = src.subarray(0, n % src.length);
        const r = await outcome(() => encodeSync(cut));
        expect('code' in r ? r.code : 'encoded').toBe('TRUNCATED');
      }),
      params(100),
    );
  });

  it('rejects non-byte inputs with a TypeError', async () => {
    const junk = fc.oneof(
      fc.anything(),
      fc.constant(new Int16Array(8)),
      fc.constant(new DataView(new ArrayBuffer(8))),
      fc.constantFrom<unknown>(42, 'RIFF', null, {}, [1, 2]).map((chunk) => ({ chunk })),
    );
    await fc.assert(
      fc.asyncProperty(junk, async (x) => {
        // Streams are built per run (a consumed stream cannot be reused).
        const input =
          x !== null && typeof x === 'object' && 'chunk' in x
            ? new ReadableStream({
                start(c) {
                  c.enqueue((x as { chunk: unknown }).chunk);
                  c.close();
                },
              })
            : x;
        await expect(encode(input as never)).rejects.toThrow(TypeError);
      }),
      params(100),
    );
  });
});

describe('fuzz: options', () => {
  const KEYS = [
    'compressionLevel',
    'blockSize',
    'sampleRate',
    'resampleQuality',
    'bitsPerSample',
    'dither',
    'ditherSeed',
    'tags',
    'seekPointInterval',
    'padding',
    'maxInputBytes',
    'copy',
  ];
  const value = fc.oneof(
    fc.anything(),
    fc.integer({ min: -10, max: 70_000 }),
    fc.double(),
    fc.constantFrom(
      'fast',
      'best',
      'tpdf',
      'none',
      false,
      true,
      null,
      {},
      { TITLE: 'x' },
      { 'A=B': 'x' },
      { T: 1 },
    ),
  );
  const opts = fc.dictionary(
    fc.oneof(fc.constantFrom(...KEYS), fc.string({ maxLength: 6 })),
    value,
    { maxKeys: 4 },
  );
  const wav = makeWav({ frames: 2000, seed: 8 });

  it('accepts or rejects any options object with INVALID_OPTIONS only', async () => {
    await fc.assert(
      fc.asyncProperty(opts, fc.boolean(), async (o, streaming) => {
        let args: ReturnType<typeof normalizeOptions> | undefined;
        try {
          args = normalizeOptions(o as Options, streaming);
        } catch (e) {
          expect(e).toBeInstanceOf(Wav2FlacError);
          expect((e as Wav2FlacError).code).toBe('INVALID_OPTIONS');
        }
        const r = await outcome(() => encodeSync(wav, o as Options));
        if (args === undefined) expect(r).toEqual({ code: 'INVALID_OPTIONS' });
        else if ('ok' in r) expect(flacTest(r.ok) ?? '').toBe('');
        else expect(['INVALID_OPTIONS', 'LIMIT_EXCEEDED']).toContain(r.code);
        // The worker validates the same way.
        expect(await outcome(() => worker.encode(wav.slice(), o as Options))).toEqual(r);
      }),
      params(200),
    );
  });
});

describe('fuzz: aborts', () => {
  const wav = makeWav({ frames: 44100, seed: 12 });
  const ref = encodeSync(wav);

  it('either completes correctly or rejects with the reason, at any point', async () => {
    const path = fc.constantFrom('encode', 'stream', 'worker', 'workerStream' as const);
    await fc.assert(
      fc.asyncProperty(
        path,
        fc.integer({ min: 0, max: 12 }),
        chunkSizes,
        async (p, after, sizes) => {
          const ac = new AbortController();
          const reason = new Error(`abort after ${after}`);
          let calls = 0;
          const onProgress = (): void => {
            if (++calls === after) ac.abort(reason);
          };
          const input = chunked(
            wav,
            sizes.map((s) => s * 16),
          );
          const opts = { signal: ac.signal, onProgress };
          if (after === 0) ac.abort(reason);
          const run = {
            encode: () => encode(input, opts),
            stream: () => collect(encodeStream(input, opts)),
            worker: () => worker.encode(input, opts),
            workerStream: () => collect(worker.encodeStream(input, opts)),
          }[p];
          try {
            const out = await run();
            expect(ac.signal.aborted && after === 0).toBe(false);
            if (p === 'encode' || p === 'worker') expect(out).toEqual(ref);
          } catch (e) {
            expect(e).toBe(reason);
          }
        },
      ),
      params(40),
    );
    // The worker is still usable after all those aborts.
    expect(await worker.encode(wav.slice())).toEqual(ref);
  });
});
