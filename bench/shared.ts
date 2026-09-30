// SPDX-License-Identifier: 0BSD
/**
 * Benchmark definitions shared by the browser page, the Node runner and the
 * CI scripts: input presets, configuration, result shapes and statistics.
 * @module
 */
import type { Options, PcmFormat, PcmSampleFormat } from '../ts/index.js';
import { makeWav } from '../tests/helpers/wav.ts';

/** A generated benchmark input. */
export interface Preset {
  /** Stable id (used in URLs, CLI flags and reports). */
  id: string;
  /** Human-readable description. */
  label: string;
  /** Duration in seconds. */
  seconds: number;
  /** Sample rate in Hz. */
  rate: number;
  /** Channels. */
  channels: number;
  /** Bits per sample. */
  bits: 16 | 24;
}

/** The inputs every runner knows. Generated deterministically (music-like signal). */
export const PRESETS: readonly Preset[] = [
  {
    id: 'voice',
    label: '5 s · 16 kHz · 16-bit · mono',
    seconds: 5,
    rate: 16000,
    channels: 1,
    bits: 16,
  },
  {
    id: 'cd',
    label: '1 min · 44.1 kHz · 16-bit · stereo (CD)',
    seconds: 60,
    rate: 44100,
    channels: 2,
    bits: 16,
  },
  {
    id: 'short',
    label: '10 s · 44.1 kHz · 16-bit · stereo',
    seconds: 10,
    rate: 44100,
    channels: 2,
    bits: 16,
  },
  {
    id: 'song',
    label: '3 min · 44.1 kHz · 16-bit · stereo',
    seconds: 180,
    rate: 44100,
    channels: 2,
    bits: 16,
  },
  {
    id: 'hires',
    label: '1 min · 96 kHz · 24-bit · stereo',
    seconds: 60,
    rate: 96000,
    channels: 2,
    bits: 24,
  },
  {
    id: 'surround',
    label: '1 min · 48 kHz · 24-bit · 5.1',
    seconds: 60,
    rate: 48000,
    channels: 6,
    bits: 24,
  },
  {
    id: 'long',
    label: '10 min · 44.1 kHz · 16-bit · stereo',
    seconds: 600,
    rate: 44100,
    channels: 2,
    bits: 16,
  },
];

/** Optional transcoding applied during the benchmark. */
export type Transcode = 'none' | 'resample-48k' | 'to-16bit';

/**
 * What is handed to the encoder.
 * - `wav`: the WAV file (`Uint8Array`).
 * - `pcm-int`: its samples as raw integer PCM: `Int16Array` / `Int32Array`,
 *   or bytes with `pcm.format` for 8- and 24-bit.
 * - `pcm-f32`: its samples as a `Float32Array` (what Web Audio delivers),
 *   converted back to the source bit depth.
 */
export type InputKind = 'wav' | 'pcm-int' | 'pcm-f32';

/** Human-readable input kinds. */
export const INPUT_LABEL: Readonly<Record<InputKind, string>> = {
  wav: 'WAV file',
  'pcm-int': 'raw PCM, integer',
  'pcm-f32': 'raw PCM, Float32Array',
};

/** How the encoder runs. */
export type Mode =
  /** `encode()` on the calling thread; yields between chunks. */
  | 'main'
  /** `encodeSync()` on the calling thread; blocks it. */
  | 'sync'
  /** `createWorkerEncoder().encode()`: Web Worker / worker_threads. */
  | 'worker'
  /** The native Rust build (`examples/encode`), Node runner only. */
  | 'native'
  /** Another library: libav.js (FFmpeg's FLAC encoder; its own worker in browsers). See `competitors.ts`. */
  | 'libav'
  /** Another library: libflac.js (the reference libFLAC, on the calling thread). */
  | 'libflac';

