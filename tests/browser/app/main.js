// SPDX-License-Identifier: 0BSD
// Browser smoke test: every public path must give the same bytes as Node.
import { createWorkerEncoder, encode, encodeStream, init } from 'wav2flac';
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
 * Runs every path and reports hashes (or the error) on `window.result`.
 * @returns {Promise<void>}
 */
async function run() {
  // `?wasm=/some/path.wasm` loads the wasm from a custom route; everything
  // after that, workers included, must reuse it.
  const custom = new URLSearchParams(location.search).get('wasm');
  if (custom !== null) await init(new URL(custom, location.href));
  const wav = testWav();
  const out = {};
  out.encode = await hash(await encode(wav, OPTIONS));
  // Streamed output has no seek table or MD5; compare it on its own.
  out.stream = await hash(new Uint8Array(await new Response(encodeStream(wav, OPTIONS)).arrayBuffer()));
  const w = createWorkerEncoder();
  try {
    out.worker = await hash(await w.encode(wav, { ...OPTIONS, copy: true }));
  } finally {
    w.terminate();
  }
  const pcm = new Int16Array(wav.buffer, 44);
  out.pcm = await hash(await encode(pcm, { ...OPTIONS, pcm: { sampleRate: 44100, channels: 2 } }));
  window.result = out;
}

run().catch((e) => { window.result = { error: String(e && e.stack || e) }; });
