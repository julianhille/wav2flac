// SPDX-License-Identifier: 0BSD
/**
 * The benchmark page (`bench/index.html`): form handling, running in this
 * browser or on the bench server's Node, and rendering reports.
 *
 * Query parameters preset the form (`?runs=3&preset=short&modes=main,worker`),
 * and `autorun=1` starts immediately. Automation calls
 * `window.runBenchmark(config)`.
 * @module
 */
import { type BenchInput, type OnRun, loadLib, runBrowserBench, uaMemoryAvailable } from './browser-run.ts';
import {
  type BenchConfig, type BenchReport, type Mode,
  columns, describe, fmtBytes, MODE_LABEL, parseConfig, PRESETS, preset, presetWav, summarize, SUMMARY_HEADERS, toMarkdown,
} from './shared.ts';

/** A line of the server's NDJSON response. */
type ServerLine =
  | { progress: { mode: Mode; done: number; total: number } }
  | { report: BenchReport }
  | { error: string };

/**
 * Looks up an element by id.
 * @param id Element id.
 * @returns The element.
 */
function $<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (e === null) throw new Error(`#${id} missing`);
  return e as T;
}

/**
 * Creates an element.
 * @param tag Tag name.
 * @param props Properties to assign.
 * @param children Child nodes or text.
 * @returns The element.
 */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

const form = $<HTMLFormElement>('form');
const status = $<HTMLSpanElement>('status');
const start = $<HTMLButtonElement>('start');
const fileInput = $<HTMLInputElement>('file');
const uaBox = $<HTMLInputElement>('ua');

/**
 * Checkboxes of the modes.
 * @returns The inputs.
 */
function modeBoxes(): HTMLInputElement[] {
  return [...form.querySelectorAll<HTMLInputElement>('input[name=mode]')];
}

/**
 * Where to run, from the radio buttons.
 * @returns `browser` or `node`.
 */
function where(): 'browser' | 'node' {
  return form.querySelector<HTMLInputElement>('input[name=where]:checked')?.value === 'node' ? 'node' : 'browser';
}

/**
 * Enables the native mode only for Node, and the UA-memory switch only where it works.
 */
function syncControls(): void {
  const node = where() === 'node';
  for (const b of modeBoxes()) {
    if (b.value === 'native') {
      b.disabled = !node;
      if (!node) b.checked = false;
    }
  }
  const ua = !node && uaMemoryAvailable();
  uaBox.disabled = !ua;
  if (!ua) uaBox.checked = false;
  fileInput.disabled = node;
}

/**
 * Reads the form into a configuration.
 * @returns The configuration.
 */
function readForm(): BenchConfig {
  const f = new FormData(form);
  return parseConfig({
    runs: Number(f.get('runs')),
    preset: String(f.get('preset')),
    level: Number(f.get('level')),
    output: f.get('output') === 'stream' ? 'stream' : 'buffer',
    transcode: String(f.get('transcode')) as BenchConfig['transcode'],
    modes: modeBoxes().filter((b) => b.checked && !b.disabled).map((b) => b.value as Mode),
    warmup: $<HTMLInputElement>('warmup').checked,
  });
}

/**
 * Sets the form from a configuration.
 * @param c The configuration.
 */
function writeForm(c: BenchConfig): void {
  const set = (name: string, v: string): void => {
    const e = form.elements.namedItem(name);
    if (e instanceof HTMLSelectElement) {
      if (![...e.options].some((o) => o.value === v)) e.add(new Option(v, v));
      e.value = v;
    }
  };
  set('runs', String(c.runs));
  set('preset', c.preset);
  set('level', String(c.level));
  set('output', c.output);
  set('transcode', c.transcode);
  for (const b of modeBoxes()) b.checked = c.modes.includes(b.value as Mode);
  $<HTMLInputElement>('warmup').checked = c.warmup;
}

/**
 * The input to encode: the chosen file, or the generated preset.
 * @param c The configuration.
 * @returns The input.
 */
