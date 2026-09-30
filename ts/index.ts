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
import { runBuffered, runStream, runSync, type Bytes } from './lib/engine.js';
import {
  BUFFER_INPUT,
  releaseUnread,
  preparePcm,
  toBytes,
  type Input,
  type PcmBuffer,
  type PcmInput,
} from './lib/input.js';
import { normalizeOptions, type Options } from './lib/options.js';
import { ignore } from './lib/platform.js';
import { probeBytes, type WavInfo } from './lib/probe.js';
import { vendor } from '../build/bindgen/wav2flac.js';
import { init, isReady, notReady, wasmModule } from './lib/wasm.js';

export { Wav2FlacError, type ErrorCode } from './lib/errors.js';
export type { Bytes } from './lib/engine.js';
export type { Input, PcmBuffer, PcmInput, PcmSamples } from './lib/input.js';
export type {
  Options,
  PcmFormat,
  PcmSampleFormat,
  Progress,
  ResampleQuality,
} from './lib/options.js';
export type { WavInfo } from './lib/probe.js';
export { init, initSync, wasmMemoryBytes, type InitOptions, type WasmSource } from './lib/wasm.js';
export {
  createWorkerEncoder,
  type WorkerEncoder,
  type WorkerEncoderOptions,
} from './lib/worker-client.js';

/**
 * Encodes a WAV file to FLAC on the calling thread, yielding to the event
 * loop every few milliseconds. The result has an exact STREAMINFO (sample
 * count and MD5) and a seek table. Initializes the wasm on first use.
 *
 * With the `pcm` option the input is raw samples instead of a WAV file:
 * a typed array (`Int16Array`, `Int32Array` and `Float32Array` imply the
 * sample format), one array per channel, raw bytes, or a stream of them.
 *
 * @param input WAV bytes or a stream of them; raw PCM with `options.pcm`.
 * @param options Encoder options.
 * @returns The FLAC file.
 * @throws {Wav2FlacError} For invalid input or options.
 * @throws {TypeError} For unsupported input types.
 * @example
 * ```ts
 * const res = await fetch('/audio.wav');
 * const flac = await encode(res.body!, { onProgress: (p) => console.log(p.fraction) });
 * ```
 * @example Raw PCM, e.g. 16 kHz mono float samples from an AudioWorklet:
 * ```ts
 * const flac = await encode(samples, { pcm: { sampleRate: 16000, channels: 1 }, bitsPerSample: 16 });
 * ```
 */
export async function encode(input: Input | PcmInput, options?: Options): Promise<Bytes> {
  let p: ReturnType<typeof preparePcm>;
  try {
    p = preparePcm(input, normalizeOptions(options, false));
  } catch (e) {
    // Bad options fail the encode, so a stream input is cancelled too.
    releaseUnread(input, e);
    throw e;
  }
  await init(undefined, { signal: options?.signal }).catch((e: unknown) => {
    // As for any failed encode, a stream input is cancelled.
    releaseUnread(p.input, e);
    throw e;
  });
  return runBuffered(p.input, p.args, { signal: options?.signal, onProgress: options?.onProgress });
}

/**
 * Encodes a WAV file to a FLAC byte stream. The header comes first (without
 * sample count, MD5 or seek table, which are unknown until the end), then
 * frames as the consumer reads. Memory stays bounded for any input length.
 *
 * @param input WAV bytes or a stream of them; raw PCM with `options.pcm`.
 * @param options Encoder options. `seekPointInterval` is validated but has no
 * effect: a stream has no seek table.
 * @returns The FLAC stream. It never throws: every failure, including
 * invalid options, bad input and aborts, errors the stream instead.
 * @example
 * ```ts
 * const flac = encodeStream(response.body!);
 * await flac.pipeTo(fileWritable);
 * ```
 */
export function encodeStream(input: Input | PcmInput, options?: Options): ReadableStream<Bytes> {
  // Every failure errors the returned stream, so consumers handle one path.
  let prepared: ReturnType<typeof preparePcm>;
  try {
    prepared = preparePcm(input, normalizeOptions(options, true));
  } catch (e) {
    releaseUnread(input, e);
    return new ReadableStream<Bytes>({ start: (c) => c.error(e) });
  }
  const { input: bytes, args } = prepared;
  const hooks = { signal: options?.signal, onProgress: options?.onProgress };
  if (isReady()) return runStream(bytes, args, hooks);
  const { readable, writable } = new TransformStream<Bytes, Bytes>();
  // Stops waiting for the load on the caller's abort or the consumer's cancel.
  // Always a signal: waiting without one would pin a stalled load, and with it
  // the input, even after the consumer gave up.
  const stop = new AbortController();
  const signal = options?.signal;
  const onAbort = (): void => stop.abort(signal?.reason);
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  // Cancelling the readable errors the writable with the cancel reason.
  const writer = writable.getWriter();
  let loading = true;
  writer.closed.catch((reason: unknown) => {
    if (loading) stop.abort(reason);
  });
  init(undefined, { signal: stop.signal })
    .then(
      () => {
        loading = false;
        signal?.removeEventListener('abort', onAbort);
        writer.releaseLock();
        return runStream(bytes, args, hooks).pipeTo(writable);
      },
      (e: unknown) => {
        loading = false;
        signal?.removeEventListener('abort', onAbort);
        // The input is never read, so release it like a failed encode would.
        releaseUnread(bytes, e);
        return writer.abort(e);
      },
    )
    .catch(ignore);
  return readable;
}

/**
 * Synchronous {@link encode} for in-memory input. Blocks the thread; prefer
 * {@link encode} or a worker for large files on a UI thread.
 *
 * @param input WAV bytes; raw PCM samples or bytes with `options.pcm`.
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
export function encodeSync(input: Uint8Array | ArrayBuffer | PcmBuffer, options?: Options): Bytes {
  const p = preparePcm(input, normalizeOptions(options, false));
  if (!isReady()) throw notReady();
  return runSync(toBytes(p.input, 'input', BUFFER_INPUT), p.args, {
    signal: options?.signal,
    onProgress: options?.onProgress,
  });
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
  const bytes = toBytes(input, 'input', BUFFER_INPUT);
  await init();
  return probeBytes(bytes);
}

/**
 * The encoder's version string, e.g. `wav2flac 1.0.0 (libflac-rs 0.143.1)`.
 * @returns The version string.
 * @throws {Error} If the wasm is not initialized.
 */
export function version(): string {
  if (!isReady()) throw notReady();
  return vendor();
}

/**
 * The license notices of the third-party code in the wasm, as Markdown: a
 * table of the Rust crates, then each crate's license files word for word.
 * Reads the notices from the `license` section of the wasm that is already
 * loaded. It never loads the wasm or waits for a load, so it cannot hang on a
 * stalled download: before {@link init} or {@link initSync} has finished, it
 * rejects.
 *
 * @example
 * ```ts
 * await init();
 * console.log(await thirdPartyLicenses());
 * ```
 * @returns The same text as `wav2flac/THIRD_PARTY_LICENSES.txt`.
 * @throws {Error} If the wasm is not initialized, or was loaded from a copy
 * without its `license` section.
 */
export async function thirdPartyLicenses(): Promise<string> {
  if (!isReady()) throw notReady();
  const [section] = WebAssembly.Module.customSections(wasmModule(), 'license');
  if (section === undefined) {
    throw new Error(
      'wav2flac: the wasm has no "license" section; see wav2flac/THIRD_PARTY_LICENSES.txt',
    );
  }
  return new TextDecoder().decode(section);
}
