// SPDX-License-Identifier: 0BSD
// The pkg project tests the built package; fail early with a clear message.
import { existsSync } from 'node:fs';

export default function setup(): void {
  const bundles = ['esm/index.js', 'esm/worker.js', 'cjs/index.cjs', 'cjs/worker.cjs'];
  const min = bundles.map((f) => f.replace(/\.c?js$/, '.min$&'));
  for (const f of ['pkg/wav2flac.wasm', ...[...bundles, ...min].map((f) => `pkg/${f}`)]) {
    if (!existsSync(f)) throw new Error(`${f} is missing; run \`npm run build\` first`);
  }
}
