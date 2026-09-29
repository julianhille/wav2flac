// SPDX-License-Identifier: 0BSD
/**
 * Loading and instantiating the WebAssembly module.
 * @module
 */
import initGlue, { initSync as initGlueSync } from '../../build/bindgen/wav2flac.js';
import { isSignal } from './options.js';
import { builtin, ignore, isNode } from './platform.js';

/**
 * Where to load the wasm from: its bytes, a compiled module, a URL (string or
 * `URL`), or a `fetch` `Response` (or a promise of one). In Node a string that
 * is not an absolute URL is a file path.
 */
export type WasmSource = BufferSource | WebAssembly.Module | URL | string | Response | PromiseLike<Response>;

/** Options for {@link init}. */
export interface InitOptions {
  /**
   * Stops waiting for the load; `init()` then rejects with the signal's
   * reason. Use `AbortSignal.timeout(ms)` for a timeout.
   */
  signal?: AbortSignal | undefined;
}

/** One attempt at loading the module, shared by every init() waiting on it. */
interface Load {
  promise: Promise<void>;
  /** Cancels the fetch or file read once nobody waits any more. */
  stop: AbortController;
  /** Callers with a signal that still wait. */
  waiters: number;
  /** A caller without a signal waits, so the load is never abandoned. */
  pinned: boolean;
}

let compiled: WebAssembly.Module | undefined;
let memory: WebAssembly.Memory | undefined;
let pending: Load | undefined;
/**
 * The last source that started a load and can be read again, for the loads
 * that retry after it failed or was abandoned. Cleared once the module is
 * ready.
 */
let configured: WasmSource | undefined;
/** Whether init() is inside the glue's async instantiation. */
let instantiating = false;

/**
 * URL of the `.wasm` shipped next to this bundle (`pkg/wav2flac.wasm`).
 * @returns The URL.
 * @internal
 */
export function defaultWasmUrl(): URL {
  return new URL('../wav2flac.wasm', import.meta.url);
}

/**
 * Reads a `file:` URL with Node's `fs`.
 * @param url File URL.
 * @returns The file contents.
 */
async function readFileUrl(url: URL, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const fs = builtin<typeof import('node:fs')>('fs');
  return fs.promises.readFile(url, { signal });
}

/**
 * Resolves a URL string: relative to the page in browsers, and in Node a
 * string that has no URL scheme (`file:`, `https:`, ...) is a file path.
 * @param source The URL or path.
 * @returns The URL.
 * @throws {TypeError} For strings that are neither.
 */
function toUrl(source: string | URL): URL {
  if (source instanceof URL) return source;
  if (typeof location === 'object' && location !== null) return new URL(source, location.href);
  // A Windows drive path ("C:\\x.wasm") parses as a URL with scheme "c"; only
  // schemes of two or more characters count as URLs in Node.
  if (isNode() && !/^[a-z][a-z0-9+.-]+:/i.test(source)) {
    return builtin<typeof import('node:url')>('url').pathToFileURL(source);
  }
  if (URL.canParse(source)) return new URL(source);
  throw new TypeError(`wav2flac: cannot resolve wasm URL "${source}" (no page to resolve it against)`);
}

/**
 * Compiles a module from any {@link WasmSource}.
 * @param source The source.
 * @param signal Cancels a fetch or file read started here.
 * @returns The compiled module.
 */
