// SPDX-License-Identifier: 0BSD
// The CDN how-to in a browser: the package comes from another origin (the
// import map in cdn.html), and the worker starts through the docs' blob:
// snippet (cdn-worker.js). run.ts writes both once it knows that origin.
import { createWorkerEncoder, encode } from 'wav2flac';
import { encoder } from './cdn-worker.js';
import { OPTIONS, testWav } from './wav.js';

/**
 * Hex SHA-256 of some bytes.
 * @param {Uint8Array} b bytes
 * @returns {Promise<string>} digest
 */
async function hash(b) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Encodes on the page and in the blob: worker, and tries the default worker,
 * which the browser must refuse. Reports on `window.result`.
 * @returns {Promise<void>}
 */
async function run() {
  const wav = testWav();
  const out = {};
  out.encode = await hash(await encode(wav, OPTIONS));
  try {
    out.worker = await hash(await encoder.encode(wav, { ...OPTIONS, copy: true }));
  } finally {
    encoder.terminate();
  }
  let w;
  try {
    w = createWorkerEncoder();
    await w.encode(wav, { ...OPTIONS, copy: true });
    out.defaultWorker = 'started';
  } catch (e) {
    out.defaultWorker = 'refused';
    out.defaultWorkerError = String(e);
  } finally {
    w?.terminate();
  }
  window.result = out;
}

run().catch((e) => { window.result = { error: String(e && e.stack || e) }; });
