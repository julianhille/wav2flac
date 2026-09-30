// SPDX-License-Identifier: 0BSD
// The worker pool of docs/how-to/parallel-encoding.md, run as it is printed,
// on real workers of the built package: a file that is not a WAV and a worker
// that dies must fail only their own job, and a dead worker is replaced.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { asScript, jsBlocks, run } from '../helpers/samples.js';
import { makeWav } from '../helpers/wav.js';

type Api = typeof import('../../ts/index.js');

const root = resolve(import.meta.dirname, '../..');
const api = (await import(pathToFileURL(join(root, 'pkg/esm/index.js')).href)) as Api;
const [poolCode = '', batchCode = ''] = jsBlocks(
  join(root, 'docs/how-to/parallel-encoding.md'),
  2,
).map(asScript);

// The package's worker, except that it exits as soon as it gets a job whose
// input starts with "CRSH", like a worker killed by running out of memory.
// Both listeners are registered by static imports, in this order, before the
// worker takes any message: after an `await import()`, the package's listener
// could miss the `init` message (it does on Node 22.12), and the worker hangs.
const dir = mkdtempSync(join(tmpdir(), 'wav2flac-pool-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const crashingWorker = join(dir, 'worker.mjs');
writeFileSync(
  join(dir, 'crash.mjs'),
  `
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  if (m.t === 'job' && m.input !== null && new TextDecoder().decode(m.input.subarray(0, 4)) === 'CRSH') {
    process.exit(1);
  }
});
`,
);
writeFileSync(
  crashingWorker,
  `
import './crash.mjs';
import ${JSON.stringify(pathToFileURL(join(root, 'pkg/esm/worker.js')).href)};
`,
);

const OPTIONS = { compressionLevel: 8 };
const wav = (i: number): Uint8Array<ArrayBuffer> => makeWav({ frames: 22050, seed: i });
const notWav = (): Uint8Array => new TextEncoder().encode('not a wav file');
const crash = (): Uint8Array => new TextEncoder().encode('CRSH');

describe('worker pool sample on real workers', () => {
  it('fails only the files that are bad or crash their worker', async () => {
    await api.init();
    const bad = new Set([5, 17]);
    const crashing = new Set([0, 11, 30]);
    const files = Array.from({ length: 40 }, (_, i) =>
      bad.has(i) ? notWav() : crashing.has(i) ? crash() : wav(i),
    );
    let spawned = 0;
    const logged: unknown[] = [];
    const results = (await run(`${poolCode}\n${batchCode}\nreturn results;`, {
      createWorkerEncoder: () => {
        spawned++;
        return api.createWorkerEncoder({ url: crashingWorker });
      },
      navigator: { hardwareConcurrency: 4 },
      files,
      console: { error: (msg: string) => logged.push(msg) },
    })) as PromiseSettledResult<Uint8Array>[];

    expect(results).toHaveLength(40);
    for (const [i, r] of results.entries()) {
      if (bad.has(i)) {
        expect(r.status === 'rejected' && r.reason, `file ${i}`).toBeInstanceOf(api.Wav2FlacError);
      } else if (crashing.has(i)) {
        expect(r.status === 'rejected' && String(r.reason), `file ${i}`).toMatch(
          /worker exited with code 1/,
        );
      } else {
        expect(r.status, `file ${i}`).toBe('fulfilled');
        expect(r.status === 'fulfilled' && r.value, `file ${i}`).toEqual(
          api.encodeSync(wav(i), OPTIONS),
        );
      }
    }
    expect(logged).toEqual(
      [...bad, ...crashing].sort((a, b) => a - b).map((i) => `file ${i} failed`),
    );
    // Three workers, and one more for each that died.
    expect(spawned).toBe(3 + crashing.size);
  });

  it('encodes 40 files on three workers, in input order', async () => {
    const files = Array.from({ length: 40 }, (_, i) => wav(i));
    const pool = (await run(`${poolCode}\nreturn createEncoderPool(3);`, {
      createWorkerEncoder: api.createWorkerEncoder,
      navigator: {},
    })) as { encode(input: Uint8Array, o: object): Promise<Uint8Array>; terminate(): void };
    try {
      const flacs = await Promise.all(files.map((f) => pool.encode(f, OPTIONS)));
      expect(flacs).toEqual(files.map((_, i) => api.encodeSync(wav(i), OPTIONS)));
    } finally {
      pool.terminate();
    }
  });
});
