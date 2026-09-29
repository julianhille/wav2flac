// SPDX-License-Identifier: 0BSD
/**
 * The encoding loop shared by every entry point (main thread and worker):
 * slices input into wasm, collects output, reports progress and honours
 * abort signals. wasm memory is always released in `finally`.
 * @module
 * @internal
 */
import { fromWasmError } from './errors.js';
import { chunks, isStream, slices, type Input } from './input.js';
import type { EncoderArgs, Progress } from './options.js';
import { ignore, Pacer } from './platform.js';
import { WasmEncoder } from '../../build/bindgen/wav2flac.js';

/** Minimum time between two progress callbacks, in milliseconds. */
export const PROGRESS_INTERVAL_MS = 50;

/**
 * FLAC output bytes. Always backed by a plain `ArrayBuffer`, so they can go
 * straight into `new Blob([…])`, `new Response(…)` or `postMessage` transfers.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Per-run hooks. */
export interface RunHooks {
  signal?: AbortSignal | undefined;
  onProgress?: ((p: Progress) => void) | undefined;
}

/**
 * Throttles progress callbacks to at most one per {@link PROGRESS_INTERVAL_MS}.
 */
export class Reporter {
  #cb: ((p: Progress) => void) | undefined;
  #last = -Infinity;

  /**
   * @param cb The user's callback, if any.
   */
  constructor(cb: ((p: Progress) => void) | undefined) {
    this.#cb = cb;
  }

