# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every version headline links to the diff against the previous release; the
links are collected at the bottom of this file.

## [Unreleased]

### Added

- README: a badge with the status of the docs build on Read the Docs. It links
  to the docs site.

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

[Unreleased]: https://github.com/julianhille/wav2flac/compare/v1.0.0-rc.2...HEAD
[1.0.0-rc.2]: https://github.com/julianhille/wav2flac/compare/v1.0.0-rc.1...v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/julianhille/wav2flac/tree/v1.0.0-rc.1
