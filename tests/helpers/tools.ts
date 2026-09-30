// SPDX-License-Identifier: 0BSD
/**
 * External reference tools for the JS tests (flac CLI, native example).
 * A missing tool skips its check with a warning, unless WAV2FLAC_REQUIRE_TOOLS=1.
 * @module
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Whether missing tools must fail the test run. */
export const requireTools = process.env['WAV2FLAC_REQUIRE_TOOLS'] === '1';

/**
 * Reads WAV2FLAC_TEST_TIER; unset or empty means quick.
 * @returns The tier.
 * @throws {Error} For any other value, so a typo cannot quietly run the quick tier.
 */
function readTier(): 'quick' | 'full' | 'soak' {
  const v = process.env['WAV2FLAC_TEST_TIER'] ?? '';
  if (v === '') return 'quick';
  if (v === 'quick' || v === 'full' || v === 'soak') return v;
  throw new Error(`WAV2FLAC_TEST_TIER must be quick, full or soak, not ${JSON.stringify(v)}`);
}

/** Test tier: quick, full or soak. */
export const tier = readTier();

/**
 * Checks that a command exists.
 * @param cmd Command.
 * @returns `true` if it runs.
 */
export function has(cmd: string): boolean {
  const ok = spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
  if (!ok && requireTools)
    throw new Error(`required tool "${cmd}" is missing (WAV2FLAC_REQUIRE_TOOLS=1)`);
  if (!ok && !warned.has(cmd)) {
    warned.add(cmd);
    console.warn(`wav2flac tests: "${cmd}" not installed, its checks are skipped`);
  }
  return ok;
}
const warned = new Set<string>();

/**
 * Runs `flac -t` on the bytes.
 * @param flac FLAC file.
 * @returns `null` if flac is unavailable, else the error output (empty when valid).
 */
export function flacTest(flac: Uint8Array): string | null {
  if (!has('flac')) return null;
  const r = spawnSync('flac', ['-t', '-s', '-'], { input: flac });
  return r.status === 0 ? '' : r.stderr.toString() || `exit ${r.status}`;
}

/**
 * Decodes FLAC to its samples with `flac -d`.
 * @param flac FLAC file.
 * @returns The interleaved samples, or `null` if flac is unavailable.
 */
export function flacDecode(flac: Uint8Array): Int32Array | null {
  if (!has('flac')) return null;
  const raw = ['--force-raw-format', '--endian=little', '--sign=signed'];
  const r = spawnSync('flac', ['-d', '-c', '-s', ...raw, '-'], { input: flac, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(r.stderr.toString() || `flac -d: exit ${r.status}`);
  // STREAMINFO follows the 4-byte marker and a 4-byte block header.
  const bits = (((flac[20]! & 1) << 4) | (flac[21]! >> 4)) + 1;
  const width = Math.ceil(bits / 8);
  const out = new Int32Array(r.stdout.length / width);
  for (let i = 0; i < out.length; i++) out[i] = r.stdout.readIntLE(i * width, width);
  return out;
}

/** Path of the native reference encoder (built by `cargo build --release --example encode`). */
export const NATIVE = 'target/release/examples/encode';

/**
 * Why the native reference build cannot be used, if it cannot.
 * @returns `'not built'`, `'out of date'` or `null` when it is usable.
 */
function nativeProblem(): string | null {
  if (!existsSync(NATIVE)) return 'not built';
  const built = statSync(NATIVE).mtimeMs;
  const sources = [
    ...readdirSync('src', { recursive: true, encoding: 'utf8' }).map((f) => join('src', f)),
    'examples/encode.rs',
    'Cargo.toml',
    'Cargo.lock',
  ];
  // A binary older than the sources would compare the wasm against old code.
  return sources.some((f) => statSync(f).mtimeMs > built) ? 'out of date' : null;
}
let native: string | null | undefined;

/**
 * Encodes with the native reference build.
 * @param wav WAV bytes.
 * @param args Extra CLI arguments.
 * @returns The FLAC bytes, or `null` if the example is not built or is older than the sources.
 */
export function nativeEncode(wav: Uint8Array, args: string[] = []): Uint8Array | null {
  native ??= nativeProblem();
  if (native !== null) {
    const fix = 'run cargo build --release --example encode';
    if (requireTools) throw new Error(`${NATIVE} ${native}; ${fix}`);
    if (!warned.has(NATIVE)) {
      warned.add(NATIVE);
      console.warn(`wav2flac tests: ${NATIVE} ${native} (${fix}), native comparisons are skipped`);
    }
    return null;
  }
  const r = spawnSync(NATIVE, ['-', '-', ...args], { input: wav, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return new Uint8Array(r.stdout);
}
