// SPDX-License-Identifier: 0BSD
/**
 * Input normalization: byte views, fixed-size slicing and stream reading.
 * @module
 * @internal
 */

import { invalidOption } from './errors.js';
import { PCM_FORMATS, type EncoderArgs, type PcmSampleFormat } from './options.js';
import { ignore } from './platform.js';

/** Anything the encoder accepts as WAV input. */
export type Input = Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

/** Typed arrays whose element type implies a PCM sample format. */
export type PcmSamples = Int16Array | Int32Array | Float32Array;

/**
 * In-memory raw PCM input (with the `pcm` option): interleaved samples, one
 * array per channel (planar, e.g. `AudioBuffer.getChannelData()`), or bytes.
 */
export type PcmBuffer = PcmSamples | readonly PcmSamples[] | Uint8Array | ArrayBuffer;

/**
 * Raw PCM input (with the `pcm` option). Streams need `pcm.format`; their
 * chunks are bytes (`Uint8Array`, `DataView`, `ArrayBuffer`) or the typed
 * array of that format.
 */
export type PcmInput = PcmBuffer | ReadableStream<ArrayBufferView | ArrayBuffer>;

/** Largest piece handed to wasm at once by `encodeSync` (bounds wasm memory growth). */
export const SLICE_BYTES = 1 << 20;

/**
 * Largest piece handed to wasm at once by the async paths: small enough that
 * one push takes a few ms, so yielding keeps the thread responsive.
 */
export const ASYNC_SLICE_BYTES = 1 << 16;

/** What the in-memory-only entry points (`encodeSync`, `probe`) accept. */
export const BUFFER_INPUT = 'a Uint8Array or ArrayBuffer';

/**
 * The built-in type tag of a value; unlike `instanceof`, it also works for
 * values from another realm (iframe, `vm` context).
 * @param x Candidate.
 * @returns The tag, e.g. `ArrayBuffer` or `Int16Array`.
 */
function typeTag(x: unknown): string {
  return Object.prototype.toString.call(x).slice(8, -1);
}

/**
 * Checks for an `ArrayBuffer` or `SharedArrayBuffer`, also across realms.
 * @param x Candidate.
 * @returns `true` for array buffers.
 */
function isBuffer(x: unknown): x is ArrayBuffer {
  const t = typeTag(x);
  return t === 'ArrayBuffer' || t === 'SharedArrayBuffer';
}

/**
 * Whether a buffer (or a view's buffer) was detached, e.g. by a transfer.
 * @param x Candidate.
 * @returns `true` for detached buffers.
 */
function isDetached(x: unknown): boolean {
  const b: unknown = ArrayBuffer.isView(x) ? x.buffer : x;
  return isBuffer(b) && (b as { detached?: boolean }).detached === true;
}

/**
 * Checks for a `ReadableStream` (also across realms).
 * @param x Candidate.
 * @returns `true` for readable streams.
 */
export function isStream(x: unknown): x is ReadableStream<Uint8Array> {
  return typeof x === 'object' && x !== null && typeof (x as ReadableStream).getReader === 'function';
}

/**
 * Views a byte input as a `Uint8Array` without copying. Byte views and
 * buffers from other realms are accepted too.
 * @param input `Uint8Array` (or another 8-bit view) or `ArrayBuffer`.
 * @param what Name used in the error message.
 * @param accepted What the caller accepts, for the error message.
 * @returns A view of the bytes.
 * @throws {TypeError} For any other type.
 */
export function toBytes(input: unknown, what = 'input', accepted = 'a Uint8Array, ArrayBuffer or ReadableStream<Uint8Array>'): Uint8Array {
  if (isDetached(input)) {
    throw new TypeError(`wav2flac: ${what} was transferred (detached) by an earlier worker call; pass \`copy: true\` to keep it`);
  }
  if (input instanceof Uint8Array) return input;
  if (isBuffer(input)) return new Uint8Array(input);
  if (ArrayBuffer.isView(input) && typeTag(input) !== 'DataView' && (input as Uint8Array).BYTES_PER_ELEMENT === 1) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError(`wav2flac: ${what} must be ${accepted}`);
}

/**
 * Splits bytes into views of at most `size` bytes.
 * @param bytes The bytes.
 * @param size Largest slice.
 * @yields Consecutive views (none for empty input).
 */