  /**
   * Reports the session's progress if due (or always when `force`).
   * @param s The session.
   * @param force Report even if throttled (used for the final report).
   */
  update(s: Session, force = false): void {
    if (this.#cb === undefined) return;
    const now = performance.now();
    if (!force && now - this.#last < PROGRESS_INTERVAL_MS) return;
    this.#last = now;
    this.#cb(s.progress());
  }
}

/** Sessions created but not yet freed. */
let live = 0;

/**
 * Number of wasm encoders not yet freed. Leak tests check that it returns to
 * zero; wasm memory itself never shrinks, so it cannot show a leak.
 * @returns The count.
 */
export function liveSessions(): number {
  return live;
}

/**
 * One wasm encoder instance with error conversion and deterministic freeing.
 */
export class Session {
  #enc: WasmEncoder | undefined;

  /**
   * @param a Normalized constructor arguments.
   * @throws {Wav2FlacError} `INVALID_OPTIONS` for out-of-range options.
   */
  constructor(a: EncoderArgs) {
    try {
      this.#enc = new WasmEncoder(
        a.level, a.blockSize, a.sampleRate, a.quality, a.bits, a.dither, a.seed, a.tagsEnabled,
        a.tagKeys, a.tagValues, a.seekPointInterval, a.padding, a.maxInputBytes, a.streaming,
        Math.max(a.pcmFormat, 0), a.pcmChannels, a.pcmRate, a.pcmTotalBytes,
      );
    } catch (e) {
      throw fromWasmError(e);
    }
    live++;
  }

  /**
   * The live encoder.
   * @returns The encoder.
   * @throws {Error} After {@link Session.free}.
   */
  #live(): WasmEncoder {
    if (this.#enc === undefined) throw new Error('wav2flac: encoder already freed');
    return this.#enc;
  }

  /**
   * Feeds WAV bytes.
   * @param bytes Input slice.
   * @returns FLAC bytes produced (possibly empty).
   */
  push(bytes: Uint8Array): Bytes {
    try {
      return this.#live().push(bytes) as Bytes;
    } catch (e) {
      throw fromWasmError(e);
    }
  }

  /**
   * Ends the input.
   * @returns The remaining frames and, in buffered mode, the final header.
   */
  finish(): { tail: Bytes; header: Bytes } {
    try {
      const enc = this.#live();
      const tail = enc.finish() as Bytes;
      return { tail, header: enc.takeHeader() as Bytes };
    } catch (e) {
      throw fromWasmError(e);
    }
  }

  /**
   * Current progress.
   * @returns The progress snapshot.
   */
  progress(): Progress {
    const enc = this.#live();
    const f = enc.fraction();
    return { bytesIn: enc.bytesIn(), samplesOut: enc.samplesOut(), fraction: Number.isNaN(f) ? null : f };
  }

  /** Releases the wasm memory; idempotent. */
  free(): void {
    if (this.#enc === undefined) return;
    this.#enc.free();
    this.#enc = undefined;
    live--;
  }
}

/**
 * Concatenates `header`, `parts` and `tail` into one exact-size buffer.
 * @param header Leading bytes.
 * @param parts Middle pieces.
 * @param tail Trailing bytes.
 * @returns The joined bytes.
 */
export function assemble(header: Uint8Array, parts: readonly Uint8Array[], tail: Uint8Array): Bytes {
  let n = header.length + tail.length;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  out.set(header, 0);
  let o = header.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  out.set(tail, o);
  return out;
}

/**
 * Buffered encode of in-memory bytes, fully synchronous.
 * @param bytes The WAV bytes.
 * @param args Normalized arguments (`streaming` must be `false`).
 * @param hooks Progress and abort hooks.
 * @returns The complete FLAC file.
 */
export function runSync(bytes: Uint8Array, args: EncoderArgs, hooks: RunHooks): Bytes {
  hooks.signal?.throwIfAborted();
  const s = new Session(args);
  const rep = new Reporter(hooks.onProgress);
  try {
    const parts: Uint8Array[] = [];
    for (const piece of slices(bytes)) {
      const out = s.push(piece);
      if (out.length > 0) parts.push(out);
      rep.update(s);
    }
    const { tail, header } = s.finish();
    rep.update(s, true);
    return assemble(header, parts, tail);
  } finally {
    s.free();
  }
}

/**
 * Buffered encode of any input, yielding to the event loop periodically.
 * @param input The WAV input.
 * @param args Normalized arguments (`streaming` must be `false`).
 * @param hooks Progress and abort hooks.
 * @returns The complete FLAC file.
 */
export async function runBuffered(input: Input, args: EncoderArgs, hooks: RunHooks): Promise<Bytes> {
  let s: Session;
  try {
    hooks.signal?.throwIfAborted();
    s = new Session(args);
  } catch (e) {
    // Nothing has read the input yet; release a stream input.
    if (isStream(input) && !input.locked) void input.cancel(e).catch(ignore);
    throw e;
  }
  const rep = new Reporter(hooks.onProgress);
  const pacer = new Pacer();
  try {
    const parts: Uint8Array[] = [];
    for await (const piece of chunks(input, undefined, hooks.signal)) {
      hooks.signal?.throwIfAborted();
      const out = s.push(piece);
      if (out.length > 0) parts.push(out);
      rep.update(s);
      await pacer.maybeYield();
      hooks.signal?.throwIfAborted();
    }
    hooks.signal?.throwIfAborted();
    const { tail, header } = s.finish();
    rep.update(s, true);
    return assemble(header, parts, tail);
  } finally {
    s.free();
  }
}

/**
 * Streaming encode: the header is emitted first, then frames as the consumer
 * pulls. Input is read only as fast as output is consumed (backpressure).
 * Cancelling the stream cancels a stream input and frees the encoder.
 * @param input The WAV input.
 * @param args Normalized arguments (`streaming` must be `true`).
 * @param hooks Progress and abort hooks.
 * @returns The FLAC byte stream.
 */
export function runStream(input: Input, args: EncoderArgs, hooks: RunHooks): ReadableStream<Bytes> {
  let s: Session | undefined;
  let it: AsyncGenerator<Uint8Array> | undefined;
  const rep = new Reporter(hooks.onProgress);
  const pacer = new Pacer();
  const signal = hooks.signal;
  let onAbort: (() => void) | undefined;
  let reading = false;
  // Cancels a stream input even while a read is pending (it.return() would
  // wait for that read).
  const stop = new AbortController();
  const cleanup = (reason?: unknown): void => {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    onAbort = undefined;
    s?.free();
    s = undefined;
    stop.abort(reason);
    // A generator that never ran has not locked the input; cancel it directly.
    if (!reading && isStream(input) && !input.locked) void input.cancel(reason).catch(ignore);
    const i = it;
    it = undefined;
    void i?.return(undefined).catch(ignore);
  };
  return new ReadableStream<Bytes>({
    start(controller) {
      // Every failure errors the stream, including an already-aborted signal
      // and options the core rejects; nothing throws from the constructor.
      if (signal?.aborted === true) {
        cleanup(signal.reason);
        controller.error(signal.reason);
        return;
      }
      try {
        s = new Session(args);
        it = chunks(input, undefined, stop.signal);
      } catch (e) {
        cleanup(e);
        controller.error(e);
        return;
      }
      if (signal !== undefined) {
        onAbort = () => {
          controller.error(signal.reason);
          cleanup(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    },
    async pull(controller) {
      try {
        for (;;) {
          // Yield here, not only after empty pushes: a consumer reading in a
          // loop chains pulls on microtasks, which would never let other
          // tasks run.
          await pacer.maybeYield();
          if (s === undefined || it === undefined) return;
          reading = true;
          const r = await it.next().catch((e: unknown) => {
            if (stop.signal.aborted) return undefined; // cancelled meanwhile
            throw e;
          });
          signal?.throwIfAborted();
          if (s === undefined || r === undefined) return;
          if (r.done === true) {
            const { tail } = s.finish();
            rep.update(s, true);
            if (tail.length > 0) controller.enqueue(tail);
            controller.close();
            cleanup();
            return;
          }
          const out = s.push(r.value);
          rep.update(s);
          if (out.length > 0) {
            controller.enqueue(out);
            return;
          }
        }
      } catch (e) {
        cleanup(e);
        throw e;
      }
    },
    cancel(reason) {
      cleanup(reason);
    },
  }, { highWaterMark: 1 });
}
