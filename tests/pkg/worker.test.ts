// SPDX-License-Identifier: 0BSD
// The package's real worker script, for what only a real worker port can show.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { makeWav } from '../helpers/wav.js';

type Api = typeof import('../../ts/index.js');

const root = resolve(import.meta.dirname, '../..');
const api = (await import(pathToFileURL(join(root, 'pkg/esm/index.js')).href)) as Api;
const wav = makeWav({ frames: 4410, seed: 3 });

const dir = mkdtempSync(join(tmpdir(), 'wav2flac-worker-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('real worker', () => {
  it('fails every job when a message to it cannot be deserialized', async () => {
    // The package's worker, except that its port reports the `init` message as
    // undeserializable, as a browser does for a wasm module it can't share.
    // Static imports, so both listeners are in place before any message.
    writeFileSync(
      join(dir, 'lose-init.mjs'),
      `
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  if (m.t === 'init') parentPort.emit('messageerror', new Error('cannot clone the module'));
});
`,
    );
    const script = join(dir, 'worker.mjs');
    writeFileSync(
      script,
      `
import './lose-init.mjs';
import ${JSON.stringify(pathToFileURL(join(root, 'pkg/esm/worker.js')).href)};
`,
    );
    const w = api.createWorkerEncoder({ url: pathToFileURL(script) });
    try {
      const lost =
        'wav2flac worker: a message to the worker could not be deserialized: ' +
        'cannot clone the module';
      await expect(w.encode(wav.slice())).rejects.toThrow(lost);
      await expect(w.probe(wav)).rejects.toThrow(lost);
      await expect(w.wasmMemoryBytes()).rejects.toThrow(lost);
    } finally {
      w.terminate();
    }
  });
});