export function* slices(bytes: Uint8Array, size = SLICE_BYTES): Generator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.subarray(i, Math.min(i + size, bytes.length));
  }
}

/**
 * Iterates any {@link Input} as byte slices. Streams are read one chunk at a
 * time; if iteration stops early, or `signal` aborts (even while a read is
 * pending), the stream is cancelled.
 * @param input The input.
 * @param size Largest slice.
 * @param signal Cancels a stream input when aborted.
 * @yields Byte slices of at most `size` bytes.
 * @throws {TypeError} For unsupported inputs or non-byte stream chunks.
 */
export async function* chunks(input: Input, size = ASYNC_SLICE_BYTES, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!isStream(input)) {
    yield* slices(toBytes(input), size);
    return;
  }
  const reader = input.getReader();
  let done = false;
  const onAbort = (): void => {
    void reader.cancel(signal?.reason).catch(ignore);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const r = await reader.read();
      signal?.throwIfAborted();
      if (r.done) {
        done = true;
        return;
      }
      yield* slices(toBytes(r.value, 'stream chunk'), size);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!done) await reader.cancel(signal?.reason).catch(ignore);
    reader.releaseLock();
  }
}

/**
 * The sample format implied by a typed array, if any.
 * @param x Candidate.
 * @returns The format, or `undefined` for other values.
 */
function impliedFormat(x: unknown): PcmSampleFormat | undefined {
  if (!ArrayBuffer.isView(x)) return undefined;
  return ({ Int16Array: 's16', Int32Array: 's32', Float32Array: 'f32' } as const)[typeTag(x)];
}

/**
 * Views any typed array, DataView or ArrayBuffer as bytes, without copying.
 * @param x The value.
 * @param what Name used in the error message.
 * @returns A byte view.
 * @throws {TypeError} For other values.
 */
function anyBytes(x: unknown, what: string): Uint8Array {
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (isBuffer(x)) return new Uint8Array(x);
  throw new TypeError(`wav2flac: ${what} must be a typed array or ArrayBuffer`);
}

/**
 * Interleaves one typed array per channel into a new array of the same type.
 * @param planes The channel arrays.
 * @returns The interleaved samples.
 * @throws {Wav2FlacError} `INVALID_OPTIONS` for mixed types or lengths.
 */
function interleave(planes: readonly PcmSamples[]): PcmSamples {
  const first = planes[0];
  if (first === undefined) throw invalidOption('planar pcm input needs one array per channel');
  const ctor = first.constructor as new (n: number) => PcmSamples;
  const n = first.length;
  const ch = planes.length;
  for (const p of planes) {
    if (p.constructor !== ctor || impliedFormat(p) === undefined) {
      throw invalidOption('planar pcm arrays must all be Int16Array, Int32Array or Float32Array of one type');
    }
    if (p.length !== n) throw invalidOption('planar pcm arrays must have equal lengths');
  }
  const out = new ctor(n * ch);
  for (let c = 0; c < ch; c++) {
    const p = planes[c] as PcmSamples;
    for (let i = 0, o = c; i < n; i++, o += ch) out[o] = p[i] as number;
  }
  return out;
}

/**
 * Checks one PCM value against the sample format and views it as bytes.
 * Typed arrays that imply a format must match it; other than those, only
 * `Uint8Array`, `DataView` and `ArrayBuffer` (raw bytes) are accepted.
 * @param x The value.
 * @param format The resolved sample format.
 * @param what Name used in the error message.
 * @returns A byte view.
 * @throws {TypeError} For detached buffers and non-array values.
 * @throws {Wav2FlacError} `INVALID_OPTIONS` for arrays of another format.
 */
function pcmBytes(x: unknown, format: PcmSampleFormat, what: string): Uint8Array {
  if (isDetached(x)) {
    throw new TypeError(`wav2flac: ${what} was transferred (detached) by an earlier worker call; pass \`copy: true\` to keep it`);
  }
  const implied = impliedFormat(x);
  if (implied !== undefined && implied !== format) {
    throw invalidOption(`pcm.format "${format}" does not match ${what} (${typeTag(x)})`);
  }
  const tag = typeTag(x);
  if (implied === undefined && tag !== 'Uint8Array' && tag !== 'DataView' && !isBuffer(x)) {
    if (ArrayBuffer.isView(x)) {
      throw invalidOption(`${what} must be Int16Array, Int32Array, Float32Array, Uint8Array or ArrayBuffer`);
    }
    throw new TypeError(`wav2flac: ${what} must be a typed array or ArrayBuffer`);
  }
  return anyBytes(x, what);
}

