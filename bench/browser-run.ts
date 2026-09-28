// SPDX-License-Identifier: 0BSD
/**
 * The benchmark as it runs inside a browser page: the same modes and
 * measurements as `node-run.ts`, with the browser's (fewer) memory probes.
 *
 * Max RSS is not observable from a web page. When the page is driven by
 * `browser-bench.ts` (Playwright), that script exposes
 * `window.__wav2flacRss`, which reads the renderer process's resident memory
 * from `/proc` (Linux); otherwise RSS stays `null`.
 * @module
 */
import {
  type BenchConfig, type BenchReport, type EncoderInput, type Mode, type ModeResult, type RunSample,
  encoderInput, encoderOptions,
} from './shared.ts';

/** The package's public API. */
export type Lib = typeof import('../ts/index.js');

/** Where the page loads the built package from (served by `server.ts`). */
const LIB_URL = '/pkg/esm/index.js';

/** Resident-memory probe injected by the Playwright driver: KiB, or `null`. */
export type RssProbe = (phase: 'before' | 'after') => Promise<number | null>;

/** The WAV to encode. */
export interface BenchInput {
  /** WAV bytes. */
  bytes: Uint8Array<ArrayBuffer>;
  /** Description for the report. */
  label: string;
  /** Duration in seconds. */
  seconds: number;
}

/** Extra browser-only switches. */
export interface BrowserOptions {
  /** Call `performance.measureUserAgentSpecificMemory()` after each mode (slow). */
  uaMemory: boolean;
}

/** Progress callback: mode, finished runs, total runs. */
export type OnRun = (mode: Mode, done: number, total: number) => void;

let lib: Promise<Lib> | undefined;

/**
 * Loads and initializes the built package once.
 * @returns The API.
 */
export function loadLib(): Promise<Lib> {
  lib ??= (async () => {
    const url: string = LIB_URL; // not a literal: keep it out of the bundle
    const l = (await import(url)) as Lib;
    await l.init();
    return l;
  })();
  return lib;
}

/**
 * Waits.
 * @param ms Milliseconds.
 * @returns Resolves after `ms`.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Drains a stream, counting bytes.
 * @param s The stream.
 * @returns Total bytes.
 */
async function drain(s: ReadableStream<Uint8Array>): Promise<number> {
  const r = s.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) return n;
    n += value.length;
  }
}

/**
 * Chrome's non-standard heap size, if available.
 * @returns Used JS heap in bytes, or `null`.
 */
function heapUsed(): number | null {
  const m = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  return m === undefined ? null : m.usedJSHeapSize;
}

/**
 * Collects garbage if the browser exposes `gc()` (`--js-flags=--expose-gc`).
 */
function gc(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

/**
 * `performance.measureUserAgentSpecificMemory()` with a timeout.
 * @returns Bytes, or `null` if unavailable (needs cross-origin isolation; some
 * builds, e.g. headless Chromium in CI, expose it but refuse to measure).
 */
async function uaMemory(): Promise<number | null> {
  const p = performance as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> };
  if (!crossOriginIsolated || p.measureUserAgentSpecificMemory === undefined) return null;
  const timeout = sleep(60_000).then(() => null);
  try {
    const r = await Promise.race([p.measureUserAgentSpecificMemory(), timeout]);
    return r === null ? null : r.bytes;
  } catch {
    return null;
  }
}

/**
 * Whether `performance.measureUserAgentSpecificMemory()` can be used here.
 * @returns `true` if it can.
 */
export function uaMemoryAvailable(): boolean {
  return crossOriginIsolated && 'measureUserAgentSpecificMemory' in performance;
}

/**
 * Describes the browser, e.g. `Chrome 153 (Linux x86_64, 16 threads)`.
 * @returns The description.
 */
export function environment(): string {
  const ua = navigator.userAgent;
  // Chromium-based UAs also say "Chrome/" and "Safari/"; check the most
  // specific token first rather than taking the leftmost match.
  const m = [/(Edg)\/(\d+)/, /(Firefox)\/(\d+)/, /(Chrome)\/(\d+)/, /(Version)\/(\d+).*Safari/]
    .map((re) => re.exec(ua)).find((x) => x !== null);
  const name = m === undefined ? 'Browser' : m[1] === 'Version' ? 'Safari' : m[1] === 'Edg' ? 'Edge' : m[1]!;
  const platform = /\(([^;)]+)/.exec(ua)?.[1] ?? navigator.platform;
  return `${name} ${m?.[2] ?? ''} (${platform}, ${navigator.hardwareConcurrency} threads)`.replace('  ', ' ');
}

