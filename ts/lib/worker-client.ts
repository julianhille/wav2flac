// SPDX-License-Identifier: 0BSD
/**
 * Off-main-thread encoding: a client for a dedicated worker running the same
 * engine. Works with browser `Worker`s and Node `worker_threads`.
 * @module
 */
import type { Bytes } from './engine.js';
import { abortError, reviveError, Wav2FlacError } from './errors.js';
import { BUFFER_INPUT, isStream, preparePcm, toBytes, type Input, type PcmInput } from './input.js';
import { normalizeOptions, type Options, type Progress } from './options.js';
import { builtin, ignore, isNode } from './platform.js';
import type { WavInfo } from './probe.js';
import {
  OUTPUT_WINDOW,
  transferOf,
  type FromWorker,
  type Port,
  type ToWorker,
} from './protocol.js';
import { init, wasmModule, type WasmSource } from './wasm.js';

/** The worker script next to this file, for Node (see `spawn`). */
const NODE_WORKER = './worker.js';

/** Size of the first header prefix sent to the worker by `probe`. */
const PROBE_FIRST_TRY = 64 * 1024;

/** An encoder running in a dedicated worker. */
export interface WorkerEncoder {
  /**
   * Like `encode()`, but in the worker. In-memory input (`ArrayBuffer`, or a
   * typed array covering its whole buffer) is transferred, i.e. detached, once
   * the worker is ready, and so are such stream chunks; set `copy: true` to
   * keep them. Views of a larger buffer are copied. A transferred input is
   * gone even when the job fails, so keep a copy if you plan to retry.
   */
  encode(input: Input | PcmInput, options?: Options): Promise<Bytes>;
  /** Like `encodeStream()`, but in the worker; with backpressure both ways. */
  encodeStream(
    input: Input | PcmInput,
    options?: Omit<Options, 'seekPointInterval'>,
  ): ReadableStream<Bytes>;
  /** Like `probe()`, but in the worker. The header bytes are copied. */
  probe(input: Uint8Array | ArrayBuffer): Promise<WavInfo>;
  /**
   * Size of the worker's wasm linear memory in bytes. Rejects once the worker
   * has crashed or was terminated, or when its wasm failed to start, so it
   * also tells whether the worker can still encode.
   */
  wasmMemoryBytes(): Promise<number>;
  /** Stops the worker; pending jobs reject with an `AbortError`. */
  terminate(): void;
}

/** Options for {@link createWorkerEncoder}. */
export interface WorkerEncoderOptions {
  /**
   * Worker script URL. Default: the package's worker from the same build,
   * `worker.min.js` for the minified bundles. In Node a string is a file path
   * unless it starts with `file:`.
   */
  url?: URL | string | undefined;
  /** Where the main thread loads the wasm from (see `init`). It is compiled once and shared. */
  wasm?: WasmSource | undefined;
}

/** Client-side state of one job. */
interface ClientJob {
  handle(m: FromWorker): void;
  fail(e: unknown): void;
}

/**
 * The error for a message from the worker that could not be deserialized.
 * @param detail What the platform says, if anything.
 * @returns The error.
 */
function lostMessage(detail?: string): Error {
  const msg = 'wav2flac worker: a message from the worker could not be deserialized';
  return new Error(detail === undefined ? msg : `${msg}: ${detail}`);
}

/**
 * Wraps a browser `Worker` as a {@link Port}.
 * @param w The worker.
 * @returns The port.
 */
function browserPort(w: Worker): Port<FromWorker, ToWorker> {
  return {
    post: (msg, transfer) => w.postMessage(msg, transfer),
    listen(onMessage, onError) {
      w.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data);
      w.onerror = (e) => {
        e.preventDefault();
        onError(
          new Error(
            `wav2flac worker failed: ${e.message || 'the worker script could not be loaded'}`,
          ),
        );
      };
      w.onmessageerror = () => onError(lostMessage());
    },
    ref: ignore,
    close: () => w.terminate(),
  };
}

type NodeWorker = import('node:worker_threads').Worker;

/**
 * Wraps a Node `worker_threads.Worker` as a {@link Port}.
 * @param w The worker.
 * @returns The port.
 * @internal
 */
