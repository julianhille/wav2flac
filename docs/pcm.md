<!-- SPDX-License-Identifier: 0BSD -->
# Encoding raw PCM

`encode`, `encodeStream`, `encodeSync` and the worker encoder accept raw
samples when you pass a `pcm` option. You don't need a WAV header. The
samples go through the same engine as a WAV file, so the output is
byte-identical to encoding the same samples wrapped in a WAV. It is
lossless, the same however the input is chunked, and carries an exact
STREAMINFO and MD5.

```ts
interface PcmFormat {
  sampleRate: number; // Hz, 1–1 048 575 (higher only with a target sampleRate)
  channels: number;   // 1–8
  format?: 'u8' | 's16' | 's24' | 's32' | 'f32'; // inferred from typed arrays
}
```

## Input shapes

| Input | Format |
|---|---|
| `Int16Array` | `s16` (inferred) |
| `Int32Array` | `s32` (inferred) |
| `Float32Array` | `f32` (inferred) |
| `Int16Array[]` / `Int32Array[]` / `Float32Array[]`, one array per channel | inferred; interleaved for you |
| `Uint8Array` / `ArrayBuffer` | `pcm.format` required |
| `ReadableStream` of `Uint8Array`, `DataView` or `ArrayBuffer` chunks, or of the typed array matching `pcm.format` | `pcm.format` required |

- Samples are **interleaved** (`L R L R …`) and little-endian.
- `u8` is unsigned (as in WAV). `s24` is packed 3 bytes per sample.
- `f32` is nominally in −1…1. Values beyond that are clipped.
- Chunks of a stream may split samples anywhere. A stream that ends in the
  middle of a sample frame fails with `TRUNCATED`.
- A buffer whose length isn't a whole number of sample frames fails with
  `INVALID_OPTIONS`. So does a typed array that contradicts `pcm.format`.

## Web Audio

```js
import { encode } from 'wav2flac';

// AudioBuffer → FLAC: planar channels, float samples.
const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
const flac = await encode(channels, {
  pcm: { sampleRate: buf.sampleRate, channels: buf.numberOfChannels },
  bitsPerSample: 24,
});
```

## Bit depth and dither

Integer input (`u8`, `s16`, `s24`, `s32`) is stored losslessly by default.
**Float input needs `bitsPerSample`**, as for float WAV files, so precision
is never lost silently. Reducing the depth applies TPDF dither unless you
pass `dither: 'none'`. Turn dither off when the floats came from integers
and you need those exact integers back:

```js
// Float32Array of 16 kHz mono made from Int16 values (v / 32768).
const flac = await encode(samples, {
  pcm: { sampleRate: 16000, channels: 1 },
  bitsPerSample: 16,
  dither: 'none',
});
```

`sampleRate` in the options resamples, exactly as for WAV input.

## Progress

For buffers, `onProgress` reports a `fraction` from 0 to 1. A stream has no
known length, so `fraction` is `null`. `samplesOut` still counts up.

## Rust

```rust
use wav2flac::{Encoder, Options, PcmFormat, PcmSpec};

let spec = PcmSpec { format: PcmFormat::S16, channels: 2, sample_rate: 44_100 };
let mut enc = Encoder::new_pcm(Options::default(), spec, Some(pcm.len() as u64))?;
```

Pass `None` as the total for an unknown length (streams).
