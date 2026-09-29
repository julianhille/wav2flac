# wav2flac

[![npm version](https://img.shields.io/npm/v/wav2flac?logo=npm&label=npm)](https://www.npmjs.com/package/wav2flac)
[![npm next](https://img.shields.io/npm/v/wav2flac/next?logo=npm&label=next)](https://www.npmjs.com/package/wav2flac?activeTab=versions)
[![CI](https://github.com/julianhille/wav2flac/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/julianhille/wav2flac/actions/workflows/ci.yml)
[![Memory checks](https://github.com/julianhille/wav2flac/actions/workflows/nightly.yml/badge.svg?branch=main)](https://github.com/julianhille/wav2flac/actions/workflows/nightly.yml)
[![Release](https://github.com/julianhille/wav2flac/actions/workflows/release.yml/badge.svg)](https://github.com/julianhille/wav2flac/actions/workflows/release.yml)
[![Docs](https://readthedocs.org/projects/wav2flac/badge/?version=latest)](https://wav2flac.readthedocs.io/en/latest/)
[![License: 0BSD](https://img.shields.io/badge/license-0BSD-blue.svg)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/wav2flac.svg)](https://www.npmjs.com/package/wav2flac)
[![wasm size](https://img.shields.io/bundlephobia/minzip/wav2flac?label=js%20min%2Bgzip)](https://bundlephobia.com/package/wav2flac)

Convert **WAV to FLAC** in the browser and in Node.js — a Rust encoder
([flacenc](https://crates.io/crates/flacenc) + [hound](https://crates.io/crates/hound))
compiled to **WebAssembly**, with optional **resampling** and **bit-depth
conversion**. One package, ESM and CommonJS, fully typed.

- 📦 `npm install wav2flac` — [npmjs.com/package/wav2flac](https://www.npmjs.com/package/wav2flac)
- 📖 Docs & how-tos: [wav2flac.readthedocs.io](https://wav2flac.readthedocs.io/)
- 📝 [Changelog](CHANGELOG.md)

## Quick start

```js
import { encode } from 'wav2flac';

const wav = new Uint8Array(await (await fetch('/voice.wav')).arrayBuffer());
const flac = await encode(wav, { compressionLevel: 5 });
```

```js
// CommonJS
const { initSync, encodeSync } = require('wav2flac');
initSync();
const flac = encodeSync(require('node:fs').readFileSync('in.wav'));
```

Streaming, off the main thread, with transcoding:

```js
import { createWorkerEncoder } from 'wav2flac';

const enc = createWorkerEncoder();
const flacStream = enc.encodeStream(response.body, {
  sampleRate: 48000,      // resample
  bitsPerSample: 16,      // reduce bit depth (TPDF dither)
  onProgress: (p) => console.log(p.fraction),
  signal: AbortSignal.timeout(60_000),
});
```

Input is always `Uint8Array`, `ArrayBuffer` or `ReadableStream<Uint8Array>`;
there is no file-system API, so the same code runs in browsers, Node ≥ 20,
Deno and Bun.

### Raw PCM

No WAV header? Describe the samples with `pcm` and pass them straight in —
e.g. 16 kHz mono `Float32Array` from an AudioWorklet or `AudioBuffer`:

```js
const flac = await encode(samples, {
  pcm: { sampleRate: 16000, channels: 1 }, // Float32Array → format 'f32'
  bitsPerSample: 16,                       // float needs a target depth
});
```

Interleaved typed arrays, one array per channel, raw bytes (with
`pcm.format`) and streams all work, on every API. See [docs/pcm.md](docs/pcm.md).

## Features

- Lossless by default (8/16/24-bit PCM, 1–8 channels); bit-exact round trips.
- WAV files or raw PCM (`Int16Array`, `Float32Array`, planar channel arrays, bytes, streams).
- Promise API, `ReadableStream` API, sync API, and Web Worker / `worker_threads` API.
- Resampling (rubato, sinc) and bit-depth reduction with deterministic TPDF dither.
- Correct STREAMINFO (sample count + MD5), SEEKTABLE, Vorbis comments from WAV
  `LIST/INFO` tags, channel-mask preservation for surround files.
- Progress callbacks, `AbortSignal` cancellation, SIMD build with automatic fallback.

## Benchmark

`npm run bench:serve` opens a benchmark page. It compares `encode()`,
`encodeSync()` and a Web Worker (timing, memory, main-thread blocking), in
your browser or in Node against the native Rust build. `npm run bench` and
`npm run bench:browser` run the same benchmark from the command line, and CI
runs them on every push. See [docs/benchmark.md](docs/benchmark.md).

## License

**0BSD** — do whatever you want, no conditions, no warranty.
The compiled `.wasm` contains Apache-2.0/MIT code from third-party crates; their
notices are shipped in [`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt).
Redistributing the package folder unchanged is all you need to do. See the
[licensing how-to](https://wav2flac.readthedocs.io/en/latest/how-to/licensing/).
