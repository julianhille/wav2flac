// SPDX-License-Identifier: 0BSD
/**
 * Stateful resampling and chunked encoding for live recordings: the
 * resampler keeps its filter state between calls, so a recording fed in small
 * pieces comes out exactly as if it had been resampled in one go, and the
 * chunk encoder cuts it into standalone FLAC files that join without seams.
 * @module
 */
import { trackLive, type Bytes } from './engine.js';
import { fromWasmError, invalidOption, Wav2FlacError } from './errors.js';
import { isDetached, SLICE_BYTES, typeTag } from './input.js';
import {
  isPlainObject,
  normalizeOptions,
  QUALITY,
  type Options,
  type ResampleQuality,
} from './options.js';
import { init, isReady, notReady } from './wasm.js';
import { WasmChunkEncoder, WasmResampler } from '../../build/bindgen/wav2flac.js';

declare global {
  interface SymbolConstructor {
    /** The symbol `using` calls (ES2026); declared here for older `lib` settings. */
    readonly dispose: unique symbol;
  }
}

/** Sample format of {@link Resampler} output. */
export type ResamplerOutput = 's16' | 'f32';

/**
 * The samples a {@link Resampler} returns: `Int16Array` for `'s16'`,
 * `Float32Array` for `'f32'`.
 */
export type ResampledSamples<O extends ResamplerOutput = ResamplerOutput> = O extends 'f32'
  ? Float32Array<ArrayBuffer>
  : Int16Array<ArrayBuffer>;

/** Options of {@link createResampler}. */
export interface ResamplerOptions<O extends ResamplerOutput = ResamplerOutput> {
  /** Sample rate of the input in Hz. */
  inputRate: number;
  /** Sample rate of the output in Hz; equal to `inputRate`, samples pass through. */
  outputRate: number;
  /** Channel count, 1–8; input and output are interleaved. Default 1. */
  channels?: number | undefined;
  /** Filter quality, as for {@link Options.resampleQuality}. Default `'balanced'`. */
  quality?: ResampleQuality | undefined;
  /**
   * `'s16'` (default): 16-bit integers, rounded to nearest without dither,
   * identical to what `encode()` writes for `bitsPerSample: 16, dither:
   * 'none'`. `'f32'`: floats, within one 16-bit step of that.
   */
  output?: O | undefined;
}

/**
 * A resampler that keeps its state between calls. However the input is split
 * into `push()` calls, the joined output is the same, and it has exactly the
 * length a one-shot conversion has. Output lags the input by up to 1024
 * input frames plus half the filter: about 23 ms (48 → 16 kHz, `'fast'`) to
 * 32 ms (44.1 → 16 kHz, `'best'`), longer at lower input rates (about 130–145
 * ms at 8 kHz); `flush()` returns the rest.
 */
export interface Resampler<S extends Int16Array | Float32Array = ResampledSamples> {
  /**
   * Feeds interleaved samples (nominally −1.0–1.0; NaN becomes 0, ±Infinity
   * ±1). A push may split a frame, but all pushes together must hold whole
   * frames.
   * @param input The samples.
   * @returns The output that is ready (often empty).
   * @throws {Wav2FlacError} `ENCODER_STATE` after {@link Resampler.flush} or a
   * failed call.
   * @throws {TypeError} If `input` is not a `Float32Array`.
   */
  push(input: Float32Array): S;
  /**
   * Ends the input. Afterwards `push()` and `flush()` fail.
   * @returns The remaining output.
   * @throws {Wav2FlacError} `INVALID_OPTIONS` if the input ends inside a
   * frame, as in `encode()`.
   * @throws {Wav2FlacError} `ENCODER_STATE` after `flush()` or a failed call.
   */
  flush(): S;
  /** Releases the wasm memory; idempotent. Call it on every path. */
  free(): void;
  /** Same as `free()`, for `using`. */
  [Symbol.dispose](): void;
}