/** Human-readable mode names. */
export const MODE_LABEL: Readonly<Record<Mode, string>> = {
  main: 'Main thread (encode)',
  sync: 'Main thread (encodeSync)',
  worker: 'Worker',
  native: 'Native Rust (baseline)',
  libav: 'libav.js (FFmpeg)',
  libflac: 'libflac.js (libFLAC)',
};

/** Modes that run another library instead of wav2flac. */
export const COMPETITORS: readonly Mode[] = ['libav', 'libflac'];

/**
 * Why a configuration can't run another library, if it can't.
 * @param c The configuration.
 * @returns The reason, or `null`.
 */
export function competitorUnsupported(c: BenchConfig): string | null {
  return c.transcode === 'none' ? null : 'not benchmarked with transcoding (wav2flac only)';
}

/** One benchmark configuration. */
export interface BenchConfig {
  /** Timed runs per mode. */
  runs: number;
  /** Preset id. */
  preset: string;
  /** Compression level 0–8. */
  level: number;
  /** WAV file or raw PCM samples. */
  input: InputKind;
  /** `buffer` = `encode()`, `stream` = `encodeStream()` (not for `sync`). */
  output: 'buffer' | 'stream';
  /** Optional transcoding. */
  transcode: Transcode;
  /** Modes to compare. */
  modes: Mode[];
  /** Run one untimed warm-up per mode first. */
  warmup: boolean;
}

/** Default configuration. */
export const DEFAULT_CONFIG: BenchConfig = {
  runs: 5,
  preset: 'song',
  level: 5,
  input: 'wav',
  output: 'buffer',
  transcode: 'none',
  modes: ['main', 'sync', 'worker'],
  warmup: true,
};

/** Measurements of one run. `null` = not observable in this environment. */
export interface RunSample {
  /** Wall time of the encode, ms. */
  ms: number;
  /** FLAC bytes produced. */
  outBytes: number;
  /** Longest main-thread / event-loop stall during the run, ms. */
  maxBlockMs: number | null;
  /** Peak resident set size of the process, KiB (Node, native). */
  maxRssKb: number | null;
  /** Resident set size just before the encode, KiB (Node). */
  baseRssKb: number | null;
  /** WebAssembly memory of the instance that encoded, bytes. */
  wasmBytes: number | null;
  /** Peak JS heap sampled during the run, bytes (Node; Chrome's `performance.memory`). */
  heapBytes: number | null;
}

/** Aggregated results of one mode. */
export interface ModeResult {
  /** The mode. */
  mode: Mode;
  /** Per-run samples. */
  samples: RunSample[];
  /** Worker/process start-up time, ms, if applicable. */
  startupMs: number | null;
  /** `performance.measureUserAgentSpecificMemory()` after the runs, bytes (cross-origin isolated browsers). */
  uaMemoryBytes: number | null;
  /** Error message if the mode failed. */
  error: string | null;
}

/** A full benchmark report. */
export interface BenchReport {
  /** Where it ran, e.g. `Chrome 153` or `Node 22.22.0 (linux x64)`. */
  environment: string;
  /** Package version string. */
  version: string;
  /** The configuration. */
  config: BenchConfig;
  /** Description of the input (preset label or file name). */
  inputLabel: string;
  /** Input size, bytes. */
  inputBytes: number;
  /** Input duration, seconds. */
  inputSeconds: number;
  /** ISO timestamp. */
  date: string;
  /** Results per mode, in `config.modes` order. */
  results: ModeResult[];
}

/**
 * Looks up a preset.
 * @param id Preset id.
 * @returns The preset.
 * @throws {Error} For unknown ids.
 */
export function preset(id: string): Preset {
  const p = PRESETS.find((x) => x.id === id);
  if (p === undefined)
    throw new Error(`unknown preset "${id}" (${PRESETS.map((x) => x.id).join(', ')})`);
  return p;
}

/**
 * Generates a preset's WAV file.
 * @param p The preset.
 * @returns WAV bytes.
 */