/**
 * Views a stream of typed arrays as a byte stream, checking every chunk
 * against the sample format. The source is only locked once the result is
 * first read, so a caller that fails before reading (e.g. on invalid
 * options) leaves it untouched; it is unlocked again when it ends.
 * @param source The stream.
 * @param format The sample format.
 * @returns A byte stream; cancelling it cancels the source.
 */
function byteStream(source: ReadableStream<unknown>, format: PcmSampleFormat): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      reader ??= source.getReader();
      const r = await reader.read();
      if (r.done) {
        reader.releaseLock();
        c.close();
        return;
      }
      try {
        c.enqueue(pcmBytes(r.value, format, 'stream chunk'));
      } catch (e) {
        await reader.cancel(e).catch(ignore);
        reader.releaseLock();
        throw e;
      }
    },
    async cancel(reason) {
      if (reader === undefined) return source.cancel(reason);
      await reader.cancel(reason);
      reader.releaseLock();
    },
  }, { highWaterMark: 0 });
}

/**
 * Resolves raw PCM input: infers the sample format, interleaves planar input
 * and turns everything into bytes (a view where possible). WAV input (no
 * `pcm` option) is returned unchanged.
 * @param input The caller's input.
 * @param args Normalized options.
 * @returns Byte input and the completed arguments.
 * @throws {Wav2FlacError} `INVALID_OPTIONS` when the format is missing or contradicts the input.
 * @throws {TypeError} For unsupported input types.
 */
export function preparePcm(input: unknown, args: EncoderArgs): { input: Input; args: EncoderArgs } {
  if (args.pcmFormat === 0) return { input: input as Input, args };
  let format: PcmSampleFormat | undefined = PCM_FORMATS[args.pcmFormat - 1];
  const resolve = (implied: PcmSampleFormat | undefined, what: string): number => {
    if (implied !== undefined && format !== undefined && implied !== format) {
      throw invalidOption(`pcm.format "${format}" does not match ${what} (${implied})`);
    }
    format ??= implied;
    if (format === undefined) {
      throw invalidOption(`pcm.format is required for ${what}; it is only inferred from Int16Array, Int32Array and Float32Array`);
    }
    return PCM_FORMATS.indexOf(format) + 1;
  };
  if (isStream(input)) {
    const pcmFormat = resolve(undefined, 'streams');
    return { input: byteStream(input, format as PcmSampleFormat), args: { ...args, pcmFormat, pcmTotalBytes: -1 } };
  }
  let samples: unknown = input;
  if (isDetached(input) || (Array.isArray(input) && input.some(isDetached))) {
    throw new TypeError('wav2flac: pcm input was transferred (detached) by an earlier worker call; pass `copy: true` to keep it');
  }
  if (Array.isArray(input)) {
    if (input.length !== args.pcmChannels) {
      throw invalidOption(`planar pcm input has ${input.length} arrays for ${args.pcmChannels} channels`);
    }
    samples = interleave(input as readonly PcmSamples[]);
  }
  if (!(ArrayBuffer.isView(samples) && typeTag(samples) !== 'DataView') && !isBuffer(samples)) {
    throw new TypeError('wav2flac: pcm input must be a typed array, an array of them, an ArrayBuffer or a ReadableStream');
  }
  const implied = impliedFormat(samples);
  if (implied === undefined && typeTag(samples) !== 'Uint8Array' && !isBuffer(samples)) {
    throw invalidOption('pcm input must be Int16Array, Int32Array, Float32Array, Uint8Array or ArrayBuffer');
  }
  const pcmFormat = resolve(implied, implied === undefined ? 'byte input' : typeTag(samples));
  const bytes = pcmBytes(samples, format as PcmSampleFormat, 'pcm input');
  return { input: bytes, args: { ...args, pcmFormat, pcmTotalBytes: bytes.byteLength } };
}