async function compile(source: WasmSource, signal: AbortSignal): Promise<WebAssembly.Module> {
  if (source instanceof WebAssembly.Module) return source;
  if (ArrayBuffer.isView(source) || source instanceof ArrayBuffer) return WebAssembly.compile(source as BufferSource);
  if (typeof SharedArrayBuffer === 'function' && (source as unknown) instanceof SharedArrayBuffer) {
    return WebAssembly.compile(new Uint8Array(source as unknown as SharedArrayBuffer).slice());
  }
  let res: Response | PromiseLike<Response>;
  if (typeof source === 'string' || source instanceof URL) {
    const url = toUrl(source);
    if (url.protocol === 'file:' && isNode()) return WebAssembly.compile(await readFileUrl(url, signal));
    res = fetch(url, { signal });
  } else if (typeof source === 'object' && source !== null && ('ok' in source || 'then' in source)) {
    res = source as Response | PromiseLike<Response>;
  } else {
    throw new TypeError('wav2flac: init() needs wasm bytes, a WebAssembly.Module, a URL, a path or a Response');
  }
  const r = await res;
  if (!r.ok) throw new Error(`wav2flac: failed to fetch wasm (${r.status} ${r.statusText})`);
  if (typeof WebAssembly.compileStreaming === 'function' && r.headers.get('content-type')?.startsWith('application/wasm') === true) {
    return WebAssembly.compileStreaming(r);
  }
  return WebAssembly.compile(await r.arrayBuffer());
}

/**
 * Starts loading and instantiating the module.
 * @param source Where to load the wasm from.
 * @returns The load.
 */
function startLoad(source: WasmSource): Load {
  const load: Load = { promise: undefined as never, stop: new AbortController(), waiters: 0, pinned: false };
  load.promise = (async () => {
    const mod = await compile(source, load.stop.signal);
    // initSync() may have finished while this was compiling; its instance wins.
    if (compiled !== undefined) return;
    // Abandoned while compiling a source that cannot be cancelled.
    if (pending !== load) throw load.stop.signal.reason;
    // The glue keeps one instance; initSync() must not start another meanwhile.
    instantiating = true;
    try {
      const out = await initGlue({ module_or_path: mod });
      compiled = mod;
      memory = out.memory;
      // Nothing retries any more; don't keep the bytes alive.
      configured = undefined;
    } finally {
      instantiating = false;
    }
  })().catch((e: unknown) => {
    if (pending === load) pending = undefined;
    // A failed load does not matter once initSync() succeeded meanwhile.
    if (compiled === undefined) throw e;
  });
  return load;
}

/**
 * Waits for `load` until `signal` aborts. When the last waiter gives up, the
 * load is abandoned so that the next init() starts a new one.
 * @param load The load.
 * @param signal The caller's signal.
 * @returns Settles with the load, or rejects with the signal's reason.
 */