/**
 * Options of {@link createChunkEncoder}: the encoder options for each file
 * plus a description of the input. `bitsPerSample` is required; `sampleRate`
 * (default: `inputRate`) resamples, `dither` and `ditherSeed` apply to the
 * whole recording, so files cut from it join to the same samples as one
 * `encode()` of all of it.
 */
export interface ChunkEncoderOptions extends Omit<
  Options,
  'pcm' | 'signal' | 'onProgress' | 'copy' | 'maxInputBytes' | 'bitsPerSample'
> {
  /** Sample rate of the input in Hz. */
  inputRate: number;
  /** Channel count, 1–8; input is interleaved. Default 1. */
  channels?: number | undefined;
  /** Bit depth of the files, 4–32. */
  bitsPerSample: number;
  /**
   * Samples per channel in each file (at the output rate). Set, the encoder
   * cuts exactly there ({@link ExactChunkEncoder}); unset, it cuts wherever
   * you call `encode()` ({@link ChunkEncoder}). Required with `onChunk`.
   */
  chunkSamples?: number | undefined;
  /**
   * Leave unset. With an `onChunk` callback, the options are
   * {@link CallbackChunkEncoderOptions}.
   */
  onChunk?: undefined;
}

/**
 * Options of {@link createChunkEncoder} with an `onChunk` callback: the
 * encoder hands each file to it instead of returning the files
 * ({@link CallbackChunkEncoder}).
 */
export interface CallbackChunkEncoderOptions extends Omit<
  ChunkEncoderOptions,
  'chunkSamples' | 'onChunk'
> {
  /** Samples per channel in each file (at the output rate). */
  chunkSamples: number;
  /**
   * Receives each file, in order, synchronously inside `push()` and
   * `finish()`; the file's `buffer` holds just the file, so it can be sent
   * as is. The types reject an async function or one that returns a
   * promise: start slow work (an upload) inside it and catch its rejection
   * there. If it throws, the error is logged with `console.error` and the
   * encoder carries on with the next file. Calling the encoder from inside
   * it throws `ENCODER_STATE`.
   * @param file A standalone FLAC file.
   */
  onChunk: (file: Bytes) => void | undefined;
}

/**
 * Cuts a recording into FLAC files wherever you call {@link ChunkEncoder.encode}.
 * Joined in order, the files hold exactly the samples of one `encode()` of the
 * whole recording with the same options.
 */
export interface ChunkEncoder {
  /**
   * Feeds interleaved samples. A push may split a frame, but all pushes
   * together must hold whole frames.
   * @param input The samples.
   * @throws {TypeError} If `input` is not a `Float32Array`.
   * @throws {Wav2FlacError} `ENCODER_STATE` after `finish()` or a failed call.
   */
  push(input: Float32Array): void;
  /**
   * Feeds `input`, if given, then cuts a file of everything since the last cut.
   * Samples still inside the resampler (see {@link Resampler}) go to the next file.
   * @param input Samples to feed first.
   * @returns The file, or `null` when no sample is ready.
   * @throws {Wav2FlacError} `ENCODER_STATE` after `finish()` or a failed call.
   */
  encode(input?: Float32Array): Bytes | null;
  /**
   * Ends the input and cuts the last file. Afterwards every call but `free()` fails.
   * @returns The file, or `null` when no sample was left.
   * @throws {Wav2FlacError} `INVALID_OPTIONS` if the input ends inside a
   * frame, as in `encode()`.
   * @throws {Wav2FlacError} `ENCODER_STATE` after `finish()` or a failed call.
   */
  finish(): Bytes | null;
  /** Releases the wasm memory; idempotent. Call it on every path. */
  free(): void;
  /** Same as `free()`, for `using`. */
  [Symbol.dispose](): void;
}

/**
 * Cuts a recording into FLAC files of exactly `chunkSamples` samples per
 * channel; only the last file is shorter.
 */
