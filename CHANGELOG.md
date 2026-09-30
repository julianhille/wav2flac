# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every version headline links to the diff against the previous release; the
links are collected at the bottom of this file.

## [Unreleased]

### Fixed

- `node scripts/release.ts prepare X.Y.Z` runs on a `release/vX.Y.Z` branch
  started from `origin/main`, as the release workflow describes, and prints
  the matching push command. It used to run only on `main`.
- `node scripts/release.ts prepare X.Y.Z` stops when the previous release's
  tag is missing or not in `main`'s history, as after a squash-merged release
  branch. The new version's headline would link to a compare that starts
  from the merge base, not from the previous release.
- A retry of `init('wav2flac.wasm')`, or of a relative path in Node, loads the
  same file as the first attempt. Before, the retry resolved the string again,
  against the page URL or the current directory at that time: after a
  single-page app navigated, `encode()` fetched the wasm from the new route,
  got the HTML page and failed with a `CompileError`. rc.3 did not have this
  bug.
- A worker encoder that was terminated or whose worker crashed now cancels a
  `ReadableStream` input passed to `encode()` or `encodeStream()`, like every
  other failed encode. Before, the stream was left open, so a `fetch()` body
  kept its HTTP connection.
- `encode()` and `encodeStream()` on the main thread cancel a `ReadableStream`
  input when the options are invalid, as the worker encoder already did.
- `init()` and `initSync()` accept a `WebAssembly.Module` of another realm,
  such as one a parent page compiled and handed to an iframe, or one from a
  Node `vm` context; `init()` also accepts a `URL` of another realm. Before,
  they failed with a `TypeError` that said a Module or URL was needed.
- `initSync()` with something other than wasm bytes or a `WebAssembly.Module`
  throws a `TypeError` that says so, instead of the engine's "Argument 0 must
  be a buffer source". Both `init()` and `initSync()` name the type they got.
- `copy: true` on the worker encoder copies a Node `Buffer`. Before, it used
  `Buffer#slice()`, which returns a view: a Buffer from `fs.readFile()` was
  still transferred (detached), so encoding it a second time failed, and a
  Buffer view was read after the call returned, so reusing it at once
  encoded garbage. Buffer chunks of a stream input were detached too.
- `probe()` on the worker encoder posts a copy of the header prefix of a Node
  `Buffer`. Before, it posted a view, which cloned the whole backing buffer
  on every try.
- After a load from a `Response` (or a promise of one) failed or was given
  up, `encode()` and the other calls that retry the load no longer load the
  wasm from the default location next to the package, which you never
  configured. The retry now rejects with an error asking for a new
  `Response`, unless an earlier `init()` gave a URL, path, bytes or module,
  which it then loads from as before.

## [1.0.0-rc.4] - 2026-09-30

### Added

- `wav2flac.wasm` carries the license notices of the Rust crates in it: the
  text of `THIRD_PARTY_LICENSES.txt`, as a custom section named `license` at
  the start of the file. It isn't compressed, so `head` or `strings` shows it as
  the first lines of the file, and
  `WebAssembly.Module.customSections(module, 'license')` returns it. Engines
  ignore the section. Every license file is there in full. Vite and webpack
  copy the wasm as it is, so the notices go wherever the wasm goes, with
  nothing to configure. The wasm grows from 165 KB to 426 KB, or from 72 KB
  to 87 KB gzipped.
- `thirdPartyLicenses()` returns the license notices from the loaded wasm, as
  Markdown. It initializes the wasm on first use and fetches nothing else.
- `wav2flac/THIRD_PARTY_LICENSES.txt` resolves to the notices file in the
  package, for tools and docs that want the text.
- Docs: a page on the license notices when bundling or hosting the wasm
  yourself.
- Minified bundles next to the normal ones, for loading straight from a CDN
  without a bundler: `pkg/esm/index.min.js` and `worker.min.js`,
  `pkg/cjs/index.min.cjs` and `worker.min.cjs`, each with a source map, also
  exported as `wav2flac/min`. About 6 KiB smaller gzipped (index + worker).
  `wav2flac` still resolves to the normal bundles, which lose only the
  license comment (see Removed).
- Docs: a how-to for loading from a CDN, including starting the worker
  there.

### Changed

- `THIRD_PARTY_LICENSES.txt` is Markdown: a table of the crates with their
  versions, licenses and sources, then each crate's license files word for
  word, in code blocks. The name stays, and the text still reads as plain
  text.