function waitFor(load: Load, signal: AbortSignal): Promise<void> {
  load.waiters++;
  return new Promise<void>((resolve, reject) => {
    let waiting = true;
    // Runs once: on abort, or when the load settles, whichever comes first.
    const done = (): void => {
      if (!waiting) return;
      waiting = false;
      signal.removeEventListener('abort', onAbort);
      load.waiters--;
    };
    const onAbort = (): void => {
      done();
      reject(signal.reason);
      // Instantiating does not wait on I/O, so let it finish.
      if (load.waiters === 0 && !load.pinned && pending === load && !instantiating) {
        pending = undefined;
        load.stop.abort(signal.reason);
        // Nobody waits for the abandoned load's outcome any more.
        load.promise.catch(ignore);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    load.promise.then(
      () => { done(); resolve(); },
      (e: unknown) => { done(); reject(e); },
    );
  });
}

/**
 * Loads and instantiates the wasm module. Safe to call repeatedly and
 * concurrently; later calls share the load in progress and ignore their
 * `source`: one module is loaded per realm (page, worker or Node process), so
 * pass a custom location on the first call, before anything encodes.
 * `encode`, `encodeStream`, `probe` and workers call it automatically.
 *
 * A load that never finishes (a stalled download, say) keeps `init()`
 * pending. Pass a `signal` to give up: `init()` then rejects with its reason,
 * and once every caller waiting on the load has given up, the download is
 * cancelled and the next `init()` starts over. A caller without a signal,
 * such as `probe()`, keeps waiting, so the load goes on. A failed load is
 * retried by the next call, too.
 *
 * A retry loads from the `source` of that call. Without one, it loads from
 * the last URL, path, bytes or module that a load started with, so the
 * `init()` inside `encode()` retries your custom location. A `Response` can
 * be read only once; after it failed, pass a new one.
 *
 * @param source Where to load the wasm from. Default: `wav2flac.wasm` next to
 *   the package's JS (read with `fs` in Node, `fetch`ed elsewhere).
 * @param options A signal to stop waiting.
 * @returns Resolves once the module is ready.
 * @throws {TypeError} If `options.signal` is not an `AbortSignal`.
 * @example
 * ```ts
 * import { init, encodeSync } from 'wav2flac';
 * await init();                       // or init(new URL('/assets/wav2flac.wasm', location.href))
 * const flac = encodeSync(wavBytes);
 * ```
 * @example Give up after 10 seconds:
 * ```ts
 * await init(undefined, { signal: AbortSignal.timeout(10_000) });
 * ```
 */
export function init(source?: WasmSource, options?: InitOptions): Promise<void> {
  const signal = options?.signal;
  if (signal !== undefined && !isSignal(signal)) {
    return Promise.reject(new TypeError('wav2flac: init() option signal must be an AbortSignal'));
  }
  if (compiled !== undefined) return Promise.resolve();
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  if (pending === undefined) {
    if (source !== undefined && isReusable(source)) configured = source;
    pending = startLoad(source ?? configured ?? defaultWasmUrl());
  }
  const load = pending;
  if (signal === undefined) {
    load.pinned = true;
    return load.promise;
  }
  return waitFor(load, signal);
}

/**
 * Whether a source can be loaded again: a URL, a path, bytes or a module, not
 * a `Response`, which can be read only once.
 * @param source The source.
 * @returns `true` if a retry can use it.
 */
function isReusable(source: WasmSource): boolean {
  return typeof source === 'string' || source instanceof URL || source instanceof WebAssembly.Module ||
    ArrayBuffer.isView(source) || source instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer === 'function' && (source as unknown) instanceof SharedArrayBuffer);
}

/**
 * Synchronous {@link init}, for CommonJS scripts and workers. Without an
 * argument it reads the bundled `.wasm` synchronously (Node only).
 *
 * @param source The wasm bytes or a compiled module.
 * @throws {Error} Without `source` outside Node, or while {@link init} is
 *   instantiating the module (await that instead).
 * @example
 * ```ts
 * const { initSync, encodeSync } = require('wav2flac');
 * initSync();
 * ```
 */
export function initSync(source?: BufferSource | WebAssembly.Module): void {
  if (compiled !== undefined) return;
  if (instantiating) {
    throw new Error('wav2flac: init() is instantiating the module; await it instead of calling initSync()');
  }
  const bytes = source ?? builtin<typeof import('node:fs')>('fs').readFileSync(defaultWasmUrl());
  const mod = bytes instanceof WebAssembly.Module ? bytes : new WebAssembly.Module(bytes as BufferSource);
  const out = initGlueSync({ module: mod });
  compiled = mod;
  memory = out.memory;
  configured = undefined;
}

/**
 * Whether the module has been instantiated.
 * @returns `true` once {@link init} or {@link initSync} completed.
 * @internal
 */
export function isReady(): boolean {
  return compiled !== undefined;
}

/**
 * The compiled module, for sending to workers.
 * @returns The module.
 * @throws {Error} If not initialized.
 * @internal
 */
export function wasmModule(): WebAssembly.Module {
  if (compiled === undefined) throw notReady();
  return compiled;
}

/**
 * Current size of this realm's wasm linear memory in bytes (it only grows).
 * Useful for benchmarks and leak checks; `0` before {@link init}.
 * @returns Bytes of wasm memory.
 */
export function wasmMemoryBytes(): number {
  return memory?.buffer.byteLength ?? 0;
}

/**
 * The error thrown by synchronous APIs used before initialization.
 * @returns The error.
 * @internal
 */
export function notReady(): Error {
  return new Error('wav2flac: not initialized; call `await init()` or `initSync()` first');
}
