// SPDX-License-Identifier: 0BSD
/**
 * Browser and bundler smoke test of the packed package.
 *
 * `npm pack`s the built package, installs it with Vite and webpack into a
 * temporary app, and loads the same page three ways: unbundled (import
 * map), built by Vite, built by webpack; each once with `wav2flac` and once
 * with the minified bundles (`index.min.js`, `wav2flac/min`). In every
 * browser given by `WAV2FLAC_BROWSERS` (default `chromium`; also `firefox`,
 * `webkit`) the page runs `encode`, `encodeStream`, a worker and raw PCM,
 * and each output must hash to the same bytes as in Node. Each page also runs with
 * `?wasm=/custom/…`, which calls `init(url)` first: then that must be the
 * only wasm the page fetches. Each bundler must emit the package's `.wasm`
 * byte for byte, since its first section holds the license notices.
 *
 * `WAV2FLAC_CHROMIUM` (or `_FIREFOX`, `_WEBKIT`) points at another browser
 * executable.
 *
 * Usage: `npm run build && node tests/browser/run.ts`. Needs network access
 * for `npm install` and the Playwright browsers (`npx playwright install`).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

/** Bundler versions under test (exact, so the run is repeatable). */
const VITE = '8.3.1';
const WEBPACK = '5.111.1';

const root = resolve(import.meta.dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'wav2flac-browser-'));
const app = join(tmp, 'app');

/**
 * Runs a command, inheriting stdio.
 * @param cmd program
 * @param args arguments
 * @param cwd working directory
 */
function sh(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

/**
 * Hex SHA-256.
 * @param b bytes
 * @returns digest
 */
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Expected hashes, computed in Node from the built package. */
async function expected(): Promise<Record<string, string>> {
  const lib = await import(pathToFileURL(join(root, 'pkg/esm/index.js')).href);
  const { testWav, OPTIONS } = await import(pathToFileURL(join(import.meta.dirname, 'app/wav.js')).href);
  await lib.init();
  const wav = testWav();
  const buffered = sha(lib.encodeSync(wav, OPTIONS));
  const stream = sha(new Uint8Array(await new Response(lib.encodeStream(wav, OPTIONS)).arrayBuffer()));
  return { encode: buffered, stream, worker: buffered, pcm: buffered };
}

/**
 * Checks that a bundler emitted the package's `.wasm` unchanged, with the
 * license notices in it.
 * @param dir The bundler's output directory.
 */
function checkWasmCopied(dir: string): void {
  const want = readFileSync(join(root, 'pkg/wav2flac.wasm'));
  const found = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.wasm'));
  if (found.length !== 1) throw new Error(`${dir}: expected one .wasm, found ${found.join(', ') || 'none'}`);
  if (!readFileSync(join(dir, found[0]!)).equals(want)) {
    throw new Error(`${dir}/${found[0]} differs from pkg/wav2flac.wasm`);
  }
}

/** Packs the package and builds the app unbundled, with Vite and with webpack. */
function prepare(): void {
  sh('npm', ['pack', '--silent', '--pack-destination', tmp], root);
  const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (tgz === undefined) throw new Error('npm pack produced no tarball');
  cpSync(join(import.meta.dirname, 'app'), app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  sh('npm', ['install', '--silent', '--no-audit', '--no-fund', join(tmp, tgz),
    `vite@${VITE}`, `webpack@${WEBPACK}`], app);

  // The same page importing 'wav2flac/min', for the bundlers.
  const min = join(app, 'min');
  mkdirSync(min);
  cpSync(join(app, 'index.html'), join(min, 'index.html'));
  cpSync(join(app, 'wav.js'), join(min, 'wav.js'));
  const main = readFileSync(join(app, 'main.js'), 'utf8');
  if (!main.includes("from 'wav2flac';")) throw new Error("main.js no longer imports from 'wav2flac'");
  writeFileSync(join(min, 'main.js'), main.replace("from 'wav2flac';", "from 'wav2flac/min';"));

  for (const [dir, out] of [[app, 'dist-vite'], [min, 'dist-vite-min']] as const) {
    sh('npx', ['vite', 'build', '--base', './', '--outDir', join(app, out), '--emptyOutDir',
      '--logLevel', 'warn'], dir);
    checkWasmCopied(join(app, out));
  }

  for (const [entry, out] of [['./main.js', 'dist-webpack'], ['./min/main.js', 'dist-webpack-min']] as const) {
    writeFileSync(join(app, 'webpack.mjs'), `
import webpack from 'webpack';
webpack({
  mode: 'production', entry: ${JSON.stringify(entry)}, context: ${JSON.stringify(app)},
  output: { path: ${JSON.stringify(join(app, out))}, publicPath: 'auto' },
  performance: { hints: false },
  // Chunks named after their source, so the test can tell which worker went in.
  optimization: { chunkIds: 'named' },
}, (err, stats) => {
  if (err || stats.hasErrors()) { console.error(err ?? stats.toString('errors-only')); process.exit(1); }
});
`);
    sh('node', ['webpack.mjs'], app);
    checkWasmCopied(join(app, out));
    writeFileSync(join(app, out, 'index.html'),
      '<!doctype html><meta charset="utf-8"><script src="./main.js"></script>\n');
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.cjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json',
};

/** Route of the self-hosted wasm copy, for `init(url)`. */
const CUSTOM_WASM = '/custom/route/w2f.wasm';

/**
 * Serves `app/` on 127.0.0.1, plus the package's wasm at {@link CUSTOM_WASM}.
 * @param log receives the path of every request
 * @returns the server's origin and a function that stops it
 */
async function serve(log: string[]): Promise<{ origin: string; close: () => void }> {
  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    let file: string | undefined;
    try {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      log.push(path);
      file = path === CUSTOM_WASM
        ? join(app, 'node_modules/wav2flac/pkg/wav2flac.wasm')
        : join(app, path.endsWith('/') ? `${path}index.html` : path);
    } catch {
      // A malformed escape: fall through to 404.
    }
    const rel = file === undefined ? '..' : relative(app, file);
    if (rel.startsWith('..') || isAbsolute(rel) || !statSync(file!, { throwIfNoEntry: false })?.isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file!)] ?? 'application/octet-stream' });
    res.end(readFileSync(file!));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  return { origin: `http://127.0.0.1:${addr.port}`, close: () => server.close() };
}