export interface ExactChunkEncoder {
  /**
   * Feeds interleaved samples. A push may split a frame, but all pushes
   * together must hold whole frames.
   * @param input The samples.
   * @throws {TypeError} If `input` is not a `Float32Array`.
   * @throws {Wav2FlacError} `ENCODER_STATE` after `finish()` or a failed call.
   */
  push(input: Float32Array): void;
  /**
   * Feeds `input`, if given, then returns the full files that are ready.
   * @param input Samples to feed first.
   * @returns The files, possibly none.
   * @throws {Wav2FlacError} `ENCODER_STATE` after `finish()` or a failed call.
   */
  encode(input?: Float32Array): Bytes[];
  /**
   * Ends the input. Afterwards every call but `free()` fails.
   * @returns The remaining full files, then the shorter last one, if any.
   * @throws {Wav2FlacError} `INVALID_OPTIONS` if the input ends inside a
   * frame, as in `encode()`.
   * @throws {Wav2FlacError} `ENCODER_STATE` after `finish()` or a failed call.
   */
  finish(): Bytes[];
  /** Releases the wasm memory; idempotent. Call it on every path. */
  free(): void;
  /** Same as `free()`, for `using`. */
  [Symbol.dispose](): void;
}

/**
 * A chunk encoder that hands each file to the `onChunk` callback instead of
 * returning it. The files have exactly `chunkSamples` samples per channel and
 * only the last is shorter. Joined in order, they hold exactly the samples of
 * one `encode()` of the whole recording with the same options.
 */
export interface CallbackChunkEncoder {
  /**
   * Feeds interleaved samples, then calls `onChunk` for each file that is now
   * full. A push may split a frame, but all pushes together must hold whole
   * frames. After `finish()`, even a failed one, it drops the samples and
   * logs a warning with `console.warn`.
   * @param input The samples.
   * @throws {TypeError} If `input` is not a `Float32Array`.
   * @throws {Wav2FlacError} `ENCODER_STATE` after a failed `push()`, or
   * from inside `onChunk`.
   */
  push(input: Float32Array): void;
  /**
   * Ends the input and calls `onChunk` for the remaining files: the full
   * ones, then the shorter last one, if any. All calls are made before it
   * returns. Afterwards `push()` drops its samples and `finish()` fails.
   * @throws {Wav2FlacError} `INVALID_OPTIONS` if the input ends inside a
   * frame.
   * @throws {Wav2FlacError} `ENCODER_STATE` after `finish()` or a failed
   * `push()`, or from inside `onChunk`.
   */
  finish(): void;
  /**
   * Releases the wasm memory; idempotent. Call it on every path.
   * @throws {Wav2FlacError} `ENCODER_STATE` from inside `onChunk`.
   */
  free(): void;
  /** Same as `free()`, for `using`. */
  [Symbol.dispose](): void;
}

/**
 * Floats per wasm call (1 MiB), as `encode()` slices its input: wasm memory
 * never shrinks, so a huge push copied in at once would keep its size.
 */
const PUSH_FLOATS = SLICE_BYTES / 4;
const RESAMPLER_KEYS: ReadonlySet<string> = new Set([
  'inputRate',
  'outputRate',
  'channels',
  'quality',
  'output',
]);
const CHUNK_KEYS: ReadonlySet<string> = new Set([
  'inputRate',
  'channels',
  'chunkSamples',
  'onChunk',
]);
const NOT_FOR_CHUNKS: ReadonlySet<string> = new Set([
  'pcm',
  'signal',
  'onProgress',
  'copy',
  'maxInputBytes',
]);

/**
 * Checks that options are a plain object.
 * @param v The options.
 * @returns Them, as a record.
 */
function record(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || !isPlainObject(v)) {
    throw invalidOption('options must be an object');
  }
  return v as Record<string, unknown>;
}

/**
 * Reads a positive integer option.
 * @param o Options.
 * @param key Option name.
 * @param dflt Value when unset; `undefined` makes it required.
 * @param max Largest accepted value.
 * @returns The value.
 */
function positive(
  o: Record<string, unknown>,
  key: string,
  dflt: number | undefined,
  max: number,
): number {
  const v = o[key];
  if (v === undefined && dflt !== undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
    throw invalidOption(`${key} must be an integer between 1 and ${max}`);
  }
  return v;
}

