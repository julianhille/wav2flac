// SPDX-License-Identifier: 0BSD
/**
 * Live-recording benchmark: CPU time of the stateful resampler and the chunk
 * encoder as a share of one core in real time, for audio pushed in small
 * frames as an AudioWorklet delivers it.
 *
 * ```sh
 * node bench/stream-bench.ts --seconds 600 --frame 128 --rate 48000 --quality fast
 * ```
 * @module
 */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

/** Entry of the built package. */
const PKG = fileURLToPath(new URL('../pkg/esm/index.js', import.meta.url));

const { values } = parseArgs({
  options: {
    seconds: { type: 'string', default: '600' },
    frame: { type: 'string', default: '128' },
    rate: { type: 'string', default: '48000' },
    quality: { type: 'string', default: 'fast' },
    cut: { type: 'string', default: '5' },
  },
});
const seconds = Number(values.seconds);
const frame = Number(values.frame);
const rate = Number(values.rate);
const quality = values.quality as 'fast' | 'balanced' | 'best';
const cutEvery = Math.round((Number(values.cut) * rate) / frame);

const api = (await import(PKG)) as typeof import('../ts/index.ts');
await api.init();

// One second of signal, reused: two tones and a little noise.
const second = new Float32Array(rate);
for (let i = 0; i < rate; i++) {
  second[i] =
    0.4 * Math.sin((2 * Math.PI * 440 * i) / rate) +
    0.3 * Math.sin((2 * Math.PI * 1370 * i) / rate) +
    0.02 * (Math.random() * 2 - 1);
}
const frames = Math.floor(rate / frame);
// Seconds of audio actually pushed: each second drops the frames that do not fit.
const audio = (seconds * frames * frame) / rate;

/**
 * Pushes `seconds` of audio in `frame`-sized pieces and measures CPU time.
 * @param push Called per frame with the frame and its index.
 * @param end Called once at the end.
 * @returns CPU milliseconds.
 */
function measure(push: (x: Float32Array, i: number) => void, end: () => void): number {
  const start = process.cpuUsage();
  let n = 0;
  for (let s = 0; s < seconds; s++) {
    for (let f = 0; f < frames; f++) push(second.subarray(f * frame, (f + 1) * frame), n++);
  }
  end();
  const d = process.cpuUsage(start);
  return (d.user + d.system) / 1000;
}

const results: [string, number][] = [];

const r = await api.createResampler({ inputRate: rate, outputRate: 16000, quality });
try {
  results.push([
    `resampler ${rate} → 16000 ${quality}, s16`,
    measure(
      (x) => r.push(x),
      () => r.flush(),
    ),
  ]);
} finally {
  r.free();
}

const enc = await api.createChunkEncoder({
  inputRate: rate,
  sampleRate: 16000,
  bitsPerSample: 16,
  resampleQuality: quality,
});
let files = 0;
try {
  results.push([
    `chunk encoder, a file every ${values.cut} s`,
    measure(
      (x, i) => {
        enc.push(x);
        if (i % cutEvery === cutEvery - 1 && enc.encode() !== null) files++;
      },
      () => {
        if (enc.finish() !== null) files++;
      },
    ),
  ]);
} finally {
  enc.free();
}

console.log(`${audio.toFixed(1)} s of audio in ${frame}-frame pushes (${files} files)`);
for (const [label, ms] of results) {
  const pct = (ms / (audio * 1000)) * 100;
  console.log(`${label}: ${ms.toFixed(0)} ms CPU = ${pct.toFixed(3)} % of one core`);
}
