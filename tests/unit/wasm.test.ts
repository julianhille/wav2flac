// SPDX-License-Identifier: 0BSD
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTICES_SECTION, withFirstSection } from '../../scripts/wasm-section.js';

const WASM = 'build/bindgen/wav2flac_bg.wasm';
const bytes = readFileSync(WASM);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Reads a stream to the end. */
const collectAll = async (s: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(s).arrayBuffer());

/** A compiled module of another realm, e.g. from an iframe's parent. */
const foreignModule = (): WebAssembly.Module => {
  const mod = runInNewContext('new WebAssembly.Module(bytes)', { bytes }) as WebAssembly.Module;
  expect(mod).not.toBeInstanceOf(WebAssembly.Module);
  return mod;
};

/**
 * Stands in for a `URL` of another realm, which a `vm` context has no class
 * for: only the brand and the string are there, as seen from this realm.
 */
const foreignUrl = (href: string): URL =>
  ({ [Symbol.toStringTag]: 'URL', href, toString: () => href }) as unknown as URL;

/** A fresh copy of the loader and glue (no instance yet). */
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
    vi.stubGlobal(
      'process',
      new Proxy(real, {
        get: (t, k) =>
          k === 'getBuiltinModule'
            ? (id: string) =>
                id === 'fs'
                  ? { promises: { readFile: async () => bytes } }
                  : real.getBuiltinModule(id)
            : Reflect.get(t, k),
      }),
    );
    const api = await import('../../ts/index.js');
    const r = api.encodeStream(new Uint8Array(0), { compressionLevel: 99 as never }).getReader();
    await expect(r.read()).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });

  it.each([
    ['bytes', () => bytes],
    ['ArrayBuffer', () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)],
    ['Module', () => new WebAssembly.Module(bytes)],
    ['Module of another realm', foreignModule],
    ['file URL', () => pathToFileURL(WASM)],
    ['file URL string', () => pathToFileURL(WASM).href],
    ['file URL of another realm', () => foreignUrl(pathToFileURL(WASM).href)],
    ['file path', () => WASM],
    [
      'SharedArrayBuffer',
      () => {
        const sab = new SharedArrayBuffer(bytes.length);
        new Uint8Array(sab).set(bytes);
        return sab;
      },
    ],
    [
      'ArrayBuffer of another realm',
      () => {
        const buffer = runInNewContext(`new ArrayBuffer(${bytes.length})`) as ArrayBuffer;
        new Uint8Array(buffer).set(bytes);
        return buffer;
      },
    ],
    [
      'view of a SharedArrayBuffer',
      () => {
        const view = new Uint8Array(new SharedArrayBuffer(bytes.length + 8), 8);
        view.set(bytes);
        return view;
      },
    ],
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
    await expect(
      w.init(new Response('nope', { status: 404, statusText: 'Not Found' })),
    ).rejects.toThrow(/404/);
    await expect(w.init(new Uint8Array([1, 2, 3]))).rejects.toThrow(WebAssembly.CompileError);
    await expect(w.init(42 as never)).rejects.toThrow(/needs wasm bytes.*, got number$/);
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
    await expect(w.init(url, { signal: AbortSignal.timeout(10) })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
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
    await expect(w.init(url, { signal: AbortSignal.timeout(10) })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    // What encode() does: init() without a source.
    await w.init(undefined, { signal: new AbortController().signal });
    expect(urls).toEqual([url, url]);
    expect(w.isReady()).toBe(true);
  });

  it('retries a failed load from its custom source', async () => {
    const urls: string[] = [];
    const fetch = vi.fn((url: URL) => {
      urls.push(url.href);
      return Promise.resolve(
        urls.length === 1 ? new Response(null, { status: 503 }) : new Response(bytes),
      );
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
      return Promise.resolve(
        urls.length < 3 ? new Response(null, { status: 404 }) : new Response(bytes),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const w = await fresh();
    await expect(w.init('https://a.example/x.wasm')).rejects.toThrow(/404/);
    await expect(w.init('https://b.example/x.wasm')).rejects.toThrow(/404/);
    await w.init();
    expect(urls).toEqual([
      'https://a.example/x.wasm',
      'https://b.example/x.wasm',
      'https://b.example/x.wasm',
    ]);
  });

  it('skips a Response when it retries, and uses the source before it', async () => {
    const urls: string[] = [];
    const fetch = vi.fn((url: URL) => {
      urls.push(url.href);
      return Promise.resolve(
        urls.length === 1 ? new Response(null, { status: 503 }) : new Response(bytes),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const w = await fresh();
    const url = 'https://cdn.example/wav2flac.wasm';
    await expect(w.init(url)).rejects.toThrow(/503/);
    await expect(w.init(Promise.resolve(new Response(null, { status: 404 })))).rejects.toThrow(
      /404/,
    );
    await w.init();
    expect(urls).toEqual([url, url]);
  });

  it.each([
    ['a Response', () => new Response('busy', { status: 503, statusText: 'Unavailable' })],
    ['a Response promise', () => Promise.resolve(new Response(null, { status: 503 }))],
  ])('does not retry %s from the default location', async (_, make) => {
    const real = process;
    const readFile = vi.fn(async () => bytes);
    vi.stubGlobal(
      'process',
      new Proxy(real, {
        get: (t, k) =>
          k === 'getBuiltinModule'
            ? (id: string) => (id === 'fs' ? { promises: { readFile } } : real.getBuiltinModule(id))
            : Reflect.get(t, k),
      }),
    );
    const fetch = vi.fn(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    const w = await fresh();
    await expect(w.init(make())).rejects.toThrow(/503/);
    // What encode() does: init() without a source.
    await expect(w.init()).rejects.toThrow(/new Response/);
    await expect(w.init(undefined, { signal: new AbortController().signal })).rejects.toThrow(
      /new Response/,
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(w.isReady()).toBe(false);
    await w.init(new Response(bytes));
    expect(w.isReady()).toBe(true);
  });

  it.each([
    // A view that doesn't start at the start of its buffer.
    [
      'a view',
      () => {
        const buffer = new ArrayBuffer(bytes.byteLength + 8);
        new Uint8Array(buffer, 8).set(bytes);
        return { buffer, source: new Uint8Array(buffer, 8) };
      },
    ],
    [
      'an ArrayBuffer of another realm',
      () => {
        const buffer = runInNewContext(`new ArrayBuffer(${bytes.length})`) as ArrayBuffer;
        new Uint8Array(buffer).set(bytes);
        return { buffer, source: buffer };
      },
    ],
  ])('retries an abandoned load of %s from its own copy', async (_, make) => {
    const w = await fresh();
    const { buffer, source } = make();
    const stop = new AbortController();
    const first = w.init(source, { signal: stop.signal });
    stop.abort(new Error('gave up'));
    await expect(first).rejects.toThrow('gave up');
    // The caller hands its buffer on, which detaches it.
    structuredClone(buffer, { transfer: [buffer] });
    expect(buffer.byteLength).toBe(0);
    await w.init();
    expect(w.isReady()).toBe(true);
  });

  it('rejects detached bytes, and does not retry from them', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL) => {
        urls.push(url.href);
        return Promise.resolve(
          urls.length === 1 ? new Response(null, { status: 503 }) : new Response(bytes),
        );
      }),
    );
    const w = await fresh();
    const url = 'https://cdn.example/wav2flac.wasm';
    await expect(w.init(url)).rejects.toThrow(/503/);
    const buffer = new Uint8Array(bytes).buffer;
    const view = new Uint8Array(buffer, 8);
    structuredClone(buffer, { transfer: [buffer] });
    await expect(w.init(buffer)).rejects.toThrow(/detached/);
    await expect(w.init(view)).rejects.toThrow(/detached/);
    // The retry loads from the last source that could be read.
    await w.init();
    expect(urls).toEqual([url, url]);
  });

  it('rejects a source it cannot inspect instead of throwing', async () => {
    const w = await fresh();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    await expect(w.init(proxy as never)).rejects.toThrow(TypeError);
  });

  it('retries from the URL it was given, not from a later change to it', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL) => {
        urls.push(url.href);
        return new Promise<Response>(() => {});
      }),
    );
    const w = await fresh();
    const url = new URL('https://cdn.example/wav2flac.wasm');
    const stop = new AbortController();
    const first = w.init(url, { signal: stop.signal });
    stop.abort(new Error('gave up'));
    await expect(first).rejects.toThrow('gave up');
    url.pathname = '/other.wasm';
    const again = new AbortController();
    const second = w.init(undefined, { signal: again.signal });
    again.abort(new Error('gave up'));
    await expect(second).rejects.toThrow('gave up');
    expect(urls).toEqual([
      'https://cdn.example/wav2flac.wasm',
      'https://cdn.example/wav2flac.wasm',
    ]);
  });

  it('retries a relative URL resolved against the page it was given on', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (url: URL) => {
      urls.push(url.href);
      return Promise.resolve(
        urls.length === 1 ? new Response(null, { status: 503 }) : new Response(bytes),
      );
    });
    vi.stubGlobal('location', { href: 'https://app.example/editor/' });
    // A browser: no Node, so the string is a URL, not a file path.
    const real = process;
    vi.stubGlobal(
      'process',
      new Proxy(real, {
        get: (t, k) =>
          k === 'versions' ? { ...real.versions, node: undefined } : Reflect.get(t, k),
      }),
    );
    const w = await fresh();
    await expect(w.init('wav2flac.wasm')).rejects.toThrow(/503/);
    // A single-page app navigates (history.pushState) before encode() retries.
    (globalThis as { location: { href: string } }).location.href =
      'https://app.example/editor/project/42/';
    await w.init();
    expect(urls).toEqual([
      'https://app.example/editor/wav2flac.wasm',
      'https://app.example/editor/wav2flac.wasm',
    ]);
    expect(w.isReady()).toBe(true);
  });

  it('reads a path as a file in Node, also where a location exists', async () => {
    // jsdom and Deno --location define a location; a path must not become a fetch.
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('location', { href: 'http://localhost:3000/' });
    const w = await fresh();
    await expect(w.init('nope/wav2flac.wasm')).rejects.toThrow(/ENOENT/);
    await expect(w.init('/nope/wav2flac.wasm')).rejects.toThrow(/ENOENT/);
    await w.init(WASM);
    expect(fetch).not.toHaveBeenCalled();
    expect(w.isReady()).toBe(true);
  });

  it('retries a relative path resolved against the cwd it was given in', async () => {
    const reads: string[] = [];
    const readFile = async (p: URL): Promise<Uint8Array> => {
      reads.push(p.href);
      if (reads.length === 1) throw Object.assign(new Error('EIO: busy'), { code: 'EIO' });
      return bytes;
    };
    const real = process;
    vi.stubGlobal(
      'process',
      new Proxy(real, {
        get: (t, k) =>
          k === 'getBuiltinModule'
            ? (id: string) => (id === 'fs' ? { promises: { readFile } } : real.getBuiltinModule(id))
            : Reflect.get(t, k),
      }),
    );
    const cwd = process.cwd();
    const app = mkdtempSync(join(tmpdir(), 'wav2flac-'));
    mkdirSync(join(app, 'sub'));
    try {
      process.chdir(app);
      const w = await fresh();
      await expect(w.init('w2f.wasm')).rejects.toThrow('EIO');
      process.chdir(join(app, 'sub'));
      await w.init();
      const want = pathToFileURL(join(realpathSync(app), 'w2f.wasm')).href;
      expect(reads).toEqual([want, want]);
      expect(w.isReady()).toBe(true);
    } finally {
      process.chdir(cwd);
      rmSync(app, { recursive: true });
    }
  });

  it('lets the caller transfer its bytes right after the call', async () => {
    const w = await fresh();
    const buffer = new Uint8Array(bytes).buffer;
    const done = w.init(buffer);
    structuredClone(buffer, { transfer: [buffer] });
    await done;
    expect(w.isReady()).toBe(true);
  });

  it('lets go of the bytes it loaded from, and of its copy', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const w = await fresh();
    const refs: WeakRef<ArrayBufferLike>[] = [];
    // Records the copies of the wasm init() makes; a spy would keep them alive.
    const proto = Object.getPrototypeOf(Uint8Array.prototype) as object;
    const slice = Object.getOwnPropertyDescriptor(proto, 'slice')!;
    Object.defineProperty(proto, 'slice', {
      ...slice,
      value(this: Uint8Array, ...args: [number?, number?]) {
        const copy = (slice.value as Uint8Array['slice']).apply(this, args);
        if (copy.byteLength === bytes.byteLength) refs.push(new WeakRef(copy.buffer));
        return copy;
      },
    });
    try {
      await (async () => {
        // A copy: slice() of a Node Buffer shares its memory.
        const copy = new Uint8Array(bytes);
        refs.push(new WeakRef(copy.buffer));
        await w.init(copy);
      })();
    } finally {
      Object.defineProperty(proto, 'slice', slice);
    }
    expect(refs).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 0));
    gc();
    expect(refs.map((r) => r.deref())).toEqual([undefined, undefined]);
  });

  it('keeps a load alive while another caller still waits', async () => {
    let answer!: (r: Response) => void;
    const w = await fresh();
    const a = new AbortController();
    const first = w.init(
      new Promise<Response>((r) => {
        answer = r;
      }),
      { signal: a.signal },
    );
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
    const stale = w.init(
      new Promise<Response>((r) => {
        answer = r;
      }),
      { signal: a.signal },
    );
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
    await expect(a).rejects.toThrow(WebAssembly.CompileError);
    await expect(b).rejects.toThrow(WebAssembly.CompileError);
  });

  it('encode and encodeStream stop waiting for a stalled load on abort', async () => {
    vi.resetModules();
    const real = process;
    let reads = 0;
    vi.stubGlobal(
      'process',
      new Proxy(real, {
        get: (t, k) =>
          k === 'getBuiltinModule'
            ? (id: string) =>
                id === 'fs'
                  ? {
                      promises: {
                        // The default file never arrives until the read is aborted.
                        readFile: (_: URL, o: { signal: AbortSignal }) => {
                          reads++;
                          return new Promise((_, reject) =>
                            o.signal.addEventListener('abort', () => reject(o.signal.reason)),
                          );
                        },
                      },
                    }
                  : real.getBuiltinModule(id)
            : Reflect.get(t, k),
      }),
    );
    const api = await import('../../ts/index.js');
    const reason = new Error('too slow');
    const c = new AbortController();
    let cancelled: unknown;
    const s = new ReadableStream<Uint8Array>({
      cancel: (why) => {
        cancelled = why;
      },
    });
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

  it('encodeStream releases its input when cancelled while the wasm loads', async () => {
    vi.resetModules();
    const real = process;
    const reads: AbortSignal[] = [];
    vi.stubGlobal(
      'process',
      new Proxy(real, {
        get: (t, k) =>
          k === 'getBuiltinModule'
            ? (id: string) =>
                id === 'fs'
                  ? {
                      promises: {
                        // The default file never arrives until the read is aborted.
                        readFile: (_: URL, o: { signal: AbortSignal }) => {
                          reads.push(o.signal);
                          return new Promise((_, reject) =>
                            o.signal.addEventListener('abort', () => reject(o.signal.reason)),
                          );
                        },
                      },
                    }
                  : real.getBuiltinModule(id)
            : Reflect.get(t, k),
      }),
    );
    const api = await import('../../ts/index.js');
    const cancels: unknown[] = [];
    const input = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({ cancel: (why) => void cancels.push(why) });

    // No signal: the cancel alone releases the input and abandons the load.
    const reason = new Error('not needed');
    await api.encodeStream(input()).cancel(reason);
    await vi.waitFor(() => expect(cancels).toEqual([reason]));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.aborted).toBe(true);

    // A plain init() keeps the load going; the cancelled stream still lets go.
    void api.init();
    const other = new Error('gone');
    await api.encodeStream(input()).cancel(other);
    await vi.waitFor(() => expect(cancels).toEqual([reason, other]));
    expect(reads).toHaveLength(2);
    expect(reads[1]!.aborted).toBe(false);
  });

  it('initSync accepts bytes or a Module', async () => {
    let w = await fresh();
    w.initSync(bytes);
    expect(w.isReady()).toBe(true);
    w = await fresh();
    const sab = new SharedArrayBuffer(bytes.length);
    new Uint8Array(sab).set(bytes);
    w.initSync(sab as never);
    expect(w.isReady()).toBe(true);
    w = await fresh();
    w.initSync(new WebAssembly.Module(bytes));
    expect(w.wasmMemoryBytes()).toBeGreaterThan(0);
    await w.init();
    w = await fresh();
    w.initSync(foreignModule());
    expect(w.wasmModule()).toBeInstanceOf(WebAssembly.Module);
  });

  it('initSync names what it got instead of bytes or a Module', async () => {
    const w = await fresh();
    for (const [src, got] of [
      [42, 'number'],
      [{}, 'Object'],
      [pathToFileURL(WASM), 'URL'],
    ] as const)
      expect(() => w.initSync(src as never)).toThrow(
        new TypeError(`wav2flac: initSync() needs wasm bytes or a WebAssembly.Module, got ${got}`),
      );
    expect(w.isReady()).toBe(false);
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

  it('thirdPartyLicenses returns the license section of the loaded wasm', async () => {
    vi.resetModules();
    const api = await import('../../ts/index.js');
    const text = '# Notices\n\n| a | b |\n| --- | --- |\n| ü | → |\n';
    await api.init(
      withFirstSection(Uint8Array.from(bytes), NOTICES_SECTION, new TextEncoder().encode(text)),
    );
    await expect(api.thirdPartyLicenses()).resolves.toBe(text);
  });

  it('thirdPartyLicenses rejects before init, without loading or waiting for the wasm', async () => {
    vi.resetModules();
    const api = await import('../../ts/index.js');
    // A download that never answers until it is aborted.
    const fetch = vi.fn(
      (_: URL, opts: RequestInit) =>
        new Promise<Response>((_, reject) => {
          opts.signal!.addEventListener('abort', () => reject(opts.signal!.reason));
        }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(api.thirdPartyLicenses()).rejects.toThrow(/not initialized/);
    expect(fetch).not.toHaveBeenCalled();
    // A load in progress is not waited for, and not kept alive.
    const loading = api.init('https://cdn.example/wav2flac.wasm', {
      signal: AbortSignal.timeout(10),
    });
    await expect(api.thirdPartyLicenses()).rejects.toThrow(/not initialized/);
    await expect(loading).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
    await expect(api.thirdPartyLicenses()).rejects.toThrow(/not initialized/);
    expect(fetch).toHaveBeenCalledOnce();
    const text = '# Notices\n';
    await api.init(
      withFirstSection(Uint8Array.from(bytes), NOTICES_SECTION, new TextEncoder().encode(text)),
    );
    await expect(api.thirdPartyLicenses()).resolves.toBe(text);
  });

  it('thirdPartyLicenses rejects a wasm without the license section', async () => {
    vi.resetModules();
    const api = await import('../../ts/index.js');
    await api.init(bytes);
    await expect(api.thirdPartyLicenses()).rejects.toThrow(/no "license" section/);
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
      const s = new ReadableStream<Uint8Array>({
        cancel: (why) => {
          cancelled = why;
        },
      });
      await expect(run(s)).rejects.toThrow(/ENOENT/);
      expect(String(cancelled)).toMatch(/ENOENT/);
    }
    vi.resetModules();
    // Success path: serve the default file from a stubbed fs.
    const real = process;
    vi.stubGlobal(
      'process',
      new Proxy(real, {
        get: (t, k) =>
          k === 'getBuiltinModule'
            ? (id: string) =>
                id === 'fs'
                  ? { promises: { readFile: async () => bytes } }
                  : real.getBuiltinModule(id)
            : Reflect.get(t, k),
      }),
    );
    const api2 = await import('../../ts/index.js');
    const { makeWav, collect } = await import('../helpers/wav.js');
    const out = await collect(api2.encodeStream(makeWav({ frames: 1000 })));
    expect(out.length).toBeGreaterThan(0);
  });
});
