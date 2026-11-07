<!-- SPDX-License-Identifier: 0BSD -->
# Cut a live recording into FLAC files

A recorder gets audio from the microphone at 48 or 44.1 kHz in small frames,
but you want 16 kHz, 16-bit FLAC, cut into separate files while the
recording goes on: one per utterance, or one every 5 seconds.

Calling `encode()` on each piece doesn't work well. Every call starts the
resampler afresh, so each file begins and ends with a filter edge, and the
lengths drift by a sample here and there. Joined together, the files click
at the seams and no longer match the recording.

`createChunkEncoder()` keeps one resampler for the whole recording and cuts
its output into files. Each file is a complete FLAC file with its own
STREAMINFO and MD5. Joined in order, the files hold exactly the samples that
one `encode()` of the whole recording gives with the same options, including
the dither. There are no seams, and no sample is lost or repeated.

## Get the frames from an AudioWorklet

A worklet sees the microphone in 128-sample frames. Post a copy of each one
to the main thread:

```js
// recorder-worklet.js, loaded with audioContext.audioWorklet.addModule()
class Recorder extends AudioWorkletProcessor {
  process(inputs) {
    const mono = inputs[0]?.[0];
    if (mono !== undefined) this.port.postMessage(mono.slice());
    return true;
  }
}
registerProcessor('recorder', Recorder);
```

For stereo, interleave the two channels (left, right, left, …) and pass
`channels: 2` below.

## Cut wherever you like

Without `chunkSamples`, each `encode()` call cuts one file of everything
since the last cut: at a pause, on a button press, or on a timer.

```js
import { createChunkEncoder } from 'wav2flac';

const enc = await createChunkEncoder({
  inputRate: audioContext.sampleRate, // 48000 or 44100
  sampleRate: 16000,
  bitsPerSample: 16,
  resampleQuality: 'fast',
});

worklet.port.onmessage = (e) => enc.push(e.data);

export function cut() {
  const flac = enc.encode(); // null when no sample is ready yet
  if (flac !== null) upload(flac);
}

export function stop() {
  const flac = enc.finish();
  if (flac !== null) upload(flac);
  enc.free();
}
```

The resampler holds back a little audio: up to 1024 input frames plus half the
filter, about 23 ms at 48 kHz with `'fast'` and 32 ms with `'best'` at 44.1
kHz, and longer at lower input rates (about 130–145 ms at 8 kHz). Those samples
go into the next file, or into the last one at `finish()`, so nothing is lost.
A cut therefore lands up to that much before the moment you call `encode()`.

## Files of exactly the same length

With `chunkSamples`, every file has exactly that many samples per channel,
at the output rate. Only the last one is shorter. `encode()` and `finish()`
return an array of the files that are ready, often none.

```js
import { createChunkEncoder } from 'wav2flac';

const enc = await createChunkEncoder({
  inputRate: audioContext.sampleRate,
  sampleRate: 16000,
  bitsPerSample: 16,
  resampleQuality: 'fast',
  chunkSamples: 5 * 16000, // 5 s per file
});

worklet.port.onmessage = (e) => {
  for (const flac of enc.encode(e.data)) upload(flac);
};

export function stop() {
  for (const flac of enc.finish()) upload(flac);
  enc.free();
}
```

## Get each file through a callback

Instead of reading the return values, you can pass `onChunk` together
with `chunkSamples`. Then the encoder has no `encode()`: `push()` hands each
file that is now full to `onChunk`, and `finish()` hands over the rest, in
order, before they return.

```js
import { createChunkEncoder } from 'wav2flac';

const enc = await createChunkEncoder({
  inputRate: audioContext.sampleRate,
  sampleRate: 16000,
  bitsPerSample: 16,
  resampleQuality: 'fast',
  chunkSamples: 5 * 16000, // 5 s per file
  onChunk: (flac) => {
    upload(flac).catch((e) => console.error('upload failed', e));
  },
});

worklet.port.onmessage = (e) => enc.push(e.data);

export function stop() {
  worklet.port.onmessage = null; // stop feeding the encoder
  enc.finish(); // calls onChunk for the rest
  enc.free();
}
```

`onChunk` runs synchronously, so keep it short and start slow work (an
upload) without waiting for it, catching its rejection as above. Don't
make it `async`: the encoder doesn't wait for it, and a rejection goes
unhandled instead of being logged (in TypeScript it is a type error). If
`onChunk` throws, the error is logged with `console.error` and the encoder
carries on with the next file. To upload in order, keep a promise `q` (start
with `Promise.resolve()`) and chain each upload in braces:
`onChunk: (flac) => { q = q.then(() => upload(flac)).catch(log); }`.

After `finish()`, even a failed one, `push()` drops the samples and logs a
warning with `console.warn`, so stop pushing first, as `stop()` does above.
Calling `push()`, `finish()` or `free()` from inside `onChunk` throws
`ENCODER_STATE`, and the encoder carries on.

## Only resample

To send 16 kHz samples somewhere yourself, for example to a speech API over
a WebSocket, use `createResampler()`. It returns `Int16Array`s, or
`Float32Array`s with `output: 'f32'`. However the input is split, the output
is the same, and with `'s16'` it is bit for bit what `encode()` writes for
`bitsPerSample: 16, dither: 'none'`.

```js
import { createResampler } from 'wav2flac';

const resampler = await createResampler({
  inputRate: audioContext.sampleRate,
  outputRate: 16000,
  quality: 'fast',
});

worklet.port.onmessage = (e) => {
  const samples = resampler.push(e.data);
  if (samples.length > 0) socket.send(samples);
};

export function stop() {
  socket.send(resampler.flush());
  resampler.free();
}
```

## Notes

- Call `free()` on every path, also after an error. It releases the wasm
  memory, and calling it twice does nothing.
- After `finish()`, `flush()` or a failed call, every other call fails
  with `ENCODER_STATE`, except as described above for `onChunk`. Create a
  new object for the next recording.
- Both run on the calling thread and take about 0.3 % of one core for
  48 → 16 kHz with `'fast'` and about 1.5 % with `'best'`
  (`npm run bench:stream`), so the main thread is fine.
- The chunk encoder takes the options of `encode()`, apart from `pcm`,
  `signal`, `onProgress`, `copy` and `maxInputBytes`. `bitsPerSample` is
  required, and `sampleRate` defaults to `inputRate`.
