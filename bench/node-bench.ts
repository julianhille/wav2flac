// SPDX-License-Identifier: 0BSD
/**
 * Node benchmark: every timed run is a fresh process (`node-run.ts`, or the
 * native `examples/encode` baseline), so the reported max RSS is that run's.
 *
 * ```sh
 * node bench/node-bench.ts --runs 5 --preset song --modes main,sync,worker,native
 * ```
 * Options: `--runs N`, `--preset ID`, `--level N`, `--output buffer|stream`,
 * `--transcode none|resample-48k|to-16bit`, `--modes a,b`, `--no-warmup`,
 * `--json FILE`, `--markdown FILE` (appends; use `$GITHUB_STEP_SUMMARY` in CI).
 * @module
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildResult } from './node-run.ts';
import {
  type BenchConfig, type BenchReport, type Mode, type ModeResult, type RunSample,
  columns, describe, MODE_LABEL, nativeArgs, parseConfig, preset, presetWav, summarize, SUMMARY_HEADERS, toMarkdown,
} from './shared.ts';

/** Path of the native reference encoder. */
export const NATIVE = fileURLToPath(new URL('../target/release/examples/encode', import.meta.url));

/** Entry of the built package. */
const PKG = fileURLToPath(new URL('../pkg/esm/index.js', import.meta.url));

/** Progress callback: mode, finished runs, total runs. */
export type OnRun = (mode: Mode, done: number, total: number) => void;

/**
 * Runs a command and collects its output.
 * @param cmd Executable.
 * @param args Arguments.
 * @returns Exit code, stdout and stderr.
 */
function exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * One native run.
 * @param wav Input file.
 * @param out Output file.
 * @param config Configuration.
 * @returns The sample.
 */
async function nativeRun(wav: string, out: string, config: BenchConfig): Promise<RunSample> {
  const r = await exec(NATIVE, [wav, out, ...nativeArgs(config)]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
  const line = r.stderr.trim().split('\n').at(-1) ?? '';
  const t = JSON.parse(line) as { ms: number; maxRssKb: number; outBytes: number };
  return { ms: t.ms, outBytes: t.outBytes, maxBlockMs: null, maxRssKb: t.maxRssKb, baseRssKb: null, wasmBytes: null, heapBytes: null };
}

/**
 * One wasm run in a fresh Node process.
 * @param wav Input file.
 * @param mode Mode.
 * @param config Configuration.
 * @returns The child's result.
 */
async function nodeRun(wav: string, mode: Mode, config: BenchConfig): Promise<ChildResult> {
  const script = fileURLToPath(new URL('./node-run.ts', import.meta.url));
  const r = await exec(process.execPath, ['--expose-gc', '--no-warnings', script, wav, mode, JSON.stringify(config)]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
  return JSON.parse(r.stdout) as ChildResult;
}

/**
 * Runs the benchmark.
 * @param config Configuration.
 * @param onRun Called after every run.
 * @returns The report.
 */
export async function runNodeBench(config: BenchConfig, onRun: OnRun = () => undefined): Promise<BenchReport> {
  if (!existsSync(PKG)) throw new Error('pkg/ is missing; run `npm run build` first');
  const p = preset(config.preset);
  const wav = presetWav(p);
  const dir = mkdtempSync(join(tmpdir(), 'wav2flac-bench-'));
  const wavPath = join(dir, 'in.wav');
  writeFileSync(wavPath, wav);
  let version = '';
  const results: ModeResult[] = [];
  try {
    for (const mode of config.modes) {
      const res: ModeResult = { mode, samples: [], startupMs: null, uaMemoryBytes: null, error: null };
      results.push(res);
      try {
        if (mode === 'native') {
          if (!existsSync(NATIVE)) throw new Error(`${NATIVE} missing; run cargo build --release --example encode`);
          if (config.warmup) await nativeRun(wavPath, join(dir, 'out.flac'), config);
          for (let i = 0; i < config.runs; i++) {
            res.samples.push(await nativeRun(wavPath, join(dir, 'out.flac'), config));
            onRun(mode, i + 1, config.runs);
          }
          continue;
        }
        const startups: number[] = [];
        for (let i = 0; i < config.runs; i++) {
          const r = await nodeRun(wavPath, mode, config);
          res.samples.push(r.sample);
          if (r.startupMs !== null) startups.push(r.startupMs);
          version = r.version;
          onRun(mode, i + 1, config.runs);
        }
        if (startups.length > 0) res.startupMs = Math.min(...startups);
      } catch (e) {
        res.error = e instanceof Error ? e.message : String(e);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    environment: `Node ${process.version} (${process.platform} ${process.arch}, ${cpus()[0]?.model.trim() ?? 'unknown CPU'})`,
    version,
    config,
    inputLabel: p.label,
    inputBytes: wav.length,
    inputSeconds: p.seconds,
    date: new Date().toISOString(),
    results,
  };
}

/** Parsed command line of the benchmark CLIs. */
export interface CliArgs {
  /** The configuration. */
  config: BenchConfig;
  /** Write the JSON report here. */
  json?: string;
  /** Append the Markdown summary here. */
  markdown?: string;
}

/**
 * Parses the command line.
 * @param argv Arguments after the script.
 * @param defaults Defaults that differ from `DEFAULT_CONFIG`.
 * @returns Configuration and output files.
 */
export function parseArgs(argv: string[], defaults: Partial<BenchConfig> = {}): CliArgs {
  const raw: Partial<BenchConfig> = { ...defaults };
  let json: string | undefined;
  let markdown: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = (): string => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    switch (a) {
      case '--runs': raw.runs = Number(v()); break;
      case '--preset': raw.preset = v(); break;
      case '--level': raw.level = Number(v()); break;
      case '--output': raw.output = v() as BenchConfig['output']; break;
      case '--transcode': raw.transcode = v() as BenchConfig['transcode']; break;
      case '--modes': raw.modes = v().split(',') as Mode[]; break;
      case '--no-warmup': raw.warmup = false; break;
      case '--json': json = v(); break;
      case '--markdown': markdown = v(); break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  const config = parseConfig(raw);
  return { config, ...(json === undefined ? {} : { json }), ...(markdown === undefined ? {} : { markdown }) };
}

/**
 * Prints a report as a table, writes the requested files and sets the exit
 * code to 1 if a mode failed.
 * @param report The report.
 * @param args Output options.
 */
export function output(report: BenchReport, args: CliArgs): void {
  const rows = summarize(report);
  console.log(`\n${report.environment}\n${describe(report)}\n`);
  console.table(Object.fromEntries(rows.map((r) => [r.mode, Object.fromEntries(
    columns(rows).filter((k) => k !== 'mode').map((k) => [SUMMARY_HEADERS[k], r[k]]),
  )])));
  if (args.json !== undefined) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
  if (args.markdown !== undefined) appendFileSync(args.markdown, `${toMarkdown(report)}\n`);
  for (const r of report.results) {
    if (r.error === null) continue;
    console.error(`${MODE_LABEL[r.mode]} failed: ${r.error}`);
    process.exitCode = 1;
  }
}

/**
 * Progress printer for the CLIs.
 * @param mode Mode.
 * @param done Finished runs.
 * @param total Total runs.
 */
export function printProgress(mode: Mode, done: number, total: number): void {
  process.stderr.write(`\r${MODE_LABEL[mode]}: ${done}/${total}   `);
  if (done === total) process.stderr.write('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  output(await runNodeBench(args.config, printProgress), args);
}
