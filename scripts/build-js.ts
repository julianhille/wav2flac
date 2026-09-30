// SPDX-License-Identifier: 0BSD
// Bundles ts/ into pkg/esm (ESM) and pkg/cjs (CommonJS), each also minified
// as *.min.js / *.min.cjs, and emits the type declarations for both. The
// license notices of the Rust crates are in the wasm, not in the bundles. Run
// by scripts/build.sh (Node ≥ 22.18 strips types).
import { build, type Plugin } from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const banner = '// SPDX-License-Identifier: 0BSD';
const common = {
  bundle: true,
  platform: 'neutral' as const,
  target: 'es2022',
  sourcemap: true,
  legalComments: 'none' as const,
  logLevel: 'warning' as const,
  banner: { js: banner },
};

/** `import.meta.url` for the CommonJS build, without a static `require`. */
const cjsImportMetaUrl = `const __wav2flac_import_meta_url = (() => {
  const p = globalThis.process;
  if (typeof __filename === 'string' && typeof p?.getBuiltinModule === 'function') {
    return p.getBuiltinModule('url').pathToFileURL(__filename).href;
  }
  const s = typeof document === 'undefined' ? null : document.currentScript;
  if (s?.src) return s.src;
  return typeof location === 'undefined' ? undefined : location.href;
})();`;

/**
 * Points the worker URLs in worker-client.ts at the bundle's own worker: the
 * `.min` worker from a minified index, and in the CommonJS build Node's
 * worker_threads run worker.cjs while a browser module worker, which cannot
 * run CommonJS, uses the ESM worker.
 * @param min Whether this is the minified build.
 * @param cjs Whether this is the CommonJS build.
 * @returns The plugin.
 */
function workerUrls(min: boolean, cjs: boolean): Plugin {
  const suffix = min ? '.min' : '';
  return {
    name: 'worker-urls',
    setup(b) {
      b.onLoad({ filter: /worker-client\.ts$/ }, (args) => {
        const src = readFileSync(args.path, 'utf8');
        const nodeWorker = "const NODE_WORKER = './worker.js';";
        const browserWorker = "new URL('./worker.js', import.meta.url)";
        if (!src.includes(nodeWorker) || !src.includes(browserWorker)) {
          throw new Error('build-js: worker URLs in worker-client.ts changed; update workerUrls');
        }
        const browserPath = cjs ? `../esm/worker${suffix}.js` : `./worker${suffix}.js`;
        const contents = src
          .replace(nodeWorker, `const NODE_WORKER = './worker${suffix}.${cjs ? 'cjs' : 'js'}';`)
          .replace(browserWorker, `new URL('${browserPath}', import.meta.url)`);
        return { contents, loader: 'ts' };
      });
    },
  };
}

/**
 * Minifying renames the Wav2FlacError class, and consoles print that name
 * (`P [Wav2FlacError]: …`). This sets the name back, in the minified build
 * only, so the normal bundles stay as they are.
 */
const errorName: Plugin = {
  name: 'error-name',
  setup(b) {
    b.onLoad({ filter: /[\\/]lib[\\/]errors\.ts$/ }, (args) => {
      const src = readFileSync(args.path, 'utf8');
      if (!src.includes('export class Wav2FlacError extends Error {')) {
        throw new Error('build-js: Wav2FlacError in errors.ts changed; update errorName');
      }
      const fix = "Object.defineProperty(Wav2FlacError, 'name', { value: 'Wav2FlacError' });";
      return { contents: `${src}\n${fix}\n`, loader: 'ts' };
    });
  },
};

rmSync('pkg/esm', { recursive: true, force: true });
rmSync('pkg/cjs', { recursive: true, force: true });

for (const min of [false, true]) {
  const suffix = min ? '.min' : '';
  const entryPoints = { [`index${suffix}`]: 'ts/index.ts', [`worker${suffix}`]: 'ts/worker.ts' };
  const opts = { ...common, entryPoints, minify: min };
  // The normal ESM build needs no plugin: its worker URLs are right as written.
  const plugins = (cjs: boolean): Plugin[] => [
    ...(min || cjs ? [workerUrls(min, cjs)] : []),
    ...(min ? [errorName] : []),
  ];
  await build({ ...opts, outdir: 'pkg/esm', format: 'esm', plugins: plugins(false) });
  await build({
    ...opts,
    outdir: 'pkg/cjs',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    define: { 'import.meta.url': '__wav2flac_import_meta_url' },
    // The directive must come before the shim, or the whole file is sloppy mode.
    // No `require()`: browser bundlers would try to resolve `node:url`. Outside
    // Node the URL comes from the script tag or the page; bundled code that
    // can't tell passes its wasm to `init()`.
    banner: {
      js: `${common.banner.js}\n"use strict";\n${cjsImportMetaUrl}`,
    },
    plugins: plugins(true),
  });
}

// Declarations: one tsc run, copied as .d.ts (ESM) and .d.cts (CJS).
rmSync('build/types', { recursive: true, force: true });
execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });

/**
 * Lists files below a directory.
 * @param dir Directory.
 * @returns Relative file paths.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p).map((q) => join(f, q)) : [f];
  });
}

for (const f of walk('build/types')) {
  if (f === 'worker.d.ts') continue;
  const src = readFileSync(join('build/types', f), 'utf8');
  if (src.includes('build/bindgen'))
    throw new Error(`declaration ${f} leaks wasm-bindgen internals`);
  const esm = join('pkg/esm', f);
  mkdirSync(join(esm, '..'), { recursive: true });
  cpSync(join('build/types', f), esm);
  const cjs = join('pkg/cjs', f.replace(/\.d\.ts$/, '.d.cts'));
  mkdirSync(join(cjs, '..'), { recursive: true });
  writeFileSync(cjs, src.replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.js(['"])/g, '$1.cjs$2'));
}