export function presetWav(p: Preset): Uint8Array<ArrayBuffer> {
  return makeWav({
    frames: p.seconds * p.rate,
    rate: p.rate,
    channels: p.channels,
    bits: p.bits,
    signal: 'music',
    seed: 7,
  });
}

/** The encoder input derived from a WAV for an {@link InputKind}. */
export interface EncoderInput {
  /** What is passed to `encode()`. */
  data:
    | Uint8Array<ArrayBuffer>
    | Int16Array<ArrayBuffer>
    | Int32Array<ArrayBuffer>
    | Float32Array<ArrayBuffer>;
  /** The `pcm` option, for raw PCM. */
  pcm?: Required<PcmFormat>;
  /** Target bit depth the input needs (float or 32-bit input), unless transcoding sets one. */
  bits?: number;
}

/**
 * Finds a RIFF chunk of a WAV.
 * @param wav WAV bytes.
 * @param id Chunk id.
 * @returns Offset and length of the chunk body.
 * @throws {Error} If it is missing.
 */
function chunk(wav: Uint8Array, id: string): { offset: number; length: number } {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  for (let o = 12; o + 8 <= wav.length;) {
    const name = String.fromCharCode(...wav.subarray(o, o + 4));
    const length = v.getUint32(o + 4, true);
    if (name === id) return { offset: o + 8, length: Math.min(length, wav.length - o - 8) };
    o += 8 + length + (length & 1);
  }
  throw new Error(`WAV has no ${id} chunk`);
}

/**
 * Reads the `fmt ` chunk of a WAV.
 * @param wav WAV bytes.
 * @returns Format tag (the subformat for WAVE_FORMAT_EXTENSIBLE), channels, rate and bits.
 * @throws {Error} If there is no `fmt ` chunk.
 */
function wavFormat(wav: Uint8Array): {
  tag: number;
  channels: number;
  sampleRate: number;
  bits: number;
} {
  const fmt = chunk(wav, 'fmt ');
  const f = new DataView(wav.buffer, wav.byteOffset + fmt.offset, fmt.length);
  let tag = f.getUint16(0, true);
  if (tag === 0xfffe && fmt.length >= 26) tag = f.getUint16(24, true);
  return {
    tag,
    channels: f.getUint16(2, true),
    sampleRate: f.getUint32(4, true),
    bits: f.getUint16(14, true),
  };
}

/**
 * Turns a WAV into the encoder input for an {@link InputKind}. Done before
 * timing: it stands for samples the caller already has in memory.
 * @param wav WAV bytes (plain PCM or float, not WAVE_FORMAT_EXTENSIBLE-only layouts).
 * @param kind Input kind.
 * @returns The input.
 * @throws {Error} For WAVs that can't be expressed as raw PCM of that kind.
 */
