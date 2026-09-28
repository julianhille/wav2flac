// SPDX-License-Identifier: 0BSD
/**
 * One benchmark run in a fresh Node process (spawned by `node-bench.ts`), so
 * that the process's peak RSS belongs to exactly this run. Reads the WAV from
 * a file (no garbage from generating it), optionally warms up, then times one
 * encode of the built package (`pkg/esm`) and prints a JSON {@link ChildResult}.
 *
 * Usage: `node --expose-gc bench/node-run.ts <wav> <mode> <configJson>`
 * @module
 */
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RunSample, BenchConfig } from './shared.ts';
import { encoderOptions } from './shared.ts';

type Lib = typeof import('../ts/index.js');

/** What the child prints. */
export interface ChildResult {
  /** The measurements. */
  sample: RunSample;
  /** Time to start the worker and load wasm in it, ms (worker mode). */
  startupMs: number | null;
  /** `version()` of the package. */
  version: string;
}

/**
 * Drains a stream, counting bytes.
 * @param s The stream.
 * @returns Total bytes.
 */
async function drain(s: ReadableStream<Uint8Array>): Promise<number> {
  let n = 0;
  for await (const c of s) n += c.length;
  return n;
}

/**
 * Collects GC garbage if `--expose-gc` is set.
 */
function gc(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

/**
 * Runs the benchmark described by the command line.
 * @returns The result.
 */
async function main(): Promise<ChildResult> {
  const [wavPath, mode, json] = process.argv.slice(2);
  if (wavPath === undefined || mode === undefined || json === undefined) throw new Error('usage: node-run.ts <wav> <mode> <config>');
  const config = JSON.parse(json) as BenchConfig;
  const lib = (await import(new URL('../pkg/esm/index.js', import.meta.url).href)) as Lib;
  await lib.init();
  const wav = new Uint8Array(readFileSync(wavPath));
  const opts = encoderOptions(config);

  let startupMs: number | null = null;
  let run: () => Promise<number>;
  let wasmBytes: () => Promise<number>;
  let close = (): void => undefined;
  if (mode === 'worker') {
    const t = performance.now();
    const w = lib.createWorkerEncoder();
    await w.wasmMemoryBytes(); // resolves once the worker has loaded wasm
    startupMs = performance.now() - t;
    // Each run transfers a fresh copy, made outside the timed region.
    let input = wav.slice();
    run = config.output === 'stream'
      ? () => drain(w.encodeStream(input, opts))
      : async () => (await w.encode(input, opts)).length;
    const next = run;
    run = async () => {
      const n = await next();
      input = wav.slice();
      return n;
    };
    wasmBytes = () => w.wasmMemoryBytes();
    close = () => w.terminate();
  } else if (mode === 'sync') {
    run = async () => lib.encodeSync(wav, opts).length;
    wasmBytes = async () => lib.wasmMemoryBytes();
  } else if (mode === 'main') {
    run = config.output === 'stream'
      ? () => drain(lib.encodeStream(wav, opts))
      : async () => (await lib.encode(wav, opts)).length;
    wasmBytes = async () => lib.wasmMemoryBytes();
  } else {
    throw new Error(`unknown mode ${mode}`);
  }

  if (config.warmup) await run();
  gc();
  const baseRssKb = Math.round(process.memoryUsage.rss() / 1024);
  let heap = process.memoryUsage().heapUsed;
  const sampler = setInterval(() => { heap = Math.max(heap, process.memoryUsage().heapUsed); }, 2);
  // Heartbeat: the longest gap between 1 ms ticks is the longest stall of the
  // event loop (a synchronous encode shows up as one long gap).
  let last = performance.now();
  let maxGap = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 1);
  await sleep(5);
  maxGap = 0;

  const t0 = performance.now();
  const outBytes = await run();
  const ms = performance.now() - t0;

  await sleep(5); // let the tick delayed by a stall record it
  clearInterval(beat);
  clearInterval(sampler);
  heap = Math.max(heap, process.memoryUsage().heapUsed);
  const sample: RunSample = {
    ms,
    outBytes,
    maxBlockMs: maxGap,
    maxRssKb: process.resourceUsage().maxRSS,
    baseRssKb,
    wasmBytes: await wasmBytes(),
    heapBytes: heap,
  };
  close();
  return { sample, startupMs, version: lib.version() };
}

main().then(
  (r) => process.stdout.write(`${JSON.stringify(r)}\n`),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);