async function readInput(c: BenchConfig): Promise<BenchInput> {
  const file = fileInput.files?.[0];
  if (file !== undefined) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = await (await loadLib()).probe(bytes);
    return { bytes, label: `${file.name} (${info.sampleRate} Hz, ${info.bitsPerSample}-bit, ${info.channels} ch)`, seconds: info.durationSec };
  }
  const p = preset(c.preset);
  status.textContent = `Generating ${p.label}…`;
  await new Promise((r) => setTimeout(r, 0));
  return { bytes: presetWav(p), label: p.label, seconds: p.seconds };
}

/**
 * Runs on the bench server's Node (`POST /api/node-bench`), reading NDJSON progress.
 * @param c The configuration.
 * @returns The report.
 * @throws {Error} If the server fails.
 */
async function runOnServer(c: BenchConfig): Promise<BenchReport> {
  const res = await fetch('/api/node-bench', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) });
  if (!res.ok || res.body === null) throw new Error(`server: ${res.status} ${await res.text()}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = JSON.parse(buf.slice(0, nl)) as ServerLine;
      buf = buf.slice(nl + 1);
      if ('progress' in line) showProgress('Node', line.progress.mode, line.progress.done, line.progress.total);
      else if ('report' in line) return line.report;
      else throw new Error(line.error);
    }
  }
  throw new Error('server closed the connection without a report');
}

/**
 * Shows run progress.
 * @param env Where it runs.
 * @param mode Mode.
 * @param done Finished runs.
 * @param total Total runs.
 */
function showProgress(env: string, mode: Mode, done: number, total: number): void {
  status.textContent = `${env} · ${MODE_LABEL[mode]}: ${done}/${total} runs`;
}

/**
 * Offers a text as a download.
 * @param name File name.
 * @param text Contents.
 * @param type MIME type.
 */
function download(name: string, text: string, type: string): void {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Renders a report as a card above the previous ones.
 * @param r The report.
 */
function render(r: BenchReport): void {
  const rows = summarize(r);
  const keys = columns(rows);
  const table = h('table', {},
    h('thead', {}, h('tr', {}, ...keys.map((k) => h('th', { scope: 'col' }, SUMMARY_HEADERS[k])))),
    h('tbody', {}, ...rows.map((row, i) => {
      const err = r.results[i]!.error;
      return h('tr', {}, ...(err === null
        ? keys.map((k) => h('td', {}, row[k]))
        : [h('td', {}, row.mode), h('td', { className: 'error', colSpan: keys.length - 1 }, err)]));
    })),
  );
  const md = toMarkdown(r);
  const copy = h('button', { type: 'button', onclick: () => {
    void navigator.clipboard.writeText(md).then(() => { copy.textContent = 'Copied'; });
  } }, 'Copy Markdown');
  const save = h('button', { type: 'button', onclick: () => download(`wav2flac-bench-${r.date.replace(/[:.]/g, '-')}.json`, JSON.stringify(r, null, 2), 'application/json') }, 'Download JSON');
  const extras = r.results.flatMap((m) => [
    ...(m.startupMs === null ? [] : [`${MODE_LABEL[m.mode]} start-up: ${m.startupMs.toFixed(0)} ms`]),
    ...(m.uaMemoryBytes === null ? [] : [`${MODE_LABEL[m.mode]} UA memory: ${fmtBytes(m.uaMemoryBytes)}`]),
  ]);
  const perRun = h('details', {}, h('summary', {}, 'Per-run samples'),
    h('div', { className: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ...['Mode', '#', 'ms', 'Longest block', 'Max RSS', 'Wasm', 'Heap'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...r.results.flatMap((m) => m.samples.map((s, i) => h('tr', {},
        h('td', {}, MODE_LABEL[m.mode]), h('td', {}, String(i + 1)), h('td', {}, s.ms.toFixed(1)),
        h('td', {}, s.maxBlockMs === null ? '–' : `${s.maxBlockMs.toFixed(0)} ms`),
        h('td', {}, s.maxRssKb === null ? '–' : fmtBytes(s.maxRssKb * 1024)),
        h('td', {}, fmtBytes(s.wasmBytes)), h('td', {}, fmtBytes(s.heapBytes)),
      )))),
    )));
  const card = h('section', { className: 'card' },
    h('div', { className: 'report-head' }, h('h2', {}, r.environment), h('div', { className: 'report-tools' }, copy, save)),
    h('p', { className: 'muted' }, `${describe(r)} · ${new Date(r.date).toLocaleTimeString()}`),
    h('div', { className: 'table-wrap' }, table),
    ...(extras.length > 0 ? [h('p', { className: 'muted' }, extras.join(' · '))] : []),
    perRun,
  );
  $('reports').prepend(card);
}

/**
 * Runs a benchmark in this page and renders it. Exposed for automation.
 * @param raw Partial configuration (defaults fill the rest).
 * @param extra Browser-only switches.
 * @param extra.uaMemory Measure UA-specific memory after each mode.
 * @param extra.onRun Also report progress here.
 * @returns The report.
 */
async function runBenchmark(raw: Partial<BenchConfig> = {}, extra: { uaMemory?: boolean; onRun?: OnRun } = {}): Promise<BenchReport> {
  const c = parseConfig(raw);
  const input = await readInput(c);
  const r = await runBrowserBench(c, input, { uaMemory: extra.uaMemory ?? false }, (m, d, t) => {
    showProgress('Browser', m, d, t);
    extra.onRun?.(m, d, t);
  });
  render(r);
  return r;
}
(window as unknown as { runBenchmark: typeof runBenchmark }).runBenchmark = runBenchmark;

/**
 * Handles the form's submit button.
 * @param e The submit event.
 */
async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  start.disabled = true;
  try {
    const c = readForm();
    const t = performance.now();
    if (where() === 'node') {
      status.textContent = 'Starting on the server…';
      render(await runOnServer(c));
    } else {
      await runBenchmark(c, { uaMemory: uaBox.checked });
    }
    status.textContent = `Done in ${((performance.now() - t) / 1000).toFixed(1)} s.`;
  } catch (err) {
    status.innerHTML = '';
    status.append(h('span', { className: 'warn' }, err instanceof Error ? err.message : String(err)));
  } finally {
    start.disabled = false;
  }
}

/**
 * Moves the dot every frame, so a blocked main thread is visible.
 */
function animate(): void {
  const dot = $<HTMLSpanElement>('dot');
  const frame = (t: number): void => {
    const x = (t / 12) % 208;
    dot.style.transform = `translateX(${x > 104 ? 208 - x : x}px)`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/**
 * Builds the selects, applies query parameters and wires events.
 */
function setup(): void {
  const presetSel = $<HTMLSelectElement>('preset');
  for (const p of PRESETS) presetSel.add(new Option(p.label, p.id));
  const levelSel = $<HTMLSelectElement>('level');
  for (let l = 0; l <= 8; l++) levelSel.add(new Option(`${l}${l === 5 ? ' (default)' : ''}`, String(l)));

  const q = new URLSearchParams(location.search);
  const raw: Partial<BenchConfig> = {};
  if (q.has('runs')) raw.runs = Number(q.get('runs'));
  if (q.has('preset')) raw.preset = q.get('preset')!;
  if (q.has('level')) raw.level = Number(q.get('level'));
  if (q.has('output')) raw.output = q.get('output') as BenchConfig['output'];
  if (q.has('transcode')) raw.transcode = q.get('transcode') as BenchConfig['transcode'];
  if (q.has('modes')) raw.modes = q.get('modes')!.split(',') as Mode[];
  if (q.get('warmup') === '0') raw.warmup = false;
  try {
    writeForm(parseConfig(raw));
  } catch (err) {
    status.textContent = `Ignoring query: ${err instanceof Error ? err.message : String(err)}`;
    writeForm(parseConfig({}));
  }

  form.addEventListener('change', syncControls);
  form.addEventListener('submit', (e) => void onSubmit(e));
  syncControls();
  animate();
  loadLib().then(
    (l) => { if (status.textContent === '') status.textContent = `${l.version()} ready${crossOriginIsolated ? ' · cross-origin isolated' : ''}.`; },
    (err: unknown) => {
      status.innerHTML = '';
      status.append(h('span', { className: 'warn' }, `Couldn't load /pkg/esm/index.js (run npm run build): ${err instanceof Error ? err.message : String(err)}`));
      start.disabled = true;
    },
  );
  if (q.get('autorun') === '1') form.requestSubmit();
}

setup();
