// SPDX-License-Identifier: 0BSD
/**
 * Shared fast-check settings. Runs scale with WAV2FLAC_TEST_TIER. The quick
 * tier (every push) uses a fixed seed so its runtime and coverage are stable;
 * the full and soak tiers explore new cases on every run. On failure
 * fast-check prints the seed and path; replay with FC_SEED=<seed> and
 * FC_PATH=<path>.
 * @module
 */
import type fc from 'fast-check';
import { tier } from './tools.js';

/**
 * Reads FC_SEED; unset or empty means none.
 * @returns The seed.
 * @throws {Error} If it is not an integer (`Number('')` would quietly be 0).
 */
function readSeed(): number | undefined {
  const v = process.env['FC_SEED'] ?? '';
  if (v === '') return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n))
    throw new Error(`FC_SEED must be an integer, not ${JSON.stringify(v)}`);
  return n;
}

const RUNS = { quick: 1, full: 10, soak: 100 }[tier];
const SEED = readSeed() ?? (tier === 'quick' ? 0x5eed : undefined);
const PATH = process.env['FC_PATH'] || undefined;

/**
 * fast-check parameters for a property.
 * @param base Runs in the quick tier.
 * @returns The parameters.
 * @throws {RangeError} If `base` is not a positive integer.
 */
export function params(base: number): fc.Parameters<unknown> {
  if (!Number.isInteger(base) || base < 1) throw new RangeError(`params: ${base} runs`);
  return {
    numRuns: base * RUNS,
    ...(SEED === undefined ? {} : { seed: SEED }),
    ...(PATH === undefined ? {} : { path: PATH }),
  };
}