### Removed

- The `/*! @license */` comment at the start of the JS bundles. If you kept
  the license notices through that comment, take them from the wasm's
  `license` custom section instead (see Added), which has them in full.
  Bundlers such as Vite dropped the comment, and the notices with it.

### Fixed

- Worker encoder: `terminate()` and a crash reject a `probe()` or
  `wasmMemoryBytes()` call made while the wasm still loads. Before, such a
  call stayed pending forever. Such a call also rejects when its message
  can't be posted to the worker, instead of staying pending and keeping Node
  running.
- Worker encoder: `wasmMemoryBytes()` rejects when the worker's wasm failed
  to start, so it tells whether the worker can still encode. Before, it
  answered 0.
- `init()` retries a failed or abandoned load from the URL, path, bytes or
  module it was given. Before, after `init(url, { signal })` gave up, the
  `init()` inside `encode()` loaded from the default location instead. It
  keeps a copy of bytes or of a `URL` until the wasm is ready, so a buffer
  you transfer or a `URL` you change after the call can't break the retry.
  Bytes that were already transferred (detached) reject with an error that
  says so, and a retry doesn't use them.
- `initSync()` accepts a `SharedArrayBuffer`, like `init()`. Before, it
  threw.
- `init()` loads from an `ArrayBuffer` of another realm, such as an iframe or
  a `vm` context. Before, it rejected it as not being wasm bytes.
- Docs: the worker pool sample replaces a worker that crashed. Before, the
  pool kept handing jobs to it, and each of them failed. It also rejects a
  size below 1, which made every job wait forever, and its batch example
  keeps the results of the other files when one fails. Before, one bad file
  made the batch terminate the pool, which failed every job still running or
  waiting. A failed job rejects at once, and a worker that stops answering
  is replaced after 5 seconds. A job whose signal aborts while it waits for
  a worker rejects at once, too, not only once it gets one, and a job whose
  signal already aborted doesn't take an idle worker.
- Docs: the FIFO queue sample no longer keeps the last result alive, and a
  rejection that nobody handles is reported again.
- Docs: buffered output is held in JS memory, not in wasm memory, and the
  wasm memory of an encoder doesn't grow with long jobs. It depends on
  `blockSize`, the channel count, the bit depth and resampling instead, from
  well under 1 MiB with the defaults to up to about 20 MiB with the largest
  block size and 8 channels.
- Docs site: the how-to overview is titled "Overview" instead of "Index".
  "Edit on GitHub" opens the README on the home page and the generator on
  the third-party page, and is gone from the generated API reference, where
  it led to a 404.
- Docs site: every Python package of the build is pinned, not only MkDocs.
- Third-party notices: the Rust version they name comes from
  `rust-toolchain.toml`, not from the `rustc` on the path, and the build
  fails when the standard library's license texts or the `rustc` that built
  the wasm are from another release.
- Third-party page: crates are sorted the same in every locale, and the page
  links the same notice files that `THIRD_PARTY_LICENSES.txt` reproduces.
- API reference: `Wav2FlacError` no longer lists the static members that
  Node's type definitions add to `Error` (`captureStackTrace`,
  `prepareStackTrace`, `stackTraceLimit`). A `@throws` tag with a union type
  or without text renders cleanly, and the docs build fails when an
  exported type would be published as `any`.
- README: the license section names the licenses of the Rust standard
  library parts (Unicode-3.0, LLVM exception), and says where the notices
  are.

## [1.0.0-rc.3] - 2026-09-29

### Added

- README: a badge with the status of the docs build on Read the Docs. It links
  to the docs site.
- `init(source, { signal })`: give up waiting for the wasm, e.g. with
  `AbortSignal.timeout(ms)`. Once every caller waiting on a load has given
  up, the download or file read is cancelled and the next `init()` starts
  over. Before, a stalled download kept `init()` pending forever, and every
  retry got the same pending promise.
- `encode()` and `encodeStream()` pass their `signal` to `init()`, so an
  abort also ends the wait for the wasm to load.
- Docs: a guide to loading the wasm (where it comes from, self-hosting,
  timeouts and retries).
- Docs: how concurrent `encode()` calls are scheduled (interleaved on one
  thread, parallel across workers), and how-to guides for a worker pool and
  a FIFO queue.