export function encoderInput(wav: Uint8Array<ArrayBuffer>, kind: InputKind): EncoderInput {
  if (kind === 'wav') {
    // Float and 32-bit integer WAVs need an explicit target depth, like raw PCM.
    let deep = false;
    try {
      const { tag, bits } = wavFormat(wav);
      deep = tag === 3 || bits > 24;
    } catch {
      // Not parseable here; let the encoder report it.
    }
    return deep ? { data: wav, bits: 24 } : { data: wav };
  }
  const { tag, channels, sampleRate, bits } = wavFormat(wav);
  const float = tag === 3;
  if ((tag !== 1 && !float) || (float && bits !== 32) || ![8, 16, 24, 32].includes(bits)) {
    throw new Error(
      `raw PCM input needs 8/16/24/32-bit integer or 32-bit float WAV, not format ${tag}/${bits}-bit`,
    );
  }
  const d = chunk(wav, 'data');
  const bytes = wav.slice(d.offset, d.offset + d.length - (d.length % ((bits / 8) * channels)));
  const format: PcmSampleFormat = float
    ? 'f32'
    : bits === 8
      ? 'u8'
      : bits === 16
        ? 's16'
        : bits === 24
          ? 's24'
          : 's32';
  const n = bytes.length / (bits / 8);
  if (kind === 'pcm-int') {
    if (float) throw new Error('pcm-int needs an integer WAV');
    const data =
      format === 's16'
        ? new Int16Array(bytes.buffer, 0, n)
        : format === 's32'
          ? new Int32Array(bytes.buffer, 0, n)
          : bytes;
    return { data, pcm: { sampleRate, channels, format } };
  }
  let out: Float32Array<ArrayBuffer>;
  if (float) {
    out = new Float32Array(bytes.buffer, 0, n);
  } else {
    out = new Float32Array(n);
    const b = new DataView(bytes.buffer);
    const scale = 1 / 2 ** (bits - 1);
    for (let i = 0; i < n; i++) {
      const x =
        bits === 8
          ? bytes[i]! - 128
          : bits === 16
            ? b.getInt16(i * 2, true)
            : bits === 24
              ? (b.getInt8(i * 3 + 2) << 16) | b.getUint16(i * 3, true)
              : b.getInt32(i * 4, true);
      out[i] = x * scale;
    }
  }
  return {
    data: out,
    pcm: { sampleRate, channels, format: 'f32' },
    bits: float ? 24 : Math.min(bits, 24),
  };
}

/**
 * Encoder options for a configuration.
 * @param c The configuration.
 * @param input The encoder input (adds `pcm` and a target depth for float PCM).
 * @returns The options.
 */
export function encoderOptions(
  c: BenchConfig,
  input: EncoderInput = { data: new Uint8Array() },
): Options {
  const o: Options = { compressionLevel: c.level };
  if (input.pcm !== undefined) o.pcm = input.pcm;
  if (input.bits !== undefined) o.bitsPerSample = input.bits;
  if (c.transcode === 'resample-48k') o.sampleRate = 48000;
  if (c.transcode === 'to-16bit') o.bitsPerSample = 16;
  return o;
}

/**
 * CLI arguments of the native example for a configuration.
 * @param c The configuration.
 * @param input The encoder input (its bytes are what the native run reads).
 * @returns Extra arguments.
 */
export function nativeArgs(
  c: BenchConfig,
  input: EncoderInput = { data: new Uint8Array() },
): string[] {
  const a = ['--level', String(c.level), '--time'];
  const o = encoderOptions(c, input);
  if (c.output === 'stream') a.push('--stream');
  if (o.pcm !== undefined) a.push('--pcm', `${o.pcm.format}:${o.pcm.sampleRate}:${o.pcm.channels}`);
  if (o.sampleRate !== undefined) a.push('--rate', String(o.sampleRate));
  if (o.bitsPerSample !== undefined) a.push('--bits', String(o.bitsPerSample));
  return a;
}

/**
 * The bytes of an encoder input (what the native baseline reads from disk).
 * @param input The input.
 * @returns A view of its bytes.
 */
export function inputBytes(input: EncoderInput): Uint8Array<ArrayBuffer> {
  const d = input.data;
  return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
}

/**
 * Validates and completes a partial configuration (e.g. from JSON or a query string).
 * @param raw Partial configuration; any value, since it may come from a request body.
 * @returns The configuration.
 * @throws {Error} For invalid values.
 */
