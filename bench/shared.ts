// SPDX-License-Identifier: 0BSD
/**
 * Benchmark definitions shared by the browser page, the Node runner and the
 * CI scripts: input presets, configuration, result shapes and statistics.
 * @module
 */
import type { Options } from '../ts/index.js';
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
  { id: 'voice', label: '5 s · 16 kHz · 16-bit · mono', seconds: 5, rate: 16000, channels: 1, bits: 16 },
  { id: 'cd', label: '1 min · 44.1 kHz · 16-bit · stereo (CD)', seconds: 60, rate: 44100, channels: 2, bits: 16 },
  { id: 'short', label: '10 s · 44.1 kHz · 16-bit · stereo', seconds: 10, rate: 44100, channels: 2, bits: 16 },
  { id: 'song', label: '3 min · 44.1 kHz · 16-bit · stereo', seconds: 180, rate: 44100, channels: 2, bits: 16 },
  { id: 'hires', label: '1 min · 96 kHz · 24-bit · stereo', seconds: 60, rate: 96000, channels: 2, bits: 24 },
  { id: 'surround', label: '1 min · 48 kHz · 24-bit · 5.1', seconds: 60, rate: 48000, channels: 6, bits: 24 },
  { id: 'long', label: '10 min · 44.1 kHz · 16-bit · stereo', seconds: 600, rate: 44100, channels: 2, bits: 16 },
];

/** Optional transcoding applied during the benchmark. */
export type Transcode = 'none' | 'resample-48k' | 'to-16bit';

/** How the encoder runs. */
export type Mode =
  /** `encode()` on the calling thread; yields between chunks. */
  | 'main'
  /** `encodeSync()` on the calling thread; blocks it. */
  | 'sync'
  /** `createWorkerEncoder().encode()`: Web Worker / worker_threads. */
  | 'worker'
  /** The native Rust build (`examples/encode`), Node runner only. */
  | 'native';

/** Human-readable mode names. */
export const MODE_LABEL: Readonly<Record<Mode, string>> = {
  main: 'Main thread (encode)',
  sync: 'Main thread (encodeSync)',
  worker: 'Worker',
  native: 'Native Rust (baseline)',
};

/** One benchmark configuration. */
export interface BenchConfig {
  /** Timed runs per mode. */
  runs: number;
  /** Preset id. */
  preset: string;
  /** Compression level 0–8. */
  level: number;
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
  if (p === undefined) throw new Error(`unknown preset "${id}" (${PRESETS.map((x) => x.id).join(', ')})`);
  return p;
}

/**
 * Generates a preset's WAV file.
 * @param p The preset.
 * @returns WAV bytes.
 */
export function presetWav(p: Preset): Uint8Array<ArrayBuffer> {
  return makeWav({ frames: p.seconds * p.rate, rate: p.rate, channels: p.channels, bits: p.bits, signal: 'music', seed: 7 });
}

/**
 * Encoder options for a configuration.
 * @param c The configuration.
 * @returns The options.
 */
export function encoderOptions(c: BenchConfig): Options {
  const o: Options = { compressionLevel: c.level };
  if (c.transcode === 'resample-48k') o.sampleRate = 48000;
  if (c.transcode === 'to-16bit') o.bitsPerSample = 16;
  return o;
}

/**
 * CLI arguments of the native example for a configuration.
 * @param c The configuration.
 * @returns Extra arguments.
 */
export function nativeArgs(c: BenchConfig): string[] {
  const a = ['--level', String(c.level), '--time'];
  if (c.output === 'stream') a.push('--stream');
  if (c.transcode === 'resample-48k') a.push('--rate', '48000');
  if (c.transcode === 'to-16bit') a.push('--bits', '16');
  return a;
}

/**
 * Validates and completes a partial configuration (e.g. from JSON or a query string).
 * @param raw Partial configuration.
 * @returns The configuration.
 * @throws {Error} For invalid values.
 */
export function parseConfig(raw: Partial<BenchConfig>): BenchConfig {
  const c: BenchConfig = { ...DEFAULT_CONFIG, ...raw, modes: [...(raw.modes ?? DEFAULT_CONFIG.modes)] };
  if (!Number.isInteger(c.runs) || c.runs < 1 || c.runs > 100) throw new Error('runs must be 1–100');
  if (!Number.isInteger(c.level) || c.level < 0 || c.level > 8) throw new Error('level must be 0–8');
  if (c.output !== 'buffer' && c.output !== 'stream') throw new Error('output must be buffer or stream');
  if (typeof c.transcode !== 'string' || !['none', 'resample-48k', 'to-16bit'].includes(c.transcode)) {
    throw new Error('transcode must be none, resample-48k or to-16bit');
  }
  if (typeof c.warmup !== 'boolean') throw new Error('warmup must be a boolean');
  if (typeof c.preset !== 'string') throw new Error('preset must be a string');
  const p = preset(c.preset);
  // A transcode that changes nothing would be measured as if it did.
  if (c.transcode === 'resample-48k' && p.rate === 48000) {
    throw new Error(`transcode resample-48k does nothing for preset ${p.id} (already 48 kHz)`);
  }
  if (c.transcode === 'to-16bit' && p.bits === 16) {
    throw new Error(`transcode to-16bit does nothing for preset ${p.id} (already 16-bit)`);
  }
  const valid: readonly unknown[] = Object.keys(MODE_LABEL);
  if (c.modes.length === 0 || !c.modes.every((m) => valid.includes(m))) throw new Error(`modes must be of ${valid.join(', ')}`);
  return c;
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
  /** Throughput on the WAV input, MB/s (median). */
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
      return { mode: label, median: e, mean: '', range: '', mbps: '', realtime: '', rss: '', wasm: '', heap: '', ua: '', block: '', size: '' };
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
      rss: rss === null ? '–' : base === null ? fmtBytes(rss * 1024) : `${fmtBytes(rss * 1024)} (+${fmtBytes(Math.max(0, rss - base) * 1024)})`,
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
  return (Object.keys(SUMMARY_HEADERS) as (keyof SummaryRow)[])
    .filter((k) => k === 'mode' || rows.some((row) => row[k] !== '–' && row[k] !== ''));
}

/**
 * One-line description of a report's input and configuration.
 * @param r The report.
 * @returns The text.
 */
export function describe(r: BenchReport): string {
  return `${r.version} · input: ${r.inputLabel} (${fmtBytes(r.inputBytes)}) · level ${r.config.level} · ` +
    `${r.config.output} output · transcode: ${r.config.transcode} · ${r.config.runs} run(s)` +
    `${r.config.warmup ? ' + warm-up' : ''}`;
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
