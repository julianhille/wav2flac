// SPDX-License-Identifier: 0BSD
/**
 * Fast, streaming WAV → FLAC encoding in WebAssembly, with resampling and
 * bit-depth conversion. Runs in browsers, workers and Node ≥ 22.12.
 *
 * @example
 * ```ts
 * import { encode } from 'wav2flac';
 * const flac = await encode(wavBytes, { compressionLevel: 8 });
 * ```
 * @module
 */
import { runBuffered, runStream, runSync } from './lib/engine.js';
import { toBytes, type Input } from './lib/input.js';
import { normalizeOptions, type Options } from './lib/options.js';
import { probeBytes, type WavInfo } from './lib/probe.js';
import { vendor } from '../build/bindgen/wav2flac.js';
import { init, isReady, notReady } from './lib/wasm.js';

export { Wav2FlacError, type ErrorCode } from './lib/errors.js';
export type { Input } from './lib/input.js';
export type { Options, Progress, ResampleQuality } from './lib/options.js';
export type { WavInfo } from './lib/probe.js';
export { init, initSync, wasmMemoryBytes, type WasmSource } from './lib/wasm.js';
export { createWorkerEncoder, type WorkerEncoder, type WorkerEncoderOptions } from './lib/worker-client.js';

/**
 * Encodes a WAV file to FLAC on the calling thread, yielding to the event
 * loop every few milliseconds. The result has an exact STREAMINFO (sample
 * count and MD5) and a seek table. Initializes the wasm on first use.
 *
 * @param input WAV bytes or a stream of them.
 * @param options Encoder options.
 * @returns The FLAC file.
 * @throws {Wav2FlacError} For invalid input or options.
 * @throws {TypeError} For unsupported input types.
 * @example
 * ```ts
 * const res = await fetch('/audio.wav');
 * const flac = await encode(res.body!, { onProgress: (p) => console.log(p.fraction) });
 * ```
 */
export async function encode(input: Input, options?: Options): Promise<Uint8Array> {
  const args = normalizeOptions(options, false);
  await init();
  return runBuffered(input, args, { signal: options?.signal, onProgress: options?.onProgress });
}

/**
 * Encodes a WAV file to a FLAC byte stream. The header comes first (without
 * sample count, MD5 or seek table, which are unknown until the end), then
 * frames as the consumer reads. Memory stays bounded for any input length.
 *
 * @param input WAV bytes or a stream of them.
 * @param options Encoder options (`seekPointInterval` does not apply).
 * @returns The FLAC stream. It never throws: every failure, including
 * invalid options, bad input and aborts, errors the stream instead.
 * @example
 * ```ts
 * const flac = encodeStream(response.body!);
 * await flac.pipeTo(fileWritable);
 * ```
 */
export function encodeStream(input: Input, options?: Omit<Options, 'seekPointInterval'>): ReadableStream<Uint8Array> {
  // Every failure errors the returned stream, so consumers handle one path.
  let args: ReturnType<typeof normalizeOptions>;
  try {
    args = normalizeOptions(options, true);
  } catch (e) {
    return new ReadableStream<Uint8Array>({ start: (c) => c.error(e) });
  }
  const hooks = { signal: options?.signal, onProgress: options?.onProgress };
  if (isReady()) return runStream(input, args, hooks);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  init()
    .then(() => runStream(input, args, hooks).pipeTo(writable))
    .catch((e: unknown) => writable.abort(e))
    .catch(() => undefined);
  return readable;
}

/**
 * Synchronous {@link encode} for in-memory input. Blocks the thread; prefer
 * {@link encode} or a worker for large files on a UI thread.
 *
 * @param input WAV bytes.
 * @param options Encoder options (`signal` is only checked before starting).
 * @returns The FLAC file.
 * @throws {Error} If {@link init} or {@link initSync} has not completed.
 * @throws {Wav2FlacError} For invalid options or input; see {@link ErrorCode}.
 * @example
 * ```ts
 * initSync();
 * const flac = encodeSync(readFileSync('in.wav'));
 * ```
 */
export function encodeSync(input: Uint8Array | ArrayBuffer, options?: Options): Uint8Array {
  const args = normalizeOptions(options, false);
  if (!isReady()) throw notReady();
  return runSync(toBytes(input), args, { signal: options?.signal, onProgress: options?.onProgress });
}

/**
 * Reads a WAV header without encoding. Only the header part of `input` is
 * examined.
 *
 * @param input The WAV file (at least up to the start of its `data` chunk).
 * @returns The file description.
 * @throws {Wav2FlacError} For invalid or unsupported headers.
 * @example
 * ```ts
 * const { sampleRate, channels, durationSec } = await probe(wavBytes);
 * ```
 */
export async function probe(input: Uint8Array | ArrayBuffer): Promise<WavInfo> {
  const bytes = toBytes(input);
  await init();
  return probeBytes(bytes);
}

/**
 * The encoder's version string, e.g. `wav2flac 0.1.0 (libflac-rs 0.143.1)`.
 * @returns The version string.
 * @throws {Error} If the wasm is not initialized.
 */
export function version(): string {
  if (!isReady()) throw notReady();
  return vendor();
}
