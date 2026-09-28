// SPDX-License-Identifier: 0BSD
/**
 * Loading and instantiating the WebAssembly module.
 * @module
 */
import initGlue, { initSync as initGlueSync } from '../../build/bindgen/wav2flac.js';
import { builtin, isNode } from './platform.js';

/**
 * Where to load the wasm from: its bytes, a compiled module, a URL (string or
 * `URL`), or a `fetch` `Response` (or a promise of one). In Node a string that
 * is not an absolute URL is a file path.
 */
export type WasmSource = BufferSource | WebAssembly.Module | URL | string | Response | PromiseLike<Response>;

let compiled: WebAssembly.Module | undefined;
let memory: WebAssembly.Memory | undefined;
let pending: Promise<void> | undefined;
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
async function readFileUrl(url: URL): Promise<Uint8Array<ArrayBuffer>> {
  const fs = builtin<typeof import('node:fs')>('fs');
  return fs.promises.readFile(url);
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
 * @returns The compiled module.
 */
async function compile(source: WasmSource): Promise<WebAssembly.Module> {
  if (source instanceof WebAssembly.Module) return source;
  if (ArrayBuffer.isView(source) || source instanceof ArrayBuffer) return WebAssembly.compile(source as BufferSource);
  if (typeof SharedArrayBuffer === 'function' && (source as unknown) instanceof SharedArrayBuffer) {
    return WebAssembly.compile(new Uint8Array(source as unknown as SharedArrayBuffer).slice());
  }
  let res: Response | PromiseLike<Response>;
  if (typeof source === 'string' || source instanceof URL) {
    const url = toUrl(source);
    if (url.protocol === 'file:' && isNode()) return WebAssembly.compile(await readFileUrl(url));
    res = fetch(url);
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
 * Loads and instantiates the wasm module. Safe to call repeatedly and
 * concurrently; later calls return the first call's promise and ignore
 * their `source`: one module is loaded per realm (page, worker or Node
 * process), so pass a custom location on the first call, before anything
 * encodes. `encode`, `encodeStream`, `probe` and workers call it
 * automatically.
 *
 * @param source Where to load the wasm from. Default: `wav2flac.wasm` next to
 *   the package's JS (read with `fs` in Node, `fetch`ed elsewhere).
 * @returns Resolves once the module is ready.
 * @example
 * ```ts
 * import { init, encodeSync } from 'wav2flac';
 * await init();                       // or init(new URL('/assets/wav2flac.wasm', location.href))
 * const flac = encodeSync(wavBytes);
 * ```
 */
export function init(source?: WasmSource): Promise<void> {
  if (compiled !== undefined) return Promise.resolve();
  const p: Promise<void> = pending ??= (async () => {
    const mod = await compile(source ?? defaultWasmUrl());
    // initSync() may have finished while this was compiling; its instance wins.
    if (compiled !== undefined) return;
    // The glue keeps one instance; initSync() must not start another meanwhile.
    instantiating = true;
    try {
      const out = await initGlue({ module_or_path: mod });
      compiled = mod;
      memory = out.memory;
    } finally {
      instantiating = false;
    }
  })().catch((e: unknown) => {
    if (pending === p) pending = undefined;
    // A failed load does not matter once initSync() succeeded meanwhile.
    if (compiled === undefined) throw e;
  });
  return p;
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