/**
 * Checks pushed samples.
 * @param x Candidate.
 */
function checkSamples(x: unknown): asserts x is Float32Array {
  if (typeTag(x) !== 'Float32Array') {
    throw new TypeError(`wav2flac: samples must be a Float32Array, got ${typeTag(x)}`);
  }
  if (isDetached(x)) throw new TypeError('wav2flac: samples were transferred (detached)');
}

/** Arguments of the wasm resampler. */
interface ResamplerArgs {
  inputRate: number;
  outputRate: number;
  channels: number;
  quality: number;
  f32: boolean;
}

/**
 * Validates resampler options.
 * @param options User options.
 * @returns Constructor arguments.
 */
function resamplerArgs(options: unknown): ResamplerArgs {
  const o = record(options);
  for (const k of Object.keys(o)) {
    if (!RESAMPLER_KEYS.has(k)) throw invalidOption(`unknown option "${k}"`);
  }
  const q = o['quality'] === undefined ? 'balanced' : o['quality'];
  if (typeof q !== 'string' || !Object.hasOwn(QUALITY, q)) {
    throw invalidOption('quality must be "fast", "balanced" or "best"');
  }
  const out = o['output'] === undefined ? 's16' : o['output'];
  if (out !== 's16' && out !== 'f32') throw invalidOption('output must be "s16" or "f32"');
  return {
    inputRate: positive(o, 'inputRate', undefined, 2 ** 32 - 1),
    outputRate: positive(o, 'outputRate', undefined, 2 ** 32 - 1),
    channels: positive(o, 'channels', 1, Number.MAX_SAFE_INTEGER),
    quality: QUALITY[q as ResampleQuality],
    f32: out === 'f32',
  };
}

/**
 * Joins the output of several wasm calls.
 * @param parts Arrays of one type.
 * @returns One array of that type.
 */