export function parseConfig(raw: unknown): BenchConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('config must be an object');
  const r = raw as Record<string, unknown>;
  const modes = r['modes'] ?? DEFAULT_CONFIG.modes;
  if (!Array.isArray(modes)) throw new Error('modes must be an array');
  const c = { ...DEFAULT_CONFIG, ...r, modes: [...modes] as unknown[] };
  if (!Number.isInteger(c.runs) || (c.runs as number) < 1 || (c.runs as number) > 100)
    throw new Error('runs must be 1–100');
  if (!Number.isInteger(c.level) || (c.level as number) < 0 || (c.level as number) > 8)
    throw new Error('level must be 0–8');
  if (c.output !== 'buffer' && c.output !== 'stream')
    throw new Error('output must be buffer or stream');
  if (typeof c.input !== 'string' || !Object.hasOwn(INPUT_LABEL, c.input)) {
    throw new Error(`input must be of ${Object.keys(INPUT_LABEL).join(', ')}`);
  }
  if (
    typeof c.transcode !== 'string' ||
    !['none', 'resample-48k', 'to-16bit'].includes(c.transcode)
  ) {
    throw new Error('transcode must be none, resample-48k or to-16bit');
  }
  if (typeof c.warmup !== 'boolean') throw new Error('warmup must be a boolean');
  if (typeof c.preset !== 'string') throw new Error('preset must be a string');
  const p = preset(c.preset);
  // A transcode that changes nothing would be measured as if it did.
  if (c.transcode === 'resample-48k' && p.rate === 48000) {
    throw new Error(`transcode resample-48k does nothing for preset ${p.id} (already 48 kHz)`);
  }
  if (c.transcode === 'to-16bit' && p.bits === 16 && c.input !== 'pcm-f32') {
    throw new Error(
      `transcode to-16bit does nothing for preset ${p.id} with ${c.input} input (already 16-bit)`,
    );
  }
  const valid: readonly unknown[] = Object.keys(MODE_LABEL);
  if (c.modes.length === 0 || !c.modes.every((m) => valid.includes(m)))
    throw new Error(`modes must be of ${valid.join(', ')}`);
  return c as BenchConfig;
}

/** Summary statistics of a list of numbers. */
export interface Stats {
  /** Smallest value. */
  min: number;
  /** Median. */
  median: number;
  /** Arithmetic mean. */
  mean: number;
  /** Largest value. */
  max: number;
  /** Sample standard deviation (0 for one value). */
  stdev: number;
}

/**
 * Summary statistics.
 * @param xs Values (non-empty).
 * @returns The statistics.
 */
export function stats(xs: readonly number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
  const stdev = n > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { min: s[0]!, median, mean, max: s[n - 1]!, stdev };
}

/**
 * Largest non-null value, or `null`.
 * @param xs Values.
 * @returns The maximum.
 */
