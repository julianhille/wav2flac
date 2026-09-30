// SPDX-License-Identifier: 0BSD
/**
 * Browser benchmark, headless: starts the bench server, opens the page in
 * Playwright's Chromium and calls `window.runBenchmark()`. On Linux it also
 * measures the renderer process's peak RSS via `/proc`: before each run it
 * resets the high-water mark (`clear_refs` 5), and after the run it reads `VmHWM`.
 *
 * ```sh
 * node bench/browser-bench.ts --runs 5 --preset song
 * ```
 * Takes the same options as `node-bench.ts`. `WAV2FLAC_CHROMIUM=/path/to/chrome`
 * overrides the browser binary (default: Playwright's, installed with
 * `npx playwright install chromium`).
 * @module
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { output, parseArgs, printProgress } from './node-bench.ts';
import { startServer } from './server.ts';
import type { BenchConfig, BenchReport, Mode } from './shared.ts';

/**
 * Parent pid and command line of a process.
 * @param pid Process id.
 * @returns Its parent and command line, or `null` if it is gone.
 */
function proc(pid: number): { ppid: number; cmd: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    return { ppid, cmd };
  } catch {
    return null;
  }
}

/**
 * Renderer processes descending from this process (Linux only).
 * @returns Their pids.
 */
function renderers(): number[] {
  let all: [number, { ppid: number; cmd: string }][];
  try {
    all = readdirSync('/proc')
      .filter((d) => /^\d+$/.test(d))
      .map(Number)
      .map((pid) => [pid, proc(pid)] as const)
      .filter((x): x is [number, { ppid: number; cmd: string }] => x[1] !== null);
  } catch {
    return [];
  }
  const ours = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, p] of all) {
      if (!ours.has(pid) && ours.has(p.ppid)) {
        ours.add(pid);
        grew = true;
      }
    }
  }
  return all
    .filter(([pid, p]) => ours.has(pid) && p.cmd.includes('--type=renderer'))
    .map(([pid]) => pid);
}

/**
 * Reads a `kB` field of `/proc/<pid>/status`.
 * @param pid Process id.
 * @param field e.g. `VmRSS`.
 * @returns KiB, or `null`.
 */
function status(pid: number, field: string): number | null {
  try {
    const m = new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(
      readFileSync(`/proc/${pid}/status`, 'utf8'),
    );
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
}

/**
 * The RSS probe exposed to the page as `window.__wav2flacRss`. `before` picks
 * the largest renderer (the page), resets its peak and returns its RSS;
 * `after` returns its peak since then.
 * @returns The probe, or `null` where `/proc` is unavailable.
 */
function rssProbe(): ((phase: 'before' | 'after') => number | null) | null {
  if (process.platform !== 'linux') return null;
  let pid: number | undefined;
  let resettable = true;
  return (phase) => {
    if (phase === 'before') {
      const rs = renderers()
        .map((p) => [p, status(p, 'VmRSS') ?? 0] as const)
        .sort((a, b) => b[1] - a[1]);
      pid = rs[0]?.[0];
      if (pid === undefined) return null;
      try {
        writeFileSync(`/proc/${pid}/clear_refs`, '5');
      } catch {
        resettable = false; // peak then covers the process lifetime
      }
      return status(pid, 'VmRSS');
    }
    if (pid === undefined) return null;
    return resettable ? status(pid, 'VmHWM') : null;
  };
}

/**
 * Runs the benchmark in headless Chromium.
 * @param config Configuration (`native` is dropped).
 * @param onRun Progress callback.
 * @returns The report.
 */
export async function runBrowserBench(
  config: BenchConfig,
  onRun: (mode: Mode, done: number, total: number) => void,
): Promise<BenchReport> {
  const server = await startServer(0);
  const executablePath = process.env['WAV2FLAC_CHROMIUM'];
  const browser = await chromium.launch({
    ...(executablePath === undefined || executablePath === '' ? {} : { executablePath }),
    args: ['--js-flags=--expose-gc', '--enable-blink-features=ForceEagerMeasureMemory'],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
    const probe = rssProbe();
    if (probe !== null) await page.exposeFunction('__wav2flacRss', probe);
    await page.exposeFunction('__wav2flacProgress', onRun);
    await page.goto(server.url);
    await page.waitForFunction(() => 'runBenchmark' in window);
    const c = { ...config, modes: config.modes.filter((m) => m !== 'native') };
    return await page.evaluate(async (cfg) => {
      const w = window as unknown as {
        runBenchmark: (
          c: BenchConfig,
          e: { uaMemory: boolean; onRun?: (m: Mode, d: number, t: number) => void },
        ) => Promise<BenchReport>;
        __wav2flacProgress: (m: Mode, d: number, t: number) => void;
      };
      return w.runBenchmark(cfg, { uaMemory: true, onRun: w.__wav2flacProgress });
    }, c);
  } finally {
    await browser.close();
    await server.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  output(await runBrowserBench(args.config, printProgress), args);
}
