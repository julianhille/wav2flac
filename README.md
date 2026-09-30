# wav2flac

[![npm version](https://img.shields.io/npm/v/wav2flac?logo=npm&label=npm)](https://www.npmjs.com/package/wav2flac)
[![CI](https://github.com/julianhille/wav2flac/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/julianhille/wav2flac/actions/workflows/ci.yml)
[![Docs](https://app.readthedocs.org/projects/wav2flac/badge/?version=latest)](https://wav2flac.readthedocs.io/)
[![License: 0BSD](https://img.shields.io/badge/license-0BSD-blue.svg)](https://github.com/julianhille/wav2flac/blob/main/LICENSE)

**Turn WAV files or raw audio samples into FLAC, in the browser or in
Node.js.** No native modules, no ffmpeg, no server round trip. The package is
one small WebAssembly encoder (~90 KB gzipped) plus typed JavaScript. The
encoder is a bit-exact Rust port of libFLAC 1.4.3. It runs in Chrome,
Firefox, Safari, Node ≥ 22.12, Deno, Bun and workers.

```js
import { encode } from 'wav2flac';

const flac = await encode(wavBytes); // Uint8Array in, Uint8Array (a .flac file) out
```

## What it can do

- **Lossless WAV → FLAC.** 8/16/24/32-bit integer PCM, 1–8 channels, any
  sample rate up to 1 048 575 Hz. Decoding the FLAC gives back exactly the
  same samples.
- **Raw PCM → FLAC.** Pass a `Float32Array` from Web Audio or an
  AudioWorklet, an `Int16Array`, one array per channel, or raw bytes. You
  don't need to build a WAV header.
- **Convert while encoding.**
  - Resample to another sample rate (e.g. 48 kHz → 16 kHz for speech).
  - Reduce the bit depth (e.g. float or 24-bit → 16-bit), with dither.
- **Any input size, bounded memory.** Input can be a buffer or a
  `ReadableStream` (a `fetch` body, a file stream). The output can be one
  buffer or a stream. Streaming never holds the whole file in memory.
- **Off the main thread.** `createWorkerEncoder()` runs the same API in a Web
  Worker, or in `worker_threads` in Node. The async `encode()` also yields
  regularly, so a UI stays responsive.
- **Proper FLAC files.**
  - Exact sample count and MD5 in STREAMINFO.
  - A seek table.
  - WAV `LIST/INFO` tags become Vorbis comments, and you can add your own.
  - Surround channel layouts are preserved.
- **Production details.** Progress callbacks, `AbortSignal` cancellation,
  input-size limits, stable error codes, ESM + CommonJS, TypeScript types.
  The output is deterministic: the same input and options give the same
  bytes, however the input is chunked.
- **Zero dependencies.** `npm install wav2flac` installs just this package:
  JS bundles, types and one `.wasm` file. In Node it uses only built-in
  modules.
- **Fast.** One minute of CD-quality stereo encodes in ~0.3 s (~200×
  realtime) with ~2 MiB of wasm memory, about 70 % of native Rust speed.
  Measured on an Intel Core Ultra 9 185H, Node 22, level 5.

## Install

```sh
npm install wav2flac
```

The type declarations need TypeScript 5.7 or newer: they use the
`Uint8Array<ArrayBuffer>` form of the typed arrays.

The wasm binary is found automatically: next to the JS in Node, and via
`new URL(…, import.meta.url)` in browsers and in bundlers such as Vite and
webpack. To host it yourself, call `init(urlOrBytes)` first. The binary
carries the license notices of the code in it (see [License](#license)), so
host it as it is. To give up
on a download that stalls, pass a signal:
`init(url, { signal: AbortSignal.timeout(10_000) })`. See the
[loading guide](https://github.com/julianhille/wav2flac/blob/main/docs/loading.md).

## Usage

### A WAV file in the browser

```js
import { encode } from 'wav2flac';

const wav = new Uint8Array(await file.arrayBuffer()); // e.g. from <input type="file">
const flac = await encode(wav);
const url = URL.createObjectURL(new Blob([flac], { type: 'audio/flac' }));
```

### Node.js

```js
import { readFile, writeFile } from 'node:fs/promises';
import { encode } from 'wav2flac';

await writeFile('out.flac', await encode(await readFile('in.wav')));
```

```js
// CommonJS, synchronous
const { initSync, encodeSync } = require('wav2flac');
initSync();
const flac = encodeSync(require('node:fs').readFileSync('in.wav'));
```

### Large files: stream in, stream out

```js
import { encodeStream } from 'wav2flac';

const res = await fetch('/recording.wav');
const flacStream = encodeStream(res.body); // ReadableStream<Uint8Array>
await flacStream.pipeTo(writable);         // e.g. a file or an upload
```

Streamed output writes the header first, before the end of the audio is
known. It therefore has no seek table, and no sample count or MD5, and it
drops `LIST/INFO` tags stored after the audio data. Players handle this fine.
Use `encode()` when you need them.

### Raw samples (Web Audio, AudioWorklet, microphone)

```js
// Mono Float32Array at 16 kHz, e.g. collected from an AudioWorklet
const flac = await encode(samples, {
  pcm: { sampleRate: 16000, channels: 1 }, // Float32Array → float samples
  bitsPerSample: 16,                       // float must be converted to integers
});

// An AudioBuffer: pass one array per channel
const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
const flac2 = await encode(channels, {
  pcm: { sampleRate: buf.sampleRate, channels: buf.numberOfChannels },
  bitsPerSample: 24,
});
```

| PCM input | Sample format |
|---|---|
| `Int16Array`, `Int32Array`, `Float32Array` (interleaved) | inferred |
| An array of those, one per channel | inferred; interleaved for you |
| `Uint8Array`, `ArrayBuffer` or a `ReadableStream` of bytes | `pcm.format`: `'u8'`, `'s16'`, `'s24'`, `'s32'` or `'f32'` |

More in the [PCM guide](https://github.com/julianhille/wav2flac/blob/main/docs/pcm.md).

### Off the main thread, with transcoding, progress and cancel

```js
import { createWorkerEncoder } from 'wav2flac';

const enc = createWorkerEncoder();          // Web Worker / worker_threads
const flac = await enc.encode(wav, {
  sampleRate: 16000,                        // resample
  bitsPerSample: 16,                        // reduce bit depth (TPDF dither)
  compressionLevel: 8,
  onProgress: (p) => (bar.value = p.fraction ?? 0),
  signal: AbortSignal.timeout(30_000),
});
enc.terminate();
```

Buffers passed to a worker are *transferred* by default, which detaches your
copy, also when the job fails. Pass `copy: true` to keep it, for example to
retry with other options.

Several calls on one thread take turns rather than run in parallel. For real
parallelism use several workers; see
[concurrent encodes](https://github.com/julianhille/wav2flac/blob/main/docs/concurrency.md),
the [worker pool](https://github.com/julianhille/wav2flac/blob/main/docs/how-to/parallel-encoding.md)
and the [FIFO queue](https://github.com/julianhille/wav2flac/blob/main/docs/how-to/fifo-queue.md).

### Inspect a WAV without encoding

```js
import { probe } from 'wav2flac';

const info = await probe(wav);
// { sampleRate: 44100, channels: 2, bitsPerSample: 16, format: 'int',
//   frames: 2646000, durationSec: 60, channelMask: null, tags: { TITLE: '…' } }
```

## API

| Function | Does |
|---|---|
| `encode(input, options?)` | → `Promise<Uint8Array>`. Buffered FLAC with seek table and MD5; yields to the event loop while it works. |
| `encodeStream(input, options?)` | → `ReadableStream<Uint8Array>`. Header first, then frames as you read. |
| `encodeSync(input, options?)` | → `Uint8Array`. Blocks the thread; needs `init()`/`initSync()` first. |
| `createWorkerEncoder(opts?)` | → `{ encode, encodeStream, probe, wasmMemoryBytes, terminate }` running in a worker. `opts`: `{ url?, wasm? }`, the worker script and the wasm source. |
| `probe(input)` | → `Promise<WavInfo>`. Reads the WAV header only. |
| `init(source?, { signal? })` / `initSync(source?)` | Loads the wasm. `encode`, `encodeStream`, `probe` and the worker encoder do this for you. A `signal` (e.g. `AbortSignal.timeout(10_000)`) gives up on a stalled download. Once every caller waiting on the load has given up, or the load failed, the next call retries: from its own source, or else from the last one; a caller without a signal, such as `probe()`, keeps the load going. |
| `version()` | The encoder's version string. |
| `thirdPartyLicenses()` | → `Promise<string>`. The license notices of the crates in the wasm, as Markdown. Needs the wasm loaded: it rejects before `init()` has finished, and never loads it itself. |
| `wasmMemoryBytes()` | Size of the wasm linear memory in bytes (for diagnostics and leak checks). |

`input` is a `Uint8Array`, an `ArrayBuffer` or a `ReadableStream<Uint8Array>`
of a WAV file, or raw PCM when `options.pcm` is set.

Every function, option and type is described in the
[API reference](https://wav2flac.readthedocs.io/en/latest/reference/api/),
generated from the TSDoc in the source.

### Options

| Option | Default | |
|---|---|---|
| `compressionLevel` | `5` | 0 (fastest) – 8 (smallest), the libFLAC presets |
| `blockSize` | per level | samples per frame, 16–65535 |
| `sampleRate` | input rate | resample to this rate |
| `resampleQuality` | `'balanced'` | `'fast'`, `'balanced'` or `'best'` |
| `bitsPerSample` | input depth | 4–32; **required for float input** |
| `dither` | `'tpdf'` | `'tpdf'` or `'none'`; used when samples are requantized (lower bit depth, float input or resampling) |
| `ditherSeed` | fixed | the dither is seeded, so the output is deterministic |
| `pcm` | – | `{ sampleRate, channels, format? }`: the input is raw samples |
| `tags` | – | `{ TITLE: '…' }` adds or overrides Vorbis comments; `false` writes none |
| `seekPointInterval` | `10` | seconds between seek points, `0` for none (buffered output only) |
| `padding` | `8192` | bytes reserved for later tag edits |
| `maxInputBytes` | unlimited | larger input fails with `LIMIT_EXCEEDED` |
| `onProgress` | – | `({ bytesIn, samplesOut, fraction })`, called at most ~20×/s |
| `signal` | – | an `AbortSignal`; aborting cancels the job and frees its memory |
| `copy` | `false` | worker only: copy the input instead of transferring it |

### Errors

Problems with the audio or the options throw (sync) or reject (async) with a
`Wav2FlacError`. Its `code` is one of:
`INVALID_WAV`, `UNSUPPORTED_FORMAT`, `UNSUPPORTED_BIT_DEPTH`,
`TOO_MANY_CHANNELS`, `TRUNCATED`, `INVALID_OPTIONS`, `LIMIT_EXCEEDED`,
`ENCODER_STATE`, `INTERNAL`.

Other failures keep their own type:

- an input of the wrong type (or one detached by an earlier worker call) gives a `TypeError`;
- an abort rejects with the signal's `reason`, by default a `DOMException` named `AbortError`;
- an error from your input stream is passed through unchanged;
- a worker that crashes or can't load rejects its pending calls with a plain `Error`.

Formats that aren't PCM (A-law, µ-law, ADPCM) and RF64 are rejected with a
clear message. Nothing is ever converted lossily unless you ask for it.

## Guides

- [Raw PCM input](https://github.com/julianhille/wav2flac/blob/main/docs/pcm.md)
- [Concurrent encodes](https://github.com/julianhille/wav2flac/blob/main/docs/concurrency.md): what happens when you start several at once
- [Bundling and license notices](https://github.com/julianhille/wav2flac/blob/main/docs/bundling.md): what your build must keep
- How-to guides ([all](https://github.com/julianhille/wav2flac/blob/main/docs/how-to/index.md)):
  - [Encode in parallel with a worker pool](https://github.com/julianhille/wav2flac/blob/main/docs/how-to/parallel-encoding.md)
  - [Encode one at a time with a FIFO queue](https://github.com/julianhille/wav2flac/blob/main/docs/how-to/fifo-queue.md)
  - [Load from a CDN without a bundler](https://github.com/julianhille/wav2flac/blob/main/docs/how-to/load-from-cdn.md)

## Benchmark

Clone the repo and run `npm run bench:serve` to compare `encode()`,
`encodeSync()` and a worker in your own browser. `npm run bench` does the
same in Node and adds the native Rust build to the comparison. See
[docs/benchmark.md](https://github.com/julianhille/wav2flac/blob/main/docs/benchmark.md).

## License

**0BSD**: use it for anything, with no conditions and no attribution. There
is no warranty. The compiled `.wasm` also contains permissively licensed Rust
crates: libflac-rs (BSD-3-Clause), hound (Apache-2.0), and rubato and others
(MIT or Apache-2.0). It also contains the parts of the Rust standard library
they use: MIT or Apache-2.0, Unicode-3.0 for the Unicode tables in `core`,
and Apache-2.0 with the LLVM exception for `compiler_builtins`. If you
redistribute the `.wasm`, keep their notices.

`wav2flac.wasm` carries their notices in full: its first section, which
engines ignore, holds the text of `THIRD_PARTY_LICENSES.txt` uncompressed,
so `head -c 3000 wav2flac.wasm` shows it as the first lines of the file.
`thirdPartyLicenses()` returns it, as does
`WebAssembly.Module.customSections(module, 'license')`. Bundlers copy the
wasm as it is, so the notices go wherever the wasm goes. The package also has
the text as a file, `pkg/THIRD_PARTY_LICENSES.txt` (`wav2flac/THIRD_PARTY_LICENSES.txt`). See
[Bundling and license
notices](https://github.com/julianhille/wav2flac/blob/main/docs/bundling.md).

The [third-party components](https://github.com/julianhille/wav2flac/blob/main/docs/third-party.md)
page lists every crate with its version, license and source.

[Changelog](https://github.com/julianhille/wav2flac/blob/main/CHANGELOG.md) ·
[Source](https://github.com/julianhille/wav2flac) ·
[Issues](https://github.com/julianhille/wav2flac/issues)
