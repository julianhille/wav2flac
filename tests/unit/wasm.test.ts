// SPDX-License-Identifier: 0BSD
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const WASM = 'build/bindgen/wav2flac_bg.wasm';
const bytes = readFileSync(WASM);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** A fresh copy of the loader and glue (no instance yet). */
/** Reads a stream to the end. */
const collectAll = async (s: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(s).arrayBuffer());

const fresh = async (): Promise<typeof import('../../ts/lib/wasm.js')> => {
  vi.resetModules();
  return import('../../ts/lib/wasm.js');
};

describe('init', () => {
  it('reports not-ready before init', async () => {
    const w = await fresh();
    expect(w.isReady()).toBe(false);
    expect(w.wasmMemoryBytes()).toBe(0);
    expect(() => w.wasmModule()).toThrow(/not initialized/);
  });

  it('errors encodeStream on invalid options when called before init', async () => {
    vi.resetModules();
    const real = process;
    vi.stubGlobal('process', new Proxy(real, {
      get: (t, k) => (k === 'getBuiltinModule'
        ? (id: string) => (id === 'fs' ? { promises: { readFile: async () => bytes } } : real.getBuiltinModule(id))
        : Reflect.get(t, k)),
    }));
    const api = await import('../../ts/index.js');
    const r = api.encodeStream(new Uint8Array(0), { compressionLevel: 99 as never }).getReader();
    await expect(r.read()).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });

  it.each([
    ['bytes', () => bytes],
    ['ArrayBuffer', () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)],
    ['Module', () => new WebAssembly.Module(bytes)],
    ['file URL', () => pathToFileURL(WASM)],
    ['file URL string', () => pathToFileURL(WASM).href],
    ['file path', () => WASM],
    ['SharedArrayBuffer', () => {
      const sab = new SharedArrayBuffer(bytes.length);
      new Uint8Array(sab).set(bytes);
      return sab;
    }],
    ['Response', () => new Response(bytes, { headers: { 'content-type': 'application/wasm' } })],
    ['Response promise (no wasm mime)', () => Promise.resolve(new Response(bytes))],
  ])('loads from %s', async (_, src) => {
    const w = await fresh();
    await w.init(src() as never);
    expect(w.isReady()).toBe(true);
    expect(w.wasmMemoryBytes()).toBeGreaterThan(0);
    expect(w.wasmModule()).toBeInstanceOf(WebAssembly.Module);
  });

  it('fetches http URLs', async () => {
    const fetch = vi.fn(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    const w = await fresh();
    await w.init('https://cdn.example/wav2flac.wasm');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('is idempotent and concurrent-safe', async () => {
    const w = await fresh();
    const a = w.init(bytes);
    expect(w.init()).toBe(a);
    await a;
    w.initSync(bytes);
    expect(w.isReady()).toBe(true);
  });

  it('keeps one instance when initSync runs while init is loading', async () => {
    const w = await fresh();
    const pending = w.init(new WebAssembly.Module(bytes));
    w.initSync(bytes);
    const mod = w.wasmModule();
    const mem = w.wasmMemoryBytes();
    await pending;
    expect(w.wasmModule()).toBe(mod);
    expect(w.wasmMemoryBytes()).toBe(mem);
    await expect(w.init()).resolves.toBeUndefined();
  });

  it('ignores a failed init once initSync succeeded meanwhile', async () => {
    const w = await fresh();
    const pending = w.init(new Uint8Array([1, 2, 3]));
    w.initSync(bytes);
    await expect(pending).resolves.toBeUndefined();
    expect(w.isReady()).toBe(true);
  });

  it('allows a retry after a failed init', async () => {
    const w = await fresh();
    await expect(w.init(new Response('nope', { status: 404, statusText: 'Not Found' }))).rejects.toThrow(/404/);
    await expect(w.init(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    await expect(w.init(42 as never)).rejects.toThrow(/needs wasm bytes/);
    await w.init(bytes);
    expect(w.isReady()).toBe(true);
  });

  it('initSync accepts bytes or a Module', async () => {
    let w = await fresh();
    w.initSync(bytes);
    expect(w.isReady()).toBe(true);
    w = await fresh();
    w.initSync(new WebAssembly.Module(bytes));
    expect(w.wasmMemoryBytes()).toBeGreaterThan(0);
    await w.init();
  });

  it('points the default URL next to the bundle', async () => {
    const w = await fresh();
    expect(w.defaultWasmUrl().href).toMatch(/\/wav2flac\.wasm$/);
    expect(w.notReady().message).toMatch(/init/);
  });

  it('treats a Windows drive path as a file path, not a URL', async () => {
    const w = await fresh();
    // "C:\\..." parses as a URL with scheme "c"; Node must read it as a file.
    await expect(w.init('C:\\nope\\wav2flac.wasm')).rejects.toThrow(/ENOENT/);
  });

  it('initSync without arguments reads the default file', async () => {
    const w = await fresh();
    expect(() => w.initSync()).toThrow(/ENOENT/);
  });

  it('encodeSync and version need init', async () => {
    vi.resetModules();
    const api = await import('../../ts/index.js');
    expect(() => api.encodeSync(new Uint8Array(1))).toThrow(/not initialized/);
    expect(() => api.version()).toThrow(/not initialized/);
  });

  it('encodeStream initializes lazily and reports init failures', async () => {
    vi.resetModules();
    const api = await import('../../ts/index.js');
    const r = api.encodeStream(new Uint8Array(10)).getReader();
    // The default URL (ts/wav2flac.wasm) does not exist next to the sources.
    await expect(r.read()).rejects.toThrow(/ENOENT/);
    // A stream input is cancelled when init fails, on both paths.
    for (const run of [
      (s: ReadableStream<Uint8Array>) => collectAll(api.encodeStream(s)),
      (s: ReadableStream<Uint8Array>) => api.encode(s),
    ]) {
      let cancelled: unknown;
      const s = new ReadableStream<Uint8Array>({ cancel: (why) => { cancelled = why; } });
      await expect(run(s)).rejects.toThrow(/ENOENT/);
      expect(String(cancelled)).toMatch(/ENOENT/);
    }
    vi.resetModules();
    // Success path: serve the default file from a stubbed fs.
    const real = process;
    vi.stubGlobal('process', new Proxy(real, {
      get: (t, k) => (k === 'getBuiltinModule'
        ? (id: string) => (id === 'fs' ? { promises: { readFile: async () => bytes } } : real.getBuiltinModule(id))
        : Reflect.get(t, k)),
    }));
    const api2 = await import('../../ts/index.js');
    const { makeWav, collect } = await import('../helpers/wav.js');
    const out = await collect(api2.encodeStream(makeWav({ frames: 1000 })));
    expect(out.length).toBeGreaterThan(0);
  });
});