- Docs: a how-to section, and a Guides list in the README.
- README: the package has no runtime dependencies (a new feature bullet).
- Docs: an API reference generated from the TSDoc (TypeDoc), on Read the Docs
  and checked in CI.
- Docs: a third-party components page listing every crate compiled into the
  wasm with its version, license and links, generated from `Cargo.lock`.
- Docs: when you host the `.wasm` yourself, put `THIRD_PARTY_LICENSES.txt`
  next to it (README and third-party page).

### Changed

- `THIRD_PARTY_LICENSES.txt`, the `@license` banner of the JS bundles and the
  third-party page now name every part of the Rust standard library that the
  wasm links: `core`, `alloc` and `std` (with the Unicode-3.0 license of the
  Unicode tables in `core`), `dlmalloc`, and `compiler_builtins` with its
  `libm`. Before, they named `core, alloc, std, dlmalloc` with one MIT notice.
  The banner gives the permission notice of the MIT license once, after the
  copyright notices of the crates under it, and grows by about 3 kB per
  bundle.

## [1.0.0-rc.2] - 2026-09-29

### Added

- Benchmark: `libav` and `libflac` modes (`--modes libav,libflac`) that run
  libav.js (FFmpeg's FLAC encoder) and libflac.js (the reference libFLAC) on
  the same integer PCM, in the Node and browser benchmarks. Both are
  dev dependencies of the benchmark only.

## [1.0.0-rc.1] - 2026-09-29

### Added

- Streaming WAV → FLAC encoder core in Rust, built on libflac-rs (a
  bit-exact port of libFLAC 1.4.3). Output modes: *buffered* (exact
  STREAMINFO with total samples and MD5, plus a SEEKTABLE) and *streaming*
  (header first, bounded memory). Output is identical however the input is
  chunked.
- Input: integer PCM with 8, 16, 24 or 32 bits (8-bit unsigned included),
  or 4–32 valid bits in a WAVE_FORMAT_EXTENSIBLE container (plain 12- or
  20-bit PCM is rejected), 32-bit float, 1–8 channels, sample rates up to
  1 048 575 Hz. Real-world quirks are tolerated: a missing or non-zero (even
  printable) pad byte after an odd-sized chunk, 24/32-bit PCM declared with an 18 or
  40-byte `fmt` chunk, a wrong byte rate, and a channel mask whose speaker
  count does not match the channels (the mask is then ignored). 64-bit float is rejected as `UNSUPPORTED_FORMAT`.
  The header is parsed incrementally, so many small chunks before `data`
  cost no more when the input arrives in small pieces.
- Compression levels 0–8 (libFLAC presets) and custom block sizes (16–65535).
- Metadata: LIST/INFO tags → Vorbis comments (UTF-8 with Latin-1 fallback;
  tags after the audio data are found behind chunks of any size, in buffered
  mode),
  a custom `tags` option, a PADDING block, and the channel-mask tag
  `WAVEFORMATEXTENSIBLE_CHANNEL_MASK`. The tag is written for non-default
  masks and for explicit 5.0/5.1 back-surround masks, so ffmpeg reads the
  layout correctly.
- Transcoding: resampling (rubato sinc, `fast`/`balanced`/`best`) and
  bit-depth conversion with seeded TPDF dither; depth increases are lossless.
- Limits and stable error codes (`INVALID_WAV`, `UNSUPPORTED_FORMAT`, …).
  Resampling is limited to 256x up and 65536x down (`INVALID_OPTIONS`).
- Test suites: roundtrip, lengths, options, WAV variants, malformed input,
  chunking, streaming, state, metadata, transcode quality, property-based,
  golden hashes, and differential tests against ffmpeg and `flac`.
- Project scaffolding: 0BSD license, third-party license handling, CI skeleton.
- JavaScript API written in TypeScript: `encode`, `encodeStream`, `encodeSync`,
  `probe`, `init`/`initSync`, `version`, `wasmMemoryBytes` and
  `createWorkerEncoder` (Web Worker or `worker_threads`, with transferable
  input, backpressured stream output, progress and `AbortSignal` support;
  `WorkerEncoderOptions` set the worker script and wasm source). Ships as
  ESM and CommonJS with `.d.ts`/`.d.cts` types. Needs Node ≥ 22.12.
  Output is typed `Bytes` (`Uint8Array<ArrayBuffer>`), so it goes straight
  into `new Blob([…])` and `new Response(…)`.
  Options are range-checked before the wasm runs (`compressionLevel` 0–8,
  `blockSize` 16–65535, `bitsPerSample` 4–32, `tags` a plain object) and
  fail with `INVALID_OPTIONS`. `encodeStream` never throws: every failure,
  including invalid options and aborts, errors the returned stream. In Node,
  `init()` accepts Windows drive paths such as `C:\\app\\wav2flac.wasm`.
  PCM stream chunks are checked against `pcm.format`, and a source stream is
  unlocked again once it ends. Detached input, also a buffer transferred by
  a concurrent worker job, gives a `TypeError`.
- Native `encode` example (used as the determinism reference and benchmark
  baseline).
- Vitest suite with V8 coverage for the TypeScript sources, including
  fast-check fuzz tests (random WAV specs, chunkings, transcode options,
  mutated/garbage input, random option objects and abort timing).
- Benchmark: a page (`npm run bench:serve`) comparing `encode()`,
  `encodeSync()` and a Web Worker (timing, max RSS, wasm/heap memory,
  longest main-thread block), plus Node and headless-Chromium CLIs
  (`npm run bench`, `npm run bench:browser`) with the native Rust build as
  baseline. Presets include a 5 s 16 kHz mono voice clip and 1 min of
  CD-quality audio. CI attaches the results to the job summary and an
  artifact.
- Benchmark part 2, raw PCM → FLAC: `--input pcm-int|pcm-f32` (and a page
  selector) encodes the presets' samples as integer typed arrays or as a
  Web Audio-style `Float32Array`; the native `encode` example takes
  `--pcm FORMAT:RATE:CHANNELS` for the baseline. CI runs both parts.
- Raw PCM input: the `pcm` option (`{ sampleRate, channels, format? }`) on
  `encode`, `encodeStream`, `encodeSync` and the worker. Accepts
  `Int16Array`/`Int32Array`/`Float32Array` (format inferred), one array per
  channel, raw bytes (`u8`, `s16`, `s24`, `s32`, `f32`) or a stream of them.
  The output is byte-identical to encoding the same samples as a WAV file.
  In Rust: `Encoder::new_pcm` with `PcmSpec`/`PcmFormat`.
- CI workflow: Rust tests, plus JS build, typecheck and coverage on Node 22/24/26,
  tests of the built package (ESM/CJS, worker script, consumer type checks),
  publint/attw and `cargo deny`; the full test tier runs nightly.
- `THIRD_PARTY_LICENSES.txt` in the package, generated at build time from the
  crates compiled into the wasm. Every JS bundle starts with an unminified
  `/*! @license */` comment that lists those crates and reproduces the
  BSD-3-Clause notice of libflac-rs (and the libFLAC copyrights it carries)
  and the MIT notices of the MIT-only crates and the Rust standard library.
- Browser smoke test of the packed package (`npm run test:browser`):
  unbundled, built with Vite and built with webpack, in Chromium, Firefox
  and WebKit; every output must match Node byte for byte. Each page also
  loads the wasm from a custom route with `init(url)`, and then no other
  wasm may be fetched, workers included. CI also checks
  that the package build is reproducible.
- Release workflow: pushing a `vX.Y.Z` tag checks the tag against every
  manifest and the changelog, runs the full CI suite, publishes to npm with
  provenance (prereleases under `next`) and creates a GitHub release with the
  tarball, the wasm and `SHA256SUMS`. `node scripts/release.ts prepare X.Y.Z`
  bumps the versions and dates the changelog.
- CI enforces `cargo fmt` and a 100-column limit on all Rust source lines.
- Documentation site on Read the Docs (MkDocs): the README plus the raw PCM
  and benchmark guides, at <https://wav2flac.readthedocs.io/>.

[Unreleased]: https://github.com/julianhille/wav2flac/compare/v1.0.0-rc.4...HEAD
[1.0.0-rc.4]: https://github.com/julianhille/wav2flac/compare/v1.0.0-rc.3...v1.0.0-rc.4
[1.0.0-rc.3]: https://github.com/julianhille/wav2flac/compare/v1.0.0-rc.2...v1.0.0-rc.3
[1.0.0-rc.2]: https://github.com/julianhille/wav2flac/compare/v1.0.0-rc.1...v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/julianhille/wav2flac/tree/v1.0.0-rc.1