function join<T extends Float32Array | Int16Array>(parts: T[]): T {
  const Ctor = parts[0]!.constructor as new (n: number) => T;
  const out = new Ctor(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** {@link Resampler} over the wasm one. */
class StatefulResampler implements Resampler<Float32Array | Int16Array> {
  #r: WasmResampler | undefined;

  /**
   * @param a Validated arguments.
   */
  constructor(a: ResamplerArgs) {
    try {
      this.#r = new WasmResampler(a.inputRate, a.outputRate, a.channels, a.quality, a.f32);
    } catch (e) {
      throw fromWasmError(e);
    }
    trackLive(1);
  }

  /**
   * The live resampler.
   * @returns It.
   */
  #live(): WasmResampler {
    if (this.#r === undefined) throw new Error('wav2flac: resampler already freed');
    return this.#r;
  }

  push(input: Float32Array): Float32Array | Int16Array {
    checkSamples(input);
    const r = this.#live();
    try {
      if (input.length <= PUSH_FLOATS) return r.push(input) as Float32Array | Int16Array;
      const parts: (Float32Array | Int16Array)[] = [];
      for (let i = 0; i < input.length; i += PUSH_FLOATS) {
        parts.push(r.push(input.subarray(i, i + PUSH_FLOATS)) as Float32Array | Int16Array);
      }
      return join(parts);
    } catch (e) {
      throw fromWasmError(e);
    }
  }

  flush(): Float32Array | Int16Array {
    const r = this.#live();
    try {
      return r.flush() as Float32Array | Int16Array;
    } catch (e) {
      throw fromWasmError(e);
    }
  }

  free(): void {
    const r = this.#r;
    if (r === undefined) return;
    this.#r = undefined;
    trackLive(-1);
    try {
      r.free();
    } catch {
      // After a wasm trap the object cannot be freed; it is lost either way.
    }
  }

  [Symbol.dispose](): void {
    this.free();
  }
}

/**
 * Synchronous {@link createResampler}, for when the wasm is already initialized.
 * @param options Rates, channels, quality and output format.
 * @returns The resampler; release it with `free()`.
 * @throws {Error} If {@link init} or `initSync()` has not completed.
 * @throws {Wav2FlacError} `INVALID_OPTIONS`, `TOO_MANY_CHANNELS`, or
 * `UNSUPPORTED_FORMAT` for a ratio above 256 or below 1/65536.
 */
export function createResamplerSync<O extends ResamplerOutput = 's16'>(
  options: ResamplerOptions<O>,
): Resampler<ResampledSamples<O>> {
  const a = resamplerArgs(options);
  if (!isReady()) throw notReady();
  return new StatefulResampler(a) as unknown as Resampler<ResampledSamples<O>>;
}

/**
 * Creates a {@link Resampler} that keeps its state between calls, for audio
 * that arrives in pieces. Initializes the wasm on first use.
 * @param options Rates, channels, quality and output format.
 * @returns The resampler; release it with `free()`.
 * @throws {Wav2FlacError} `INVALID_OPTIONS`, `TOO_MANY_CHANNELS`, or
 * `UNSUPPORTED_FORMAT` for a ratio above 256 or below 1/65536.
 * @example 48 kHz microphone frames to 16 kHz, 16-bit:
 * ```ts
 * const r = await createResampler({ inputRate: 48000, outputRate: 16000, quality: 'fast' });
 * try {
 *   for (const frame of frames) send(r.push(frame));
 *   send(r.flush());
 * } finally {
 *   r.free();
 * }
 * ```
 */
export async function createResampler<O extends ResamplerOutput = 's16'>(
  options: ResamplerOptions<O>,
): Promise<Resampler<ResampledSamples<O>>> {
  const a = resamplerArgs(options);
  await init();
  return new StatefulResampler(a) as unknown as Resampler<ResampledSamples<O>>;
}

/** A validated chunk encoder: its constructor, ready to call. */
type ChunkFactory = () => ChunkEncoder | ExactChunkEncoder | CallbackChunkEncoder;

/**
 * Validates chunk encoder options.
 * @param options User options.
 * @returns A factory for the encoder.
 */
function chunkFactory(options: unknown): ChunkFactory {
  const o = record(options);
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (NOT_FOR_CHUNKS.has(k)) throw invalidOption(`option "${k}" is not supported here`);
    if (!CHUNK_KEYS.has(k)) rest[k] = v;
  }
  const a = normalizeOptions(rest, false);
  const inputRate = positive(o, 'inputRate', undefined, 2 ** 32 - 1);
  const channels = positive(o, 'channels', 1, Number.MAX_SAFE_INTEGER);
  const exact = o['chunkSamples'] !== undefined;
  const chunk = exact ? positive(o, 'chunkSamples', undefined, Number.MAX_SAFE_INTEGER) : -1;
  const onChunk = o['onChunk'];
  if (onChunk !== undefined && typeof onChunk !== 'function') {
    throw invalidOption('onChunk must be a function');
  }
  if (onChunk !== undefined && !exact) throw invalidOption('onChunk needs chunkSamples');
  return () => {
    let enc: WasmChunkEncoder;
    try {
      enc = new WasmChunkEncoder(
        a.level,
        a.blockSize,
        a.sampleRate,
        a.quality,
        a.bits,
        a.dither,
        a.seed,
        a.tagsEnabled,
        a.tagKeys,
        a.tagValues,
        a.seekPointInterval,
        a.padding,
        inputRate,
        channels,
        chunk,
      );
    } catch (e) {
      throw fromWasmError(e);
    }
    if (onChunk !== undefined) return new Callback(enc, onChunk as (file: Bytes) => void);
    return exact ? new Exact(enc) : new Varying(enc);
  };
}

/** What the chunk encoders share. */
abstract class ChunkBase {
  #enc: WasmChunkEncoder | undefined;

  /**
   * @param enc The wasm encoder, now owned by this object.
   */
  constructor(enc: WasmChunkEncoder) {
    this.#enc = enc;
    trackLive(1);
  }

  /**
   * The live encoder.
   * @returns It.
   */
  #live(): WasmChunkEncoder {
    if (this.#enc === undefined) throw new Error('wav2flac: chunk encoder already freed');
    return this.#enc;
  }

  push(input: Float32Array): void {
    this.feed(input);
  }

  /**
   * Feeds `input` to the wasm encoder.
   * @param input The samples.
   */
  protected feed(input: Float32Array): void {
    checkSamples(input);
    const e = this.#live();
    try {
      if (input.length <= PUSH_FLOATS) e.push(input);
      else {
        for (let i = 0; i < input.length; i += PUSH_FLOATS) {
          e.push(input.subarray(i, i + PUSH_FLOATS));
        }
      }
    } catch (err) {
      throw fromWasmError(err);
    }
  }

  /**
   * Feeds `input`, then cuts (or finishes) and takes the files.
   * @param input Samples to feed first.
   * @param last Whether this ends the input.
   * @returns The files.
   */
  protected cut(input: Float32Array | undefined, last: boolean): Bytes[] {
    if (input !== undefined) this.feed(input);
    const e = this.#live();
    try {
      return (last ? e.finish() : e.cut()) as Bytes[];
    } catch (err) {
      throw fromWasmError(err);
    }
  }

  free(): void {
    const e = this.#enc;
    if (e === undefined) return;
    this.#enc = undefined;
    trackLive(-1);
    try {
      e.free();
    } catch {
      // After a wasm trap the object cannot be freed; it is lost either way.
    }
  }

  [Symbol.dispose](): void {
    this.free();
  }
}

/** {@link ChunkEncoder}. */
class Varying extends ChunkBase implements ChunkEncoder {
  encode(input?: Float32Array): Bytes | null {
    return this.cut(input, false)[0] ?? null;
  }

  finish(): Bytes | null {
    return this.cut(undefined, true)[0] ?? null;
  }
}

/** {@link ExactChunkEncoder}. */
class Exact extends ChunkBase implements ExactChunkEncoder {
  encode(input?: Float32Array): Bytes[] {
    return this.cut(input, false);
  }

  finish(): Bytes[] {
    return this.cut(undefined, true);
  }
}

/** {@link CallbackChunkEncoder}. */
class Callback extends ChunkBase implements CallbackChunkEncoder {
  readonly #onChunk: (file: Bytes) => void;
  /** Whether `onChunk` is running. */
  #busy = false;
  /** Whether `finish()` was called. */
  #finished = false;

  /**
   * @param enc The wasm encoder, now owned by this object.
   * @param onChunk Receives each file.
   */
  constructor(enc: WasmChunkEncoder, onChunk: (file: Bytes) => void) {
    super(enc);
    this.#onChunk = onChunk;
  }

  /** Throws `ENCODER_STATE` inside `onChunk`. */
  #check(): void {
    if (this.#busy) {
      throw new Wav2FlacError('ENCODER_STATE', 'chunk encoder called from inside onChunk');
    }
  }

  /**
   * Hands the files to `onChunk`, in order, logging what it throws.
   * @param files The files.
   */
  #deliver(files: Bytes[]): void {
    const onChunk = this.#onChunk;
    this.#busy = true;
    try {
      for (const f of files) {
        try {
          onChunk(f);
        } catch (e) {
          try {
            console.error('wav2flac: onChunk threw', e);
          } catch {
            // A throwing console must not lose the next files.
          }
        }
      }
    } finally {
      this.#busy = false;
    }
  }

  override push(input: Float32Array): void {
    this.#check();
    checkSamples(input);
    if (this.#finished) {
      console.warn('wav2flac: push() after finish(); samples dropped');
      return;
    }
    // Cut per slice: files go out early and wasm memory stays small. An empty
    // push still reaches the wasm encoder, so its state errors still show.
    const n = input.length; // read once: onChunk may detach the input
    let i = 0;
    do this.#deliver(this.cut(input.subarray(i, i + PUSH_FLOATS), false));
    while ((i += PUSH_FLOATS) < n);
  }

  finish(): void {
    this.#check();
    // Set first: even a failed finish() ends the input.
    this.#finished = true;
    this.#deliver(this.cut(undefined, true));
  }

  override free(): void {
    this.#check();
    super.free();
  }
}