const PAGES = {
  'no bundler': '/importmap.html',
  'no bundler, minified': '/importmap-min.html',
  vite: '/dist-vite/',
  'vite, minified': '/dist-vite-min/',
  webpack: '/dist-webpack/',
  'webpack, minified': '/dist-webpack-min/',
};
const ENGINES = { chromium, firefox, webkit };

try {
  const want = await expected();
  prepare();
  const log: string[] = [];
  const { origin, close } = await serve(log);
  const names = (process.env.WAV2FLAC_BROWSERS ?? 'chromium').split(',').map((s) => s.trim());
  let failed = 0;
  try {
    for (const name of names) {
      const engine = ENGINES[name as keyof typeof ENGINES];
      if (engine === undefined) throw new Error(`unknown browser ${name}`);
      // Like the benchmark: WAV2FLAC_CHROMIUM / _FIREFOX / _WEBKIT pick a browser build.
      const executablePath = process.env[`WAV2FLAC_${name.toUpperCase()}`];
      const browser = await engine.launch(executablePath ? { executablePath } : {});
      try {
        for (const [label, path] of Object.entries(PAGES)) {
          for (const custom of [false, true]) {
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on('pageerror', (e) => errors.push(String(e)));
            page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
            log.length = 0;
            let problem = '';
            try {
              await page.goto(origin + path + (custom ? `?wasm=${CUSTOM_WASM}` : ''));
              const got = await page.waitForFunction(() => (window as { result?: unknown }).result,
                null, { timeout: 60_000 }).then((h) => h.jsonValue()) as Record<string, string>;
              const bad = Object.keys(want).filter((k) => got[k] !== want[k]);
              if (got.error !== undefined) problem = got.error;
              else if (bad.length > 0) problem = `mismatch in ${bad.join(', ')}`;
              const wasm = log.filter((p) => p.endsWith('.wasm'));
              if (custom && !problem && (wasm.length === 0 || wasm.some((p) => p !== CUSTOM_WASM))) {
                problem = `expected only ${CUSTOM_WASM}, fetched ${wasm.join(', ') || 'no wasm'}`;
              }
              // The minified index must load the minified worker, and nothing unminified.
              // Bundlers name the worker file after its source: Vite worker.min-<hash>.js,
              // webpack node_modules_wav2flac_pkg_esm_worker_min_js.js.
              const js = log.filter((p) => p.endsWith('.js'));
              const workers = js.filter((p) => p.slice(p.lastIndexOf('/')).includes('worker'));
              const unminified = js.filter((p) => p.includes('/wav2flac/pkg/') && !p.endsWith('.min.js'));
              if (label.endsWith('minified') && !problem && (workers.length === 0
                || workers.some((p) => !/worker[._]min/.test(p)) || unminified.length > 0)) {
                problem = `expected only minified bundles, fetched ${js.join(', ')}`;
              }
            } catch (e) {
              problem = String(e);
            } finally {
              await page.close();
            }
            if (errors.length > 0) problem += ` ${errors.join('; ')}`;
            const ok = problem === '';
            if (!ok) failed++;
            console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} / ${label}${custom ? ' / custom wasm route' : ''}` +
              (ok ? '' : `: ${problem.trim()}`));
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    close();
  }
  if (failed > 0) process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
