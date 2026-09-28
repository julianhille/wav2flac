<!-- SPDX-License-Identifier: 0BSD -->
# Benchmark

The benchmark compares ways of running the encoder on the same input:

| Mode | What runs |
|---|---|
| **Main thread, `encode()`** | The calling thread; yields to the event loop about every 8 ms |
| **Main thread, `encodeSync()`** | The calling thread; blocks it until done |
| **Worker** | `createWorkerEncoder()`: a Web Worker in browsers, `worker_threads` in Node |
| **Native Rust** | `examples/encode` (Node runner only): the baseline without wasm |

"Worker" means a dedicated Web Worker. An AudioWorklet isn't a fit: it runs on
the real-time audio rendering thread in 128-frame quanta and is meant for
playback. Blocking it for a batch encode would glitch audio.

There are three ways to run it. All of them share `bench/shared.ts` (presets,
configuration and statistics).

## Prerequisites

- Node ≥ 22.18 (the bench scripts are TypeScript run directly by Node).
- A built package: `npm ci && npm run build` (needs the Rust toolchain,
  wasm-bindgen and binaryen; see the README).
- For the native baseline: `cargo build --release --example encode`.
- For the headless browser run: `npx playwright install chromium`.

## 1. Benchmark page (interactive)

```bash
npm run bench:serve
```

Open <http://127.0.0.1:8787/>. Pick the number of **runs**, the input (a
generated preset or your own WAV file), compression level, output
(buffer or stream), transcoding and the modes to compare, then press
**Run benchmark**. Every run adds a result card, so you can compare
configurations. Each card can be copied as Markdown or downloaded as JSON.

**Run in: Node (server)** runs the same configuration through the Node
runner below. You get real max RSS and the native baseline, with results
streamed back to the page.

The dot next to the button moves every animation frame; when it stops, the
main thread is blocked (watch it during `encodeSync()`).

Query parameters preset the form, and `autorun=1` starts immediately:
`http://127.0.0.1:8787/?runs=3&preset=short&modes=main,worker&autorun=1`.

The server binds 127.0.0.1 only, bundles the page script on each request
(edit `bench/*.ts` and reload), serves `pkg/`, and sends COOP/COEP headers
so the page is cross-origin isolated.

## 2. Node, command line

```bash
npm run bench -- --runs 5 --preset song --modes main,sync,worker,native
```

Every timed run is a **fresh Node process**, so the reported max RSS
(`process.resourceUsage().maxRSS`) belongs to that run alone.

## 3. Headless Chromium, command line

```bash
npm run bench:browser -- --runs 5 --preset song
```

This starts the bench server, opens the page in Playwright's Chromium and
calls `window.runBenchmark()`. On Linux it also reads the **renderer
process's peak RSS**. Before each run it resets the high-water mark
(`/proc/<pid>/clear_refs`), and after the run it reads `VmHWM`. Dedicated
workers live in the renderer process, so this includes the worker.

To use a different Chromium build, set `WAV2FLAC_CHROMIUM=/path/to/chrome`.

## Options

Both CLIs take the same options:

| Option | Default | Values |
|---|---|---|
| `--runs N` | 5 | 1–100 timed runs per mode |
| `--preset ID` | `song` | `voice` (5 s 16 kHz mono), `cd` (1 min CD quality), `short` (10 s), `song` (3 min), `hires` (1 min 96 kHz/24-bit), `surround` (1 min 5.1), `long` (10 min) |
| `--level N` | 5 | 0–8 |
| `--output` | `buffer` | `buffer` (`encode()`), `stream` (`encodeStream()`; `encodeSync()` stays buffered) |
| `--transcode` | `none` | `none`, `resample-48k`, `to-16bit` |
| `--modes a,b` | `main,sync,worker` | plus `native` (Node only) |
| `--no-warmup` | | skip the untimed warm-up run per mode |
| `--json FILE` | | write the full report (every sample) |
| `--markdown FILE` | | append a Markdown table (CI uses `$GITHUB_STEP_SUMMARY`) |

Presets are generated deterministically (a music-like mix of tones,
harmonics and noise), so runs on different machines encode the same bytes.

## What the columns mean

| Column | Meaning |
|---|---|
| Median, Mean ± σ, Min–max | Wall time of one encode call, input already in memory. Worker runs include transferring the input. |
| MB/s, × realtime | WAV bytes, and audio seconds, per wall-clock second (median). |
| Max RSS (+ during encode) | Peak resident memory of the process, and how much it grew over the RSS just before the run. Node: the whole process, including worker threads. Chromium via Playwright: the renderer process. Not observable from a plain web page. |
| Wasm memory | Linear memory of the instance that encoded (main thread or worker). It stays small in all modes: input is fed in slices, and output leaves wasm after each push. |
| JS heap peak | Sampled by a timer during the run (Node: `heapUsed`; Chrome: `performance.memory`, coarse unless cross-origin isolated). `encodeSync()` blocks the timer, so in sync mode only the value right after the run is seen. |
| UA memory | `performance.measureUserAgentSpecificMemory()` after the mode's runs (browsers, cross-origin isolated). Includes workers. |
| Longest block | Longest gap between 1 ms timer ticks on the main thread during the run: how long the page or the Node event loop couldn't respond. This is the number that shows why a worker (or at least `encode()` rather than `encodeSync()`) matters. Browsers clamp timers to about 4 ms, so smaller values are noise. |
| Output (ratio) | FLAC size and size relative to the encoder input. |
| Worker start-up | Time to spawn the worker and load wasm in it. Shown on the browser page and stored in the JSON (`startupMs`); it is not part of the timed runs. |

## Reading the results

- The **native** baseline shows the cost of wasm (usually 1.2–1.5× slower).
- **Buffer** output holds the whole FLAC in memory; **stream** output
  doesn't, so its RSS growth stays flat for long inputs.
- `encodeSync()` is usually the fastest wasm mode, but it blocks for the
  whole encode.
- `encode()` stays responsive and costs a little extra time.
- The worker keeps the main thread free. It costs a transfer, some start-up
  time and the worker's own memory.

## CI

`.github/workflows/bench.yml` runs on pushes to `main`, on pull requests
and manually (**Actions → Benchmark → Run workflow**, where you pick runs,
preset and level). It builds the package and the native example, then runs,
for each of the `voice`, `cd` and `song` presets (or just the one picked):

1. Node, buffer output: main, sync, worker and native.
2. Node, stream output: main, worker and native.
3. Headless Chromium: main, sync and worker.

The tables appear in the job summary, and the JSON reports are uploaded as
the `benchmark-<sha>` artifact. Shared CI runners are noisy, so compare
trends and large differences rather than single runs. The workflow reports;
it doesn't fail on regressions.
