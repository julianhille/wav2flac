// SPDX-License-Identifier: 0BSD
/**
 * Local server for the benchmark page. It serves `bench/index.html`, the page
 * script (bundled by esbuild on each request) and the built package from `pkg/`.
 * It also runs the Node benchmark on request (`POST /api/node-bench`, NDJSON
 * progress). Responses are cross-origin isolated (COOP/COEP), so
 * `performance.measureUserAgentSpecificMemory()` is available. It listens on
 * 127.0.0.1 only.
 *
 * ```sh
 * node bench/server.ts [--port 8787]
 * ```
 * @module
 */
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { runNodeBench } from './node-bench.ts';
import { parseConfig, type BenchConfig } from './shared.ts';

const BENCH = fileURLToPath(new URL('.', import.meta.url));
const PKG = resolve(fileURLToPath(new URL('../pkg/', import.meta.url)));
/** The other libraries compared by the benchmark (dev dependencies), by URL prefix. */
const VENDOR: Readonly<Record<string, string>> = {
  '/vendor/libav/': resolve(fileURLToPath(new URL('../node_modules/@libav.js/variant-flac/dist/', import.meta.url))),
  '/vendor/libflac/': resolve(fileURLToPath(new URL('../node_modules/libflacjs/dist/', import.meta.url))),
};

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.ts': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** Headers on every response: no caching, cross-origin isolation. */
const HEADERS = {
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
};

/** A running bench server. */
export interface BenchServer {
  /** Base URL, e.g. `http://127.0.0.1:8787/`. */
  url: string;
  /** Stops the server. */
  close(): Promise<void>;
}

/**
 * Bundles the page script.
 * @returns JavaScript with an inline source map.
 */
async function bundle(): Promise<string> {
  const r = await build({
    entryPoints: [join(BENCH, 'app.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    write: false,
    sourcemap: 'inline',
    logLevel: 'silent',
  });
  return r.outputFiles[0]!.text;
}

/**
 * Sends a response.
 * @param res The response.
 * @param status HTTP status.
 * @param type Content type.
 * @param body Body.
 */
function send(res: ServerResponse, status: number, type: string, body: string | Uint8Array): void {
  res.writeHead(status, { ...HEADERS, 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Reads a small JSON request body.
 * @param req The request.
 * @returns The parsed body.
 * @throws {Error} If it is larger than 64 KiB or not JSON.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 1 << 16) throw new Error('request too large');
  }
  return JSON.parse(body) as unknown;
}

let busy = false;

/**
 * Whether a request comes from the bench page itself. The endpoint spawns
 * processes, so other web pages must not reach it: a JSON content type makes
 * a cross-origin fetch need a CORS preflight (which is never granted), and
 * the Host and Origin checks stop DNS rebinding.
 * @param req The request.
 * @returns `true` for same-origin JSON requests to a loopback host.
 */
function trusted(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  return (req.headers['content-type'] ?? '').split(';')[0]?.trim() === 'application/json';
}

/**
 * `POST /api/node-bench`: runs the Node benchmark and streams NDJSON lines
 * (`{progress}` …, then `{report}` or `{error}`). One benchmark at a time.
 * @param req The request.
 * @param res The response.
 */
async function nodeBench(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!trusted(req)) {
    send(res, 403, 'text/plain', 'forbidden: only the bench page on this server may start a benchmark');
    return;
  }
  let config: BenchConfig;
  try {
    config = parseConfig(await readJson(req));
  } catch (e) {
    send(res, 400, 'text/plain', e instanceof Error ? e.message : String(e));
    return;
  }
  if (busy) {
    send(res, 409, 'text/plain', 'a benchmark is already running');
    return;
  }
  busy = true;
  res.writeHead(200, { ...HEADERS, 'content-type': 'application/x-ndjson' });
  const line = (x: unknown): void => { res.write(`${JSON.stringify(x)}\n`); };
  try {
    const report = await runNodeBench(config, (mode, done, total) => line({ progress: { mode, done, total } }));
    line({ report });
  } catch (e) {
    line({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    busy = false;
    res.end();
  }
}

/**
 * Serves a file from a directory, refusing paths that escape it.
 * @param dir The directory.
 * @param path URL path below it.
 * @param res The response.
 * @param hint What to run if the file is missing.
 */
async function dirFile(dir: string, path: string, res: ServerResponse, hint: string): Promise<void> {
  const file = resolve(dir, `.${sep}${decodeURIComponent(path)}`);
  if (!file.startsWith(dir + sep)) {
    send(res, 403, 'text/plain', 'forbidden');
    return;
  }
  try {
    send(res, 200, MIME[extname(file)] ?? 'application/octet-stream', await readFile(file));
  } catch {
    send(res, 404, 'text/plain', `not found: ${path} (run ${hint})`);
  }
}

/**
 * Handles one request.
 * @param req The request.
 * @param res The response.
 */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && pathname === '/api/node-bench') return nodeBench(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method not allowed');
  if (pathname === '/' || pathname === '/index.html') return send(res, 200, MIME['.html']!, await readFile(join(BENCH, 'index.html')));
  if (pathname === '/app.js') return send(res, 200, MIME['.js']!, await bundle());
  if (pathname.startsWith('/pkg/')) return dirFile(PKG, pathname.slice('/pkg/'.length), res, 'npm run build');
  for (const [prefix, dir] of Object.entries(VENDOR)) {
    if (pathname.startsWith(prefix)) return dirFile(dir, pathname.slice(prefix.length), res, 'npm ci');
  }
  if (pathname === '/favicon.ico') return send(res, 204, 'text/plain', '');
  return send(res, 404, 'text/plain', 'not found');
}

/**
 * Starts the server.
 * @param port Port (0 = any free port).
 * @returns The running server.
 */
export function startServer(port = 8787): Promise<BenchServer> {
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, 'text/plain', e instanceof Error ? e.message : String(e));
      else res.end();
    });
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address() as AddressInfo;
      ok({
        url: `http://127.0.0.1:${p}/`,
        close: () => new Promise((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : Number(process.env['PORT'] ?? 8787);
  const s = await startServer(port);
  console.log(`wav2flac benchmark: ${s.url}`);
}