export function peak(xs: readonly (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length === 0 ? null : Math.max(...v);
}

/**
 * Formats a byte count (MiB with one decimal, or KiB when small).
 * @param b Bytes, or `null`.
 * @returns The text (`–` for `null`).
 */
export function fmtBytes(b: number | null): string {
  if (b === null) return '–';
  return b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MiB` : `${(b / 1024).toFixed(0)} KiB`;
}

/** One row of the summary table. */
export interface SummaryRow {
  /** Mode label. */
  mode: string;
  /** Median ms. */
  median: string;
  /** Mean ± stdev ms. */
  mean: string;
  /** Min–max ms. */
  range: string;
  /** Throughput on the encoder input, MB/s (median). */
  mbps: string;
  /** Audio seconds per wall second (median). */
  realtime: string;
  /** Peak RSS (Node/native) and its growth over the pre-encode RSS. */
  rss: string;
  /** Peak wasm memory. */
  wasm: string;
  /** Peak JS heap. */
  heap: string;
  /** UA-specific memory (browser). */
  ua: string;
  /** Longest main-thread stall. */
  block: string;
  /** Output size and ratio. */
  size: string;
}

/**
 * Builds the human-readable summary of a report.
 * @param r The report.
 * @returns One row per mode.
 */
export function summarize(r: BenchReport): SummaryRow[] {
  return r.results.map((m) => {
    const label = MODE_LABEL[m.mode];
    if (m.error !== null || m.samples.length === 0) {
      const e = m.error ?? 'no samples';
      return {
        mode: label,
        median: e,
        mean: '',
        range: '',
        mbps: '',
        realtime: '',
        rss: '',
        wasm: '',
        heap: '',
        ua: '',
        block: '',
        size: '',
      };
    }
    const t = stats(m.samples.map((s) => s.ms));
    const rss = peak(m.samples.map((s) => s.maxRssKb));
    const base = peak(m.samples.map((s) => s.baseRssKb));
    const block = peak(m.samples.map((s) => s.maxBlockMs));
    const out = m.samples[0]!.outBytes;
    return {
      mode: label,
      median: `${t.median.toFixed(1)} ms`,
      mean: `${t.mean.toFixed(1)} ± ${t.stdev.toFixed(1)}`,
      range: `${t.min.toFixed(1)}–${t.max.toFixed(1)}`,
      mbps: (r.inputBytes / 1e6 / (t.median / 1000)).toFixed(1),
      realtime: `${(r.inputSeconds / (t.median / 1000)).toFixed(0)}×`,
      rss:
        rss === null
          ? '–'
          : base === null
            ? fmtBytes(rss * 1024)
            : `${fmtBytes(rss * 1024)} (+${fmtBytes(Math.max(0, rss - base) * 1024)})`,
      wasm: fmtBytes(peak(m.samples.map((s) => s.wasmBytes))),
      heap: fmtBytes(peak(m.samples.map((s) => s.heapBytes))),
      ua: fmtBytes(m.uaMemoryBytes),
      block: block === null ? '–' : `${block.toFixed(0)} ms`,
      size: `${fmtBytes(out)} (${((out / r.inputBytes) * 100).toFixed(1)} %)`,
    };
  });
}

/** Column headers matching {@link SummaryRow}. */
export const SUMMARY_HEADERS: Readonly<Record<keyof SummaryRow, string>> = {
  mode: 'Mode',
  median: 'Median',
  mean: 'Mean ± σ (ms)',
  range: 'Min–max (ms)',
  mbps: 'MB/s',
  realtime: '× realtime',
  rss: 'Max RSS (+ during encode)',
  wasm: 'Wasm memory',
  heap: 'JS heap peak',
  ua: 'UA memory',
  block: 'Longest block',
  size: 'Output (ratio)',
};

/**
 * The summary columns that have data in at least one row.
 * @param rows Summary rows.
 * @returns Column keys, `mode` first.
 */
export function columns(rows: readonly SummaryRow[]): (keyof SummaryRow)[] {
  return (Object.keys(SUMMARY_HEADERS) as (keyof SummaryRow)[]).filter(
    (k) => k === 'mode' || rows.some((row) => row[k] !== '–' && row[k] !== ''),
  );
}

/**
 * One-line description of a report's input and configuration.
 * @param r The report.
 * @returns The text.
 */
export function describe(r: BenchReport): string {
  const kind = INPUT_LABEL[r.config.input ?? 'wav'];
  return (
    `${r.version} · input: ${r.inputLabel} as ${kind} (${fmtBytes(r.inputBytes)}) · level ${r.config.level} · ` +
    `${r.config.output} output · transcode: ${r.config.transcode} · ${r.config.runs} run(s)` +
    `${r.config.warmup ? ' + warm-up' : ''}`
  );
}

/**
 * Renders a report as a Markdown section (for `$GITHUB_STEP_SUMMARY` and docs).
 * Columns without data in any row are left out.
 * @param r The report.
 * @returns Markdown.
 */
export function toMarkdown(r: BenchReport): string {
  const rows = summarize(r);
  const keys = columns(rows);
  const lines = [
    `### ${r.environment}`,
    '',
    describe(r),
    '',
    `| ${keys.map((k) => SUMMARY_HEADERS[k]).join(' | ')} |`,
    `| ${keys.map((k) => (k === 'mode' ? '---' : '---:')).join(' | ')} |`,
    ...rows.map((row) => `| ${keys.map((k) => row[k]).join(' | ')} |`),
    '',
  ];
  return lines.join('\n');
}
