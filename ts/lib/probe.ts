// SPDX-License-Identifier: 0BSD
/**
 * WAV header inspection.
 * @module
 */
import { fromWasmError, Wav2FlacError } from './errors.js';
import { probeJson } from '../../build/bindgen/wav2flac.js';

/** Description of a WAV file, as returned by `probe`. */
export interface WavInfo {
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Channel count, 1–8. */
  channels: number;
  /** Valid bits per sample (4–32). */
  bitsPerSample: number;
  /** Sample format. Float input needs the `bitsPerSample` option to encode. */
  format: 'int' | 'float';
  /** Sample frames (samples per channel) in the `data` chunk. */
  frames: number;
  /** Duration in seconds. */
  durationSec: number;
  /** `WAVE_FORMAT_EXTENSIBLE` channel mask, or `null` for plain PCM. */
  channelMask: number | null;
  /** LIST/INFO tags mapped to Vorbis comment names (e.g. `TITLE`). */
  tags: Record<string, string>;
}

/** Size of the first header read attempt. */
const FIRST_TRY = 64 * 1024;

/**
 * Parses the WAV header, reading only as much of `bytes` as needed.
 * @param bytes The WAV file (or at least its beginning up to the `data` chunk).
 * @returns The description.
 * @throws {Wav2FlacError} For invalid or unsupported headers.
 * @internal
 */
export function probeBytes(bytes: Uint8Array): WavInfo {
  for (let n = Math.min(FIRST_TRY, bytes.length); ; n = Math.min(n * 4, bytes.length)) {
    try {
      return JSON.parse(probeJson(bytes.subarray(0, n))) as WavInfo;
    } catch (e) {
      const err = fromWasmError(e);
      if (!(err instanceof Wav2FlacError && err.code === 'TRUNCATED' && n < bytes.length)) throw err;
    }
  }
}
