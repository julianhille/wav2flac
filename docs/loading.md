<!-- SPDX-License-Identifier: 0BSD -->
# Loading the wasm

The encoder is a WebAssembly module, `wav2flac.wasm`. It is loaded once per
realm (page, worker or Node process), the first time you encode.

## Where it comes from

`encode`, `encodeStream`, `probe` and `createWorkerEncoder` call `init()` for
you. Without an argument, `init()` loads the `.wasm` that ships next to the
package's JS:

- **Node**: read from disk with `fs`.
- **Browsers and bundlers** (Vite, webpack): fetched from
  `new URL('../wav2flac.wasm', import.meta.url)`, which bundlers detect and
  emit as an asset.

To host it yourself, call `init()` before anything encodes. It takes a URL or
path, the bytes, a compiled `WebAssembly.Module`, or a `Response` (or a
promise of one):

```ts
import { init } from 'wav2flac';
await init(new URL('/assets/wav2flac.wasm', location.href));
```

In Node a string without a URL scheme (`https:`, `file:`, ...) is a file
path, even where a global `location` exists (jsdom, Deno with `--location`);
in a browser it is a URL relative to the page. Pass a `URL` to fetch over
HTTP from Node.

Only the call that starts a load chooses its source. Later calls share the
load already in progress and ignore their argument. A retry after a failed or
abandoned load (see [Retrying](#retrying)) loads from your source again.

Loading the package itself straight from a CDN, without a bundler? Use the
minified bundles; the wasm then comes from the same CDN folder. See
[Load from a CDN without a bundler](how-to/load-from-cdn.md).

## Timeouts and stalled downloads

A download that never finishes, from a hung CDN or a dead connection, keeps
`init()` pending. Pass a `signal` to stop waiting. `init()` then rejects with
the signal's reason, which is a `TimeoutError` for `AbortSignal.timeout()`:

```ts
try {
  await init(wasmUrl, { signal: AbortSignal.timeout(10_000) });
} catch (e) {
  if (e instanceof DOMException && e.name === 'TimeoutError') {
    showError('The encoder could not be downloaded. Check your connection and try again.');
  }
  throw e;
}
```

`encode()` and `encodeStream()` pass their own `signal` to `init()`, so one
signal covers both loading and encoding:

```ts
const flac = await encode(wav, { signal: AbortSignal.timeout(30_000) });
```

### Retrying

Every caller shares one load. The load is cancelled (its `fetch` or file read
is aborted) once every caller waiting on it has given up. The next `init()`,
or the next `encode()`, then starts a new download. A load that fails, such as
a 404 or a network error, rejects every caller and is also retried by the
next call.

A retry loads from the source passed to that call. Without one, as in
`encode()`, it loads from the last URL, path, bytes or module that a load
started with, not from the default location. A relative URL or path is
resolved once, when its load starts, against the page URL or the current
directory, so the retry loads the same file after a single-page app navigated
or the process changed directory. `init()` loads from its own
copy of bytes, so you can reuse or transfer your buffer right after the call.
A `Response` can be read only once, so after a load from a `Response` failed,
pass a new one. Until you do, a retry without a source loads from the URL,
path, bytes or module of an earlier load, or, if there was none, rejects
with an error that asks for a new `Response`.

A worker encoder loads the wasm once, when you create it. If that load fails,
every job of that encoder rejects with its error; create a new encoder to try
again.

A caller that waits **without** a signal keeps the load going. Its wait is
never cut short by another caller's timeout, and it waits as long as the load
takes.

A source that cannot be cancelled, such as a `Response` promise you created,
is simply no longer waited for. If it arrives later, it is dropped.

## Which APIs this applies to

| API | Waits for the wasm | Can be aborted while it loads |
|---|---|---|
| `init(source, { signal })` | yes | yes, with `signal` |
| `encode(input, { signal })` | yes | yes, with `signal` |
| `encodeStream(input, { signal })` | yes | yes, with `signal`; the stream errors |
| `probe(input)` | yes | no; call `init()` with a signal first |
| `createWorkerEncoder()` | yes | a job's `signal` aborts that job, but the load goes on |
| `initSync(source?)` | no: loads synchronously | not needed |
| `encodeSync(input)` | no: throws if not loaded | not needed |

`initSync()` takes bytes or a module you already have, or in Node reads the
bundled file synchronously, so it cannot stall on a download.
`encodeSync()` never loads anything: call `await init()` or `initSync()`
first.

## Self-hosting and licenses

The `.wasm` carries the license notices of the code in it, as its first
section. Host it as it is, without tools that strip custom sections. See
[Bundling and license notices](bundling.md).
