// SPDX-License-Identifier: 0BSD
/**
 * Input normalization: byte views, fixed-size slicing and stream reading.
 * @module
 * @internal
 */
import { ignore } from './platform.js';

/** Anything the encoder accepts as WAV input. */
export type Input = Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

/** Largest piece handed to wasm at once by `encodeSync` (bounds wasm memory growth). */
export const SLICE_BYTES = 1 << 20;

/**
 * Largest piece handed to wasm at once by the async paths: small enough that
 * one push takes a few ms, so yielding keeps the thread responsive.
 */
export const ASYNC_SLICE_BYTES = 1 << 16;

/**
 * Checks for a `ReadableStream` (also across realms).
 * @param x Candidate.
 * @returns `true` for readable streams.
 */
export function isStream(x: unknown): x is ReadableStream<Uint8Array> {
  return typeof x === 'object' && x !== null && typeof (x as ReadableStream).getReader === 'function';
}

/**
 * Views a byte input as a `Uint8Array` without copying.
 * @param input `Uint8Array` or `ArrayBuffer`.
 * @param what Name used in the error message.
 * @returns A view of the bytes.
 * @throws {TypeError} For any other type.
 */
export function toBytes(input: unknown, what = 'input'): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input) && !(input instanceof DataView) && (input as Uint8Array).BYTES_PER_ELEMENT === 1) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof SharedArrayBuffer === 'function' && input instanceof SharedArrayBuffer) return new Uint8Array(input);
  throw new TypeError(`wav2flac: ${what} must be a Uint8Array, ArrayBuffer or ReadableStream<Uint8Array>`);
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
