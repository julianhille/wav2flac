// SPDX-License-Identifier: 0BSD
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
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

  it('rejects a bad signal, and an aborted one before loading', async () => {
    const w = await fresh();
    await expect(w.init(bytes, { signal: {} as never })).rejects.toThrow(TypeError);
    const reason = new Error('stop');
    await expect(w.init(bytes, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(w.isReady()).toBe(false);
    await w.init(bytes, { signal: new AbortController().signal });
    expect(w.isReady()).toBe(true);
    await expect(w.init(undefined, { signal: {} as never })).rejects.toThrow(TypeError);
  });

  it('gives up on a stalled fetch and retries with a new one', async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_: URL, opts: RequestInit) => {
      signals.push(opts.signal!);
      // The first request never answers until it is aborted.
      if (signals.length === 1) {
        return new Promise<Response>((_, reject) => {
          opts.signal!.addEventListener('abort', () => reject(opts.signal!.reason));
        });
      }
      return Promise.resolve(new Response(bytes));
    });
    vi.stubGlobal('fetch', fetch);
    const w = await fresh();
    const url = 'https://cdn.example/wav2flac.wasm';
    await expect(w.init(url, { signal: AbortSignal.timeout(10) })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(signals[0]!.aborted).toBe(true);
    await w.init(url);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(w.isReady()).toBe(true);
  });

  it('retries an abandoned load from its custom source', async () => {
    const urls: string[] = [];
    const fetch = vi.fn((url: URL, opts: RequestInit) => {
      urls.push(url.href);
      if (urls.length === 1) {
        return new Promise<Response>((_, reject) => {
          opts.signal!.addEventListener('abort', () => reject(opts.signal!.reason));
        });
      }
      return Promise.resolve(new Response(bytes));
    });
    vi.stubGlobal('fetch', fetch);
    const w = await fresh();
    const url = 'https://cdn.example/wav2flac.wasm';
    await expect(w.init(url, { signal: AbortSignal.timeout(10) })).rejects.toMatchObject({ name: 'TimeoutError' });
    // What encode() does: init() without a source.
    await w.init(undefined, { signal: new AbortController().signal });
    expect(urls).toEqual([url, url]);
    expect(w.isReady()).toBe(true);
  });

  it('retries a failed load from its custom source', async () => {
    const urls: string[] = [];
    const fetch = vi.fn((url: URL) => {
      urls.push(url.href);
      return Promise.resolve(urls.length === 1 ? new Response(null, { status: 503 }) : new Response(bytes));
    });
    vi.stubGlobal('fetch', fetch);
    const w = await fresh();
    const url = 'https://cdn.example/wav2flac.wasm';
    await expect(w.init(url)).rejects.toThrow(/503/);
    await w.init();
    expect(urls).toEqual([url, url]);
    expect(w.isReady()).toBe(true);
  });

  it('retries from the source of the last load that had one', async () => {
    const urls: string[] = [];
    const fetch = vi.fn((url: URL) => {
      urls.push(url.href);
      return Promise.resolve(urls.length < 3 ? new Response(null, { status: 404 }) : new Response(bytes));
    });
    vi.stubGlobal('fetch', fetch);
    const w = await fresh();
    await expect(w.init('https://a.example/x.wasm')).rejects.toThrow(/404/);
    await expect(w.init('https://b.example/x.wasm')).rejects.toThrow(/404/);
    await w.init();
    expect(urls).toEqual(['https://a.example/x.wasm', 'https://b.example/x.wasm', 'https://b.example/x.wasm']);
  });

  it('skips a Response when it retries, and uses the source before it', async () => {
    const urls: string[] = [];
    const fetch = vi.fn((url: URL) => {
      urls.push(url.href);
      return Promise.resolve(urls.length === 1 ? new Response(null, { status: 503 }) : new Response(bytes));
    });
    vi.stubGlobal('fetch', fetch);
    const w = await fresh();
    const url = 'https://cdn.example/wav2flac.wasm';
    await expect(w.init(url)).rejects.toThrow(/503/);
    await expect(w.init(Promise.resolve(new Response(null, { status: 404 })))).rejects.toThrow(/404/);
    await w.init();
    expect(urls).toEqual([url, url]);
  });

  it('lets go of the bytes it loaded from', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const w = await fresh();
    let ref: WeakRef<ArrayBuffer> | undefined;
    await (async () => {
      // A copy: slice() of a Node Buffer shares its memory.
      const copy = new Uint8Array(bytes);
      ref = new WeakRef(copy.buffer);
      await w.init(copy);
    })();
    await new Promise((r) => setTimeout(r, 0));
    gc();
    expect(ref!.deref()).toBeUndefined();
  });

  it('keeps a load alive while another caller still waits', async () => {
    let answer!: (r: Response) => void;
    const w = await fresh();
    const a = new AbortController();
    const first = w.init(new Promise<Response>((r) => { answer = r; }), { signal: a.signal });
    const b = new AbortController();
    const second = w.init(undefined, { signal: b.signal });
    const third = w.init();
    a.abort();
    b.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    // `third` has no signal, so the same load goes on.
    answer(new Response(bytes));
    await third;
    expect(w.isReady()).toBe(true);
  });

  it('drops a load that finishes after it was abandoned', async () => {
    let answer!: (r: Response) => void;
    const w = await fresh();
    const a = new AbortController();
    const stale = w.init(new Promise<Response>((r) => { answer = r; }), { signal: a.signal });
    a.abort();
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    // A source that cannot be cancelled still arrives; it must not instantiate.
    answer(new Response(bytes));
    await new Promise((r) => setTimeout(r, 50));
    expect(w.isReady()).toBe(false);
    await w.init(bytes);
    expect(w.isReady()).toBe(true);
  });

  it('shares a failed load with every waiter', async () => {
    const w = await fresh();
    const a = w.init(new Uint8Array([1, 2, 3]), { signal: new AbortController().signal });
    const b = w.init(undefined, { signal: new AbortController().signal });
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
  });

  it('encode and encodeStream stop waiting for a stalled load on abort', async () => {
    vi.resetModules();
    const real = process;
    let reads = 0;
    vi.stubGlobal('process', new Proxy(real, {
      get: (t, k) => (k === 'getBuiltinModule'
        ? (id: string) => (id === 'fs'
          ? {
              promises: {
                // The default file never arrives until the read is aborted.
                readFile: (_: URL, o: { signal: AbortSignal }) => {
                  reads++;
                  return new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason)));
                },
              },
            }
          : real.getBuiltinModule(id))
        : Reflect.get(t, k)),
    }));
    const api = await import('../../ts/index.js');
    const reason = new Error('too slow');
    const c = new AbortController();
    let cancelled: unknown;
    const s = new ReadableStream<Uint8Array>({ cancel: (why) => { cancelled = why; } });
    const encoding = api.encode(s, { signal: c.signal });
    const streaming = collectAll(api.encodeStream(new Uint8Array(10), { signal: c.signal }));
    c.abort(reason);
    await expect(encoding).rejects.toBe(reason);
    await expect(streaming).rejects.toBe(reason);
    expect(cancelled).toBe(reason);
    // The next call starts a new read.
    const d = new AbortController();
    const again = api.encode(new Uint8Array(10), { signal: d.signal });
    expect(reads).toBe(2);
    d.abort();
    await expect(again).rejects.toMatchObject({ name: 'AbortError' });
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