/**
 * Times one run while sampling the heap and the longest main-thread stall.
 * @param run The encode; resolves to the output size.
 * @param wasmBytes Reads the encoding instance's wasm memory.
 * @param rss Optional RSS probe.
 * @returns The sample.
 */
async function measure(run: () => Promise<number>, wasmBytes: () => Promise<number>, rss: RssProbe | undefined): Promise<RunSample> {
  gc();
  const baseRssKb = rss === undefined ? null : await rss('before');
  let heap = heapUsed();
  const sampler = setInterval(() => {
    const h = heapUsed();
    if (h !== null && (heap === null || h > heap)) heap = h;
  }, 5);
  // Heartbeat: the longest gap between ticks is the longest main-thread stall.
  // Browsers clamp intervals to ~4 ms, so gaps below that are noise.
  let last = performance.now();
  let maxGap = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 1);
  await sleep(10);
  maxGap = 0;

  const t0 = performance.now();
  const outBytes = await run();
  const ms = performance.now() - t0;

  await sleep(10);
  clearInterval(beat);
  clearInterval(sampler);
  const maxRssKb = rss === undefined ? null : await rss('after');
  return { ms, outBytes, maxBlockMs: maxGap, maxRssKb, baseRssKb, wasmBytes: await wasmBytes(), heapBytes: heap };
}

/**
 * Benchmarks one mode.
 * @param l The API.
 * @param mode Mode.
 * @param input The encoder input (WAV or raw PCM).
 * @param config Configuration.
 * @param extra Browser-only switches.
 * @param onRun Progress callback.
 * @returns The result.
 */
async function runMode(l: Lib, mode: Mode, input: EncoderInput, config: BenchConfig, extra: BrowserOptions, onRun: OnRun): Promise<ModeResult> {
  const res: ModeResult = { mode, samples: [], startupMs: null, uaMemoryBytes: null, error: null };
  const rss = (globalThis as { __wav2flacRss?: RssProbe }).__wav2flacRss;
  const opts = encoderOptions(config, input);
  const wav = input.data;
  let close = (): void => undefined;
  let prepare = (): void => undefined;
  try {
    let run: () => Promise<number>;
    let wasmBytes: () => Promise<number>;
    if (mode === 'worker') {
      const t = performance.now();
      const w = l.createWorkerEncoder();
      close = () => w.terminate();
      await w.wasmMemoryBytes(); // resolves once the worker has loaded wasm
      res.startupMs = performance.now() - t;
      // Transferred to the worker: prepare() makes a fresh copy per run, outside the timing.
      let copy = wav;
      prepare = () => {
        copy = wav.slice();
      };
      run = config.output === 'stream'
        ? () => drain(w.encodeStream(copy, opts))
        : async () => (await w.encode(copy, opts)).length;
      wasmBytes = () => w.wasmMemoryBytes();
    } else if (mode === 'sync') {
      run = async () => l.encodeSync(wav, opts).length;
      wasmBytes = async () => l.wasmMemoryBytes();
    } else if (mode === 'main') {
      run = config.output === 'stream'
        ? () => drain(l.encodeStream(wav, opts))
        : async () => (await l.encode(wav, opts)).length;
      wasmBytes = async () => l.wasmMemoryBytes();
    } else {
      throw new Error('only available in Node');
    }
    if (config.warmup) {
      prepare();
      await run();
    }
    for (let i = 0; i < config.runs; i++) {
      prepare();
      res.samples.push(await measure(run, wasmBytes, rss));
      onRun(mode, i + 1, config.runs);
      await sleep(20); // let the page repaint between runs
    }
    if (extra.uaMemory) res.uaMemoryBytes = await uaMemory();
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
  } finally {
    close();
  }
  return res;
}

/**
 * Runs the benchmark in this page.
 * @param config Configuration.
 * @param input The WAV (turned into raw PCM first if `config.input` asks for it).
 * @param extra Browser-only switches.
 * @param onRun Progress callback.
 * @returns The report.
 */
export async function runBrowserBench(config: BenchConfig, input: BenchInput, extra: BrowserOptions, onRun: OnRun = () => undefined): Promise<BenchReport> {
  const l = await loadLib();
  const enc = encoderInput(input.bytes, config.input);
  const results: ModeResult[] = [];
  for (const mode of config.modes) results.push(await runMode(l, mode, enc, config, extra, onRun));
  return {
    environment: environment(),
    version: l.version(),
    config,
    inputLabel: input.label,
    inputBytes: enc.data.byteLength,
    inputSeconds: input.seconds,
    date: new Date().toISOString(),
    results,
  };
}
