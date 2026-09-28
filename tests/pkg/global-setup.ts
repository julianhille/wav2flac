// SPDX-License-Identifier: 0BSD
// The pkg project tests the built package; fail early with a clear message.
import { existsSync } from 'node:fs';

export default function setup(): void {
  for (const f of ['pkg/wav2flac.wasm', 'pkg/esm/index.js', 'pkg/esm/worker.js', 'pkg/cjs/index.cjs', 'pkg/cjs/worker.cjs']) {
    if (!existsSync(f)) throw new Error(`${f} is missing; run \`npm run build\` first`);
  }
}