/**
 * Synchronous {@link createChunkEncoder}, for when the wasm is already initialized.
 * @param options Encoder options and the input description.
 * @returns The encoder; release it with `free()`.
 * @throws {Error} If {@link init} or `initSync()` has not completed.
 * @throws {Wav2FlacError} For invalid options.
 */
export function createChunkEncoderSync(
  options: ChunkEncoderOptions & { chunkSamples: number },
): ExactChunkEncoder;
export function createChunkEncoderSync(
  options: ChunkEncoderOptions & { chunkSamples?: undefined },
): ChunkEncoder;
export function createChunkEncoderSync(options: CallbackChunkEncoderOptions): CallbackChunkEncoder;
export function createChunkEncoderSync(
  options: ChunkEncoderOptions,
): ChunkEncoder | ExactChunkEncoder;
export function createChunkEncoderSync(
  options: ChunkEncoderOptions | CallbackChunkEncoderOptions,
): ChunkEncoder | ExactChunkEncoder | CallbackChunkEncoder {
  const make = chunkFactory(options);
  if (!isReady()) throw notReady();
  return make();
}

/**
 * Creates an encoder that cuts a recording into standalone FLAC files. The
 * resampler and dither state carry over from file to file, so the joined
 * files equal one `encode()` of the whole recording: no seams, no lost or
 * repeated samples. With `chunkSamples` the files have exactly that length
 * ({@link ExactChunkEncoder}); without, each `encode()` call cuts one
 * ({@link ChunkEncoder}). Options typed as plain {@link ChunkEncoderOptions}
 * give either; write them inline or with `satisfies` for the exact type.
 * With `onChunk` and `chunkSamples` ({@link CallbackChunkEncoderOptions}),
 * `push()` and `finish()` hand each file to that callback instead
 * ({@link CallbackChunkEncoder}).
 * Initializes the wasm on first use.
 * @param options Encoder options and the input description.
 * @returns The encoder; release it with `free()`.
 * @throws {Wav2FlacError} For invalid options.
 * @example 48 kHz microphone frames to one 16 kHz FLAC file per utterance:
 * ```ts
 * const enc = await createChunkEncoder({
 *   inputRate: 48000,
 *   sampleRate: 16000,
 *   bitsPerSample: 16,
 *   resampleQuality: 'fast',
 * });
 * try {
 *   for (const frame of frames) enc.push(frame);
 *   const flac = enc.encode(); // everything since the last cut, or null
 *   const last = enc.finish();
 * } finally {
 *   enc.free();
 * }
 * ```
 * @example 5-second files through a callback:
 * ```ts
 * const enc = await createChunkEncoder({
 *   inputRate: 48000,
 *   sampleRate: 16000,
 *   bitsPerSample: 16,
 *   resampleQuality: 'fast',
 *   chunkSamples: 80000,
 *   onChunk: (flac) => {
 *     upload(flac).catch((e) => console.error('upload failed', e));
 *   },
 * });
 * try {
 *   for (const frame of frames) enc.push(frame); // calls onChunk per full file
 *   enc.finish(); // calls onChunk for the rest
 * } finally {
 *   enc.free();
 * }
 * ```
 */
export async function createChunkEncoder(
  options: ChunkEncoderOptions & { chunkSamples: number },
): Promise<ExactChunkEncoder>;
export async function createChunkEncoder(
  options: ChunkEncoderOptions & { chunkSamples?: undefined },
): Promise<ChunkEncoder>;
export async function createChunkEncoder(
  options: CallbackChunkEncoderOptions,
): Promise<CallbackChunkEncoder>;
export async function createChunkEncoder(
  options: ChunkEncoderOptions,
): Promise<ChunkEncoder | ExactChunkEncoder>;
export async function createChunkEncoder(
  options: ChunkEncoderOptions | CallbackChunkEncoderOptions,
): Promise<ChunkEncoder | ExactChunkEncoder | CallbackChunkEncoder> {
  const make = chunkFactory(options);
  await init();
  return make();
}