export function nodePort(w: NodeWorker): Port<FromWorker, ToWorker> {
  let closed = false;
  return {
    post: (msg, transfer) => w.postMessage(msg, transfer as never),
    listen(onMessage, onError) {
      w.on('message', onMessage);
      w.on('messageerror', (e: Error) => onError(lostMessage(e.message)));
      w.on('error', onError);
      w.on('exit', (code) => {
        if (!closed) onError(new Error(`wav2flac worker exited with code ${code}`));
      });
    },
    ref: (keep) => (keep ? w.ref() : w.unref()),
    close: () => {
      closed = true;
      void w.terminate();
    },
  };
}

/**
 * Starts the default worker script.
 * @param url Override of the worker script URL.
 * @returns The port to the new worker.
 */
function spawn(url: URL | string | undefined): Port<FromWorker, ToWorker> {
  // Undefined in the CommonJS build bundled without __filename, document.currentScript
  // or location (see build-js.ts).
  if (url === undefined && typeof import.meta.url !== 'string') {
    throw new Error(
      "wav2flac: can't tell where this bundle was loaded from, so can't find its " +
        'worker script; pass its URL to createWorkerEncoder({ url })',
    );
  }
  if (isNode()) {
    const { Worker } = builtin<typeof import('node:worker_threads')>('worker_threads');
    // Node treats a string as a file path; accept `file:` URL strings as in browsers.
    const u = typeof url === 'string' && url.startsWith('file:') ? new URL(url) : url;
    // Not a literal `new URL('./worker.js', …)`: bundlers would emit a second,
    // unused copy of the worker for this Node-only branch.
    return nodePort(new Worker(u ?? new URL(NODE_WORKER, import.meta.url)));
  }
  // Kept literal so bundlers (Vite, webpack) detect and emit the worker.
  const w =
    url === undefined
      ? new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
      : new Worker(url, { type: 'module' });
  return browserPort(w);
}

/**
 * Creates an encoder that runs in a dedicated worker, keeping the calling
 * thread free. The wasm is compiled once on the calling side and shared. In
 * Node the worker does not keep the process alive while idle. It never
 * throws: if the worker cannot start, every call fails with the reason.
 *
 * @param options Worker script and wasm location.
 * @returns The worker encoder. Call `terminate()` when done.
 * @example
 * ```ts
 * const worker = createWorkerEncoder();
 * const flac = await worker.encode(wavBytes, { compressionLevel: 8 });
 * worker.terminate();
 * ```
 */
export function createWorkerEncoder(options: WorkerEncoderOptions = {}): WorkerEncoder {
  let port: Port<FromWorker, ToWorker>;
  try {
    port = spawn(options.url);
  } catch (e) {
    // Like a worker that crashed: every call fails, none throws.
    port = deadPort(e instanceof Error ? e : new Error(String(e)));
  }
  return connect(port, options.wasm);
}

/**
 * A port to a worker that could not start: it reports `error` at once.
 * @param error Why the worker did not start.
 * @returns The port.
 */
function deadPort(error: Error): Port<FromWorker, ToWorker> {
  return {
    post: ignore,
    listen: (_, onError) => onError(error),
    ref: ignore,
    close: ignore,
  };
}

/**
 * Builds a {@link WorkerEncoder} on any port (exposed for tests).
 * @param port Port to a worker running `serve()`.
 * @param wasm Where to load the wasm from.
 * @returns The worker encoder.
 * @internal
 */
