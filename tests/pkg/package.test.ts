// SPDX-License-Identifier: 0BSD
// The package as consumers get it: `npm pack`, installed into a scratch
// project and loaded from there. Covers the ESM and CJS entry points resolved
// by name, the real worker script, the default wasm location, the exports map
// and the published type declarations.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collect, makeWav } from '../helpers/wav.js';

type Api = typeof import('../../ts/index.js');

const root = resolve(import.meta.dirname, '../..');
const wav = makeWav({ frames: 44100, channels: 2, bits: 16, seed: 7 });

/**
 * Runs a command and returns its stdout.
 * @param cmd Command.
 * @param args Arguments.
 * @param cwd Working directory.
 * @param input Bytes for stdin.
 * @returns The output.
 * @throws {Error} With the command's output if it fails.
 */
function run(cmd: string, args: string[], cwd: string, input?: Uint8Array): Buffer {
  const r = spawnSync(cmd, args, { cwd, input, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${String(r.stdout)}${String(r.stderr)}`);
  return r.stdout;
}

// Pack and install once; every test below uses the installed copy.
const consumer = mkdtempSync(join(tmpdir(), 'wav2flac-consumer-'));
afterAll(() => rmSync(consumer, { recursive: true, force: true }));
const packArgs = ['pack', '--json', '--ignore-scripts', '--pack-destination', consumer];
const [packed] = JSON.parse(String(run('npm', packArgs, root))) as { filename: string; files: { path: string }[] }[];
const packedFiles = new Set(packed!.files.map((f) => f.path));
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
const installArgs = ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock'];
run('npm', [...installArgs, join(consumer, packed!.filename)], consumer);
const installed = join(consumer, 'node_modules/wav2flac');

const esm = (await import(join(installed, 'pkg/esm/index.js'))) as Api;
const cjs = createRequire(join(consumer, 'index.js'))('wav2flac') as Api;

describe('installed package', () => {
  it('packs the license, the notices and the changelog, and nothing from the sources', () => {
    for (const f of ['LICENSE', 'CHANGELOG.md', 'README.md', 'pkg/THIRD_PARTY_LICENSES.txt', 'pkg/wav2flac.wasm']) {
      expect(packedFiles.has(f), f).toBe(true);
    }
    expect([...packedFiles].filter((f) => /^(src|ts|tests|target|build)\//.test(f))).toEqual([]);
  });

  it('has no require() in the CommonJS build, so browser bundlers need no Node shims', () => {
    for (const f of ['index.cjs', 'worker.cjs']) {
      const src = readFileSync(join(installed, 'pkg/cjs', f), 'utf8');
      expect(src, f).not.toMatch(/\brequire\s*\(/);
    }
  });

  it('packs every file package.json points to', () => {
    const pj = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as Record<string, unknown>;
    const targets: string[] = [];
    const walk = (x: unknown): void => {
      if (typeof x === 'string') targets.push(x);
      else if (typeof x === 'object' && x !== null) Object.values(x).forEach(walk);
    };
    walk([pj['main'], pj['module'], pj['types'], pj['sideEffects'], pj['exports']]);
    expect(targets.length).toBeGreaterThan(8);
    for (const t of targets) {
      expect(packedFiles.has(t.replace(/^\.\//, '')), t).toBe(true);
      expect(existsSync(join(installed, t)), t).toBe(true);
    }
  });

  it('ships the license notices of the Rust crates in the wasm', () => {
    const text = readFileSync(join(installed, 'pkg/THIRD_PARTY_LICENSES.txt'), 'utf8');
    for (const name of ['hound', 'libflac-rs', 'rubato', 'wasm-bindgen']) {
      expect(text).toMatch(new RegExp(`^${name} \\d`, 'm'));
    }
    // The parts of the standard library that the wasm links, each with its notices.
    for (const part of ['core, alloc, std', 'dlmalloc', 'compiler_builtins, libm']) {
      expect(text).toMatch(new RegExp(`^Rust standard library \\S+: ${part}$`, 'm'));
    }
    expect(text).toContain('Copyright © 1991-2024 Unicode, Inc.');
    expect(text).toContain('Copyright (c) 2014 Alex Crichton');
    expect(text).toContain('---- LLVM Exceptions to the Apache 2.0 License ----');
    expect(text).toContain('Copyright © 2005-2020 Rich Felker, et al.');
  });

  it('puts the BSD and MIT notices at the head of every bundle', () => {
    for (const f of ['esm/index.js', 'esm/worker.js', 'cjs/index.cjs', 'cjs/worker.cjs']) {
      const head = readFileSync(join(installed, 'pkg', f), 'utf8').split('*/')[0] as string;
      expect(head, f).toMatch(/^\/\/ SPDX-License-Identifier: 0BSD\n\/\*!\n \* @license\n/);
      expect(head, f).toMatch(/^ \* {3}libflac-rs \S+ \(BSD-3-Clause\)$/m);
      expect(head, f).toContain(' * Copyright (c) 2026, Dani Sarfati');
      expect(head, f).toContain(' * Copyright (C) 2000-2009 Josh Coalson, Copyright (C) 2011-2023 Xiph.Org');
      expect(head, f).toContain(' * 2. Redistributions in binary form must reproduce the above copyright notice,');
      expect(head, f).toContain(' * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"');
      // MIT-only crates and the Rust standard library need their notice too.
      for (const mit of ['generic-array', 'windowfunctions', 'Rust standard library']) {
        expect(head, f).toMatch(new RegExp(`^ \\* ${mit} .*\\(MIT.*\\):$`, 'm'));
      }
      expect(head, f).toContain(' * Copyright (c) The Rust Project Contributors');
      expect(head, f).toContain(' * Copyright (c) 2014 Alex Crichton');
      expect(head, f).toContain(' *       Copyright (c) 2009-2016 by the contributors listed in CREDITS.TXT');
      expect(head, f).toContain(' *     Copyright (c) 2018 Jorge Aparicio');
      // One copy of the MIT permission notice serves every crate under it.
      expect(head.split('Permission is hereby granted, free of charge').length - 1, f).toBe(1);
      expect(head, f).toMatch(/^ \* OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE$/m);
      // The banner points to the notices file for the long Apache-2.0 text.
      expect(head, f).not.toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION');
    }
  });

  it('starts the CJS bundles with the "use strict" directive', () => {
    for (const f of ['cjs/index.cjs', 'cjs/worker.cjs']) {
      const text = readFileSync(join(installed, 'pkg', f), 'utf8');
      // Only comments may precede the directive, or it is a plain expression.
      const code = text.replace(/^(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\n?)*/, '');
      expect(code.startsWith('"use strict";\n'), f).toBe(true);
    }
  });

  it('encodes identically from ESM and CJS with the default wasm', async () => {
    await esm.init();
    cjs.initSync();
    const ref = esm.encodeSync(wav);
    expect(await esm.encode(wav)).toEqual(ref);
    expect(cjs.encodeSync(wav)).toEqual(ref);
    expect(esm.version()).toBe(cjs.version());
  });

  it('resolves by name from ESM and CJS consumers, workers included', () => {
    writeFileSync(join(consumer, 'consumer.mjs'), `
      import { readFileSync } from 'node:fs';
      import { createWorkerEncoder, encodeSync, init } from 'wav2flac';
      const wav = readFileSync(0);
      await init();
      const out = encodeSync(wav);
      const w = createWorkerEncoder();
      const viaWorker = await w.encode(wav.slice());
      w.terminate();
      if (Buffer.compare(out, viaWorker) !== 0) throw new Error('worker output differs');
      readFileSync(new URL(import.meta.resolve('wav2flac/wasm')));
      readFileSync(new URL(import.meta.resolve('wav2flac/package.json')));
      process.stdout.write(out);
    `);
    writeFileSync(join(consumer, 'consumer.cjs'), `
      const { readFileSync } = require('node:fs');
      const { createWorkerEncoder, encodeSync, initSync } = require('wav2flac');
      (async () => {
        const wav = readFileSync(0);
        initSync();
        const out = encodeSync(wav);
        const w = createWorkerEncoder();
        const viaWorker = await w.encode(wav.slice());
        w.terminate();
        if (Buffer.compare(out, viaWorker) !== 0) throw new Error('worker output differs');
        readFileSync(require.resolve('wav2flac/wasm'));
        readFileSync(require.resolve('wav2flac/package.json'));
        process.stdout.write(out);
      })().catch((e) => { console.error(e); process.exit(1); });
    `);
    const ref = esm.encodeSync(wav);
    for (const f of ['consumer.mjs', 'consumer.cjs']) {
      expect(new Uint8Array(run(process.execPath, [f], consumer, wav)), f).toEqual(ref);
    }
  });

  it.each([['ESM', esm], ['CJS', cjs]])('runs the real worker script (%s)', async (_, api) => {
    const w = api.createWorkerEncoder();
    try {
      expect(await w.encode(wav.slice())).toEqual(esm.encodeSync(wav));
      expect(await w.probe(wav.slice())).toMatchObject({ channels: 2, sampleRate: 44100 });
    } finally {
      w.terminate();
    }
  });

  it('keeps the JS heap and wasm memory flat over repeated runs', async () => {
    const rawGc = (globalThis as { gc?: () => void }).gc;
    if (rawGc === undefined) throw new Error('the pkg project runs with --expose-gc');
    // Backing stores of collected buffers are released by finalizers that run
    // in later tasks; collect over a few event-loop turns so `arrayBuffers`
    // only counts what is really still reachable.
    const gc = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) {
        rawGc();
        await new Promise((r) => setImmediate(r));
      }
    };
    const small = makeWav({ frames: 4410, seed: 2 });
    const round = async (): Promise<void> => {
      for (let i = 0; i < 50; i++) {
        await esm.encode(small);
        esm.encodeSync(small);
        await collect(esm.encodeStream(small));
        await esm.encode(small.subarray(0, 1000)).catch(() => 0);
        const r = esm.encodeStream(small).getReader();
        await r.read();
        await r.cancel();
      }
    };
    await round(); // warm up
    await gc();
    const before = process.memoryUsage();
    const wasm = esm.wasmMemoryBytes();
    for (let i = 0; i < 4; i++) await round();
    await gc();
    const after = process.memoryUsage();
    // A retained output or encoder per run would add megabytes here.
    expect(esm.wasmMemoryBytes()).toBe(wasm);
    expect(after.heapUsed - before.heapUsed).toBeLessThan(4 << 20);
    expect(after.arrayBuffers - before.arrayBuffers).toBeLessThan(4 << 20);
  });

  it('type-checks for strict consumers without skipLibCheck', () => {
    const use = `
      const o: Options = { compressionLevel: 5, pcm: { sampleRate: 16000, channels: 1 }, bitsPerSample: 16 };
      export const a: Promise<Uint8Array> = encode(new Float32Array(8), o);
      export const b: ReadableStream<Uint8Array> = encodeStream(new Uint8Array(0));
      export const w: WorkerEncoder = createWorkerEncoder();
      export const e: ErrorCode = new Wav2FlacError('INVALID_OPTIONS', 'x').code;
      export const i: Promise<WavInfo> = probe(new Uint8Array(0));
      // The README's patterns: outputs are ArrayBuffer-backed, so Blob,
      // Response and transfer lists take them as they are.
      export const blob = async (): Promise<Blob> => new Blob([await encode(new Uint8Array(0))]);
      export const res = async (): Promise<Response> => new Response(await encode(new Uint8Array(0)));
      export const buf = async (): Promise<ArrayBuffer> => (await encode(new Uint8Array(0))).buffer;
      export const chunk = async (): Promise<Blob> => {
        const r = await encodeStream(new Uint8Array(0)).getReader().read();
        return new Blob(r.done ? [] : [r.value]);
      };
      export const bytes: Bytes = new Uint8Array(0);
      // Every option also takes undefined for "not set", as the code does.
      declare const maybe: { signal?: AbortSignal; level?: number; url?: string };
      export const unset = encode(new Uint8Array(0), {
        signal: maybe.signal, compressionLevel: maybe.level, onProgress: undefined, tags: undefined,
      });
      export const unsetWorker: WorkerEncoder = createWorkerEncoder({ url: maybe.url, wasm: undefined });
    `;
    const names = '{ createWorkerEncoder, encode, encodeStream, probe, Wav2FlacError, '
      + 'type Bytes, type ErrorCode, type Options, type WavInfo, type WorkerEncoder }';
    writeFileSync(join(consumer, 'esm.mts'), `import ${names} from 'wav2flac';\n${use}`);
    writeFileSync(join(consumer, 'cjs.cts'), `import ${names} from 'wav2flac';\n${use}`);
    for (const mode of ['node16', 'bundler']) {
      writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: false, types: [], lib: ['es2022', 'dom'],
          module: mode === 'node16' ? 'node16' : 'preserve', moduleResolution: mode,
        },
        files: mode === 'node16' ? ['esm.mts', 'cjs.cts'] : ['esm.mts'],
      }));
      const r = spawnSync(join(root, 'node_modules/.bin/tsc'), ['-p', consumer], { encoding: 'utf8' });
      expect(r.stdout + r.stderr, mode).toBe('');
      expect(r.status, mode).toBe(0);
    }
  });
});
