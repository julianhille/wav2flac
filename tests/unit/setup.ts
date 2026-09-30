// SPDX-License-Identifier: 0BSD
// Unit tests run against the TypeScript sources with the unoptimized
// wasm-bindgen output (build/bindgen), initialized once per test file.
import { readFileSync } from 'node:fs';
import { afterEach, expect, vi } from 'vitest';
import { liveSessions } from '../../ts/lib/engine.js';
import { initSync } from '../../ts/lib/wasm.js';

initSync(readFileSync('build/bindgen/wav2flac_bg.wasm'));

// Every test must free the wasm encoders it created, on every exit path.
// wasm memory never shrinks, so only this count can show a leak. Worker jobs
// finish on the host after the client has settled, hence the wait.
afterEach(async () => {
  // oxlint-disable-next-line vitest/no-standalone-expect -- a hook of every test
  await vi.waitFor(() => expect(liveSessions(), 'wasm encoders left alive').toBe(0));
});