export function connect(port: Port<FromWorker, ToWorker>, wasm?: WasmSource): WorkerEncoder {
  const jobs = new Map<number, ClientJob>();
  let nextId = 1;
  let dead: Error | undefined;
  port.ref(false);

  const post = (msg: ToWorker, data?: Uint8Array): void => {
    if (dead === undefined) port.post(msg, data === undefined ? [] : transferOf(data));
  };

  const ready = init(wasm).then(() => {
    post({ t: 'init', module: wasmModule() });
  });
  // Avoid an unhandled rejection before the first call awaits it.
  ready.catch(ignore);

  const add = (id: number, job: ClientJob): void => {
    if (dead !== undefined) {
      job.fail(dead);
      return;
    }
    if (jobs.size === 0) port.ref(true);
    jobs.set(id, job);
  };
  const remove = (id: number): void => {
    if (jobs.delete(id) && jobs.size === 0) port.ref(false);
  };

  const failAll = (e: Error): void => {
    dead ??= e;
    // A copy: job.fail() runs the caller's code, which can add or end jobs.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const [id, job] of [...jobs]) {
      remove(id);
      job.fail(e);
    }
  };

  const die = (e: Error): void => {
    failAll(e);
    port.close();
  };
  port.listen((m) => {
    if (m.t === 'fatal') die(reviveError(m.error));
    else jobs.get(m.id)?.handle(m);
  }, die);

  /**
   * Prepares bytes for sending: transfers when allowed, copies otherwise.
   * Copies with `new Uint8Array()`, not `slice()`: on a Node `Buffer`,
   * `slice()` returns a view of the same memory.
   * @param bytes The bytes.
   * @param copy Whether the caller asked to keep the buffer.
   * @returns Bytes safe to transfer or copy.
   */
  const outgoing = (bytes: Uint8Array, copy: boolean): Uint8Array =>
    copy || transferOf(bytes).length === 0 ? new Uint8Array(bytes) : bytes;

  /**
   * Creates a job that feeds `input` to the worker and routes its messages.
   * @param input The input.
   * @param opts Options.
   * @param streaming Output mode.
   * @param onOut Output chunk handler (stream mode).
   * @param onDone Completion handler.
   * @param onFail Failure handler.
   * @returns A function that cancels the job.
   */
  const start = (
    rawInput: Input | PcmInput,
    opts: Options | undefined,
    streaming: boolean,
    onOut: (data: Bytes) => void,
    onDone: (data: Bytes | null) => void,
    onFail: (e: unknown) => void,
  ): ((reason?: unknown) => void) => {
    let prepared: ReturnType<typeof preparePcm>;
    try {
      // A dead encoder wins over bad options, and still releases the input.
      if (dead !== undefined) throw dead;
      // Check the signal before locking the input stream.
      opts?.signal?.throwIfAborted();
      prepared = preparePcm(rawInput, normalizeOptions(opts, streaming));
    } catch (e) {
      // Like the main thread: a failed encode cancels a stream input.
      if (isStream(rawInput) && !rawInput.locked) void rawInput.cancel(e).catch(ignore);
      throw e;
    }
    const { input, args } = prepared;
    const signal = opts?.signal;
    const onProgress = opts?.onProgress;
    const copy = opts?.copy ?? false;
    const id = nextId++;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let finished = false;

    const end = (reason?: unknown): void => {
      if (finished) return;
      finished = true;
      remove(id);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      if (reader !== undefined) {
        void reader.cancel(reason).catch(ignore);
        reader.releaseLock();
      }
    };
    const fail = (e: unknown): void => {
      if (finished) return;
      end(e);
      onFail(e);
    };
    const cancel = (reason?: unknown): void => {
      if (finished) return;
      end(reason);
      post({ t: 'abort', id });
    };
    /** Aborts the worker's job and reports `e`, unless the job already ended. */
    const abortWith = (e: unknown): void => {
      if (finished) return;
      cancel(e);
      onFail(e);
    };
    const onAbort = signal === undefined ? undefined : (): void => abortWith(signal.reason);

    let bytes: Uint8Array | null = null;
    if (isStream(input)) reader = input.getReader();
    else bytes = outgoing(toBytes(input), copy);
    signal?.addEventListener('abort', onAbort!, { once: true });

    const pump = async (): Promise<void> => {
      try {
        const r = await reader!.read();
        if (finished) return;
        if (r.done) post({ t: 'end', id });
        else {
          const data = outgoing(toBytes(r.value, 'stream chunk'), copy);
          post({ t: 'chunk', id, data }, data);
        }
      } catch (e) {
        abortWith(e);
      }
    };

    add(id, {
      handle(m) {
        switch (m.t) {
          case 'progress':
            try {
              onProgress?.(m.p);
            } catch (e) {
              abortWith(e);
            }
            return;
          case 'need':
            void pump();
            return;
          case 'out':
            onOut(m.data);
            return;
          case 'done':
            end();
            onDone(m.data);
            return;
          case 'error':
            fail(reviveError(m.error));
            return;
          default:
            return;
        }
      },
      fail,
    });

    void ready
      .then(() => {
        if (finished) return;
        if (dead !== undefined) throw dead;
        // Another job may have transferred the same buffer meanwhile.
        if (bytes !== null) toBytes(bytes);
        post(
          {
            t: 'job',
            id,
            args,
            input: bytes,
            progress: onProgress !== undefined,
            window: OUTPUT_WINDOW,
          },
          bytes ?? undefined,
        );
      })
      .catch(fail);
    return cancel;
  };

  /**
   * Sends a request expecting a single reply.
   * @param msg Builds the request for an id.
   * @param pick Extracts the result from the reply.
   * @returns The result.
   */
  const request = <T>(
    msg: (id: number) => ToWorker,
    pick: (m: FromWorker) => T | undefined,
  ): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      // Registered before the wasm is ready, so that terminate() and a crash
      // reject it while the wasm is still loading.
      add(id, {
        handle(m) {
          remove(id);
          if (m.t === 'error') reject(reviveError(m.error));
          else resolve(pick(m) as T);
        },
        fail: reject,
      });
      // A load that failed, or a message that cannot be posted, fails it.
      ready
        .then(() => {
          if (jobs.has(id)) post(msg(id));
        })
        .catch((e: unknown) => {
          if (!jobs.has(id)) return;
          remove(id);
          reject(e);
        });
    });
  };

  return {
    encode(input, opts) {
      return new Promise<Bytes>((resolve, reject) => {
        start(input, opts, false, ignore, (d) => resolve(d!), reject);
      });
    },

    encodeStream(input, opts) {
      const queue: Bytes[] = [];
      let wake: (() => void) | undefined;
      let state: 'open' | 'done' | 'failed' = 'open';
      let error: unknown;
      let cancel: ((reason?: unknown) => void) | undefined;
      const poke = (): void => {
        const w = wake;
        wake = undefined;
        w?.();
      };
      let id = 0;
      return new ReadableStream<Bytes>(
        {
          start(c) {
            // Like encodeStream() on the main thread: failures error the stream.
            try {
              id = nextId;
              cancel = start(
                input,
                opts,
                true,
                (d) => {
                  queue.push(d);
                  poke();
                },
                () => {
                  state = 'done';
                  poke();
                },
                // Output not yet read is dropped: an abort or error wins.
                (e) => {
                  state = 'failed';
                  error = e;
                  queue.length = 0;
                  poke();
                },
              );
            } catch (e) {
              c.error(e);
            }
          },
          async pull(c) {
            while (queue.length === 0 && state === 'open')
              await new Promise<void>((r) => {
                wake = r;
              });
            const d = queue.shift();
            if (d !== undefined) {
              c.enqueue(d);
              if (state === 'open') post({ t: 'ack', id });
              return;
            }
            if (state === 'failed') throw error;
            c.close();
          },
          cancel(reason) {
            // Like the main thread: the input stream gets the consumer's reason.
            cancel?.(reason);
            // Settle a pull() still waiting for output.
            state = 'done';
            poke();
          },
        },
        { highWaterMark: 0 },
      );
    },

    async probe(input) {
      const bytes = toBytes(input, 'input', BUFFER_INPUT);
      // Only the header is read, so copy growing prefixes, not the whole file.
      for (let n = Math.min(PROBE_FIRST_TRY, bytes.length); ; n = Math.min(n * 4, bytes.length)) {
        // A copy, not a Buffer view that would clone the whole backing buffer.
        const data = new Uint8Array(bytes.subarray(0, n));
        try {
          return await request(
            (id) => ({ t: 'probe', id, data }),
            (m) => (m.t === 'probe' ? m.info : undefined),
          );
        } catch (e) {
          if (!(e instanceof Wav2FlacError && e.code === 'TRUNCATED' && n < bytes.length)) throw e;
        }
      }
    },

    async wasmMemoryBytes() {
      return request(
        (id) => ({ t: 'stats', id }),
        (m) => (m.t === 'stats' ? m.wasmBytes : undefined),
      );
    },

    terminate() {
      failAll(abortError('The worker was terminated.'));
      port.close();
    },
  };
}

export type { Progress };
