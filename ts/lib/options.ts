// SPDX-License-Identifier: 0BSD
/**
 * Public option types and their normalization for the wasm constructor.
 * Types are checked here; value ranges are checked by the Rust core.
 * @module
 */
import { invalidOption, Wav2FlacError } from './errors.js';

/**
 * Whether a value is an object literal (or `Object.create(null)`), as opposed
 * to a `Map`, a class instance or an array, whose entries `Object.entries`
 * would not see.
 * @param v The value.
 * @returns `true` for plain objects.
 */
function isPlainObject(v: object): boolean {
  if (Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null || Object.getPrototypeOf(proto) === null;
}

/** Progress report passed to {@link Options.onProgress}. */
export interface Progress {
  /** WAV bytes consumed so far. */
  bytesIn: number;
  /** Samples per channel encoded so far. */
  samplesOut: number;
  /** Fraction of the WAV `data` chunk consumed (0–1), or `null` until the header is parsed. */
  fraction: number | null;
}

/**
 * Resampler filter quality. Stop band: `'fast'` ≥ 60 dB, `'balanced'` ≥ 90 dB,
 * `'best'` ≥ 110 dB. Downsampling is flat to about 90 % of the new Nyquist on
 * every preset. When upsampling, `'fast'` and `'balanced'` roll off above
 * about 80 % of the input's Nyquist (44.1 → 48 kHz: −4 / −10 dB at 20 kHz);
 * use `'best'` for a flat top octave.
 */
export type ResampleQuality = 'fast' | 'balanced' | 'best';

/**
 * Sample encoding of raw PCM: little-endian, interleaved. `u8` is unsigned
 * (silence = 128), `s24` is packed in 3 bytes, `f32` is nominally −1.0–1.0.
 */
export type PcmSampleFormat = 'u8' | 's16' | 's24' | 's32' | 'f32';

/**
 * Describes raw, headerless PCM input (see {@link Options.pcm}).
 */
export interface PcmFormat {
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Channel count, 1–8, in WAV/FLAC channel order. */
  channels: number;
  /**
   * Sample encoding. Inferred from `Int16Array` (`s16`), `Int32Array` (`s32`)
   * and `Float32Array` (`f32`) input; required for bytes and streams.
   */
  format?: PcmSampleFormat | undefined;
}

/** Encoder options. All are optional; the defaults give lossless level-5 FLAC. */
export interface Options {
  /** 0 (fastest) – 8 (smallest), the libFLAC presets. Default 5. */
  compressionLevel?: number | undefined;
  /** Samples per frame, 16–65535. Default: the level's (1152 or 4096). */
  blockSize?: number | undefined;
  /**
   * Target sample rate in Hz, 1–1 048 575; resamples when it differs from the
   * input. It may be at most 256 times the input rate and at least 1/65536 of
   * it: other ratios fail with `UNSUPPORTED_FORMAT`.
   */
  sampleRate?: number | undefined;
  /** Resampler filter quality. Default `'balanced'`. */
  resampleQuality?: ResampleQuality | undefined;
  /**
   * The input is raw PCM, not WAV. Accepts typed arrays, one typed array per
   * channel (planar), bytes, or a stream (which needs `format`).
   */
  pcm?: PcmFormat | undefined;
  /** Target bit depth, 4–32. Required for float input. */
  bitsPerSample?: number | undefined;
  /**
   * Dither used when samples are requantized: a lower bit depth, float input or
   * resampling. Lossless paths never dither. Default `'tpdf'`.
   */
  dither?: 'tpdf' | 'none' | undefined;
  /** Seed for the dither noise (integer ≥ 0); fixed by default so output is deterministic. */
  ditherSeed?: number | undefined;
  /** Extra/overriding Vorbis comments (an empty string removes a field), or `false` to write no tags. */
  tags?: Record<string, string> | false | undefined;
  /** Seconds between seek points; 0 = no seek table. Default 10. Buffered output only. */
  seekPointInterval?: number | undefined;
  /** Bytes of PADDING for later tag edits; 0 = none. Default 8192. */
  padding?: number | undefined;
  /** Reject inputs larger than this many bytes with `LIMIT_EXCEEDED`. */
  maxInputBytes?: number | undefined;
  /** Cancels the operation; it then rejects/errors with the signal's reason. */
  signal?: AbortSignal | undefined;
  /** Called at most ~20×/s and once at the end. */
  onProgress?: ((progress: Progress) => void) | undefined;
  /**
   * Worker only: copy input instead of transferring it. Transferring (the
   * default) detaches the caller's buffer: an `ArrayBuffer`, a typed array
   * spanning its whole buffer, or such a chunk of a stream input.
   */
  copy?: boolean | undefined;
}

/**
 * Plain, structured-cloneable arguments for the wasm `WasmEncoder` constructor.
 * Not part of the public API, but kept in the declarations because they
 * reference it (so it must not be stripped as internal).
 */
export interface EncoderArgs {
  level: number;
  /** 0 = default. */
  blockSize: number;
  /** 0 = keep. */
  sampleRate: number;
  /** 0 fast, 1 balanced, 2 best. */
  quality: number;
  /** 0 = keep. */
  bits: number;
  dither: boolean;
  seed: number;
  tagsEnabled: boolean;
  tagKeys: string[];
  tagValues: string[];
  seekPointInterval: number;
  padding: number;
  /** -1 = unlimited. */
  maxInputBytes: number;
  streaming: boolean;
  /** 0 = WAV input; else a {@link PCM_FORMATS} index + 1; -1 = PCM, format still to infer. */
  pcmFormat: number;
  pcmChannels: number;
  pcmRate: number;
  /** PCM input length in bytes; -1 = unknown (streams). */
  pcmTotalBytes: number;
}

/** PCM sample formats in wasm constructor order (index + 1). @internal */
export const PCM_FORMATS: readonly PcmSampleFormat[] = ['u8', 's16', 's24', 's32', 'f32'];

const KNOWN: ReadonlySet<string> = new Set<keyof Options>([
  'compressionLevel',
  'blockSize',
  'sampleRate',
  'resampleQuality',
  'bitsPerSample',
  'dither',
  'ditherSeed',
  'tags',
  'seekPointInterval',
  'padding',
  'maxInputBytes',
  'signal',
  'onProgress',
  'copy',
  'pcm',
]);

const QUALITY: Readonly<Record<ResampleQuality, number>> = { fast: 0, balanced: 1, best: 2 };

/**
 * Reads an optional non-negative integer option.
 * @param o Options object.
 * @param key Option name.
 * @param dflt Value when unset.
 * @param max Largest accepted value.
 * @param min Smallest accepted value (the core's "unset" sentinel 0 is never
 * accepted from the user, the default covers it).
 * @returns The value.
 */
function uint(
  o: Record<string, unknown>,
  key: string,
  dflt: number,
  max = 2 ** 32 - 1,
  min = 0,
): number {
  const v = o[key];
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw invalidOption(`${key} must be an integer between ${min} and ${max}`);
  }
  return v;
}

/**
 * Duck-types an `AbortSignal` (also from another realm or a polyfill): the
 * members the encoder actually uses must be there.
 * @param s Candidate.
 * @returns `true` if it can be used as a signal.
 * @internal
 */
export function isSignal(s: unknown): boolean {
  if (typeof s !== 'object' || s === null || !('aborted' in s)) return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o['addEventListener'] === 'function' &&
    typeof o['removeEventListener'] === 'function' &&
    typeof o['throwIfAborted'] === 'function'
  );
}

/**
 * Validates option types and converts them to constructor arguments.
 * @param opts User options.
 * @param streaming Whether the header is emitted first.
 * @returns Normalized arguments.
 * @throws {Wav2FlacError} `INVALID_OPTIONS` for unknown or wrongly typed options.
 * @internal
 */
export function normalizeOptions(
  opts: Options | undefined | null,
  streaming: boolean,
): EncoderArgs {
  if (opts === undefined || opts === null) opts = {};
  if (typeof opts !== 'object' || !isPlainObject(opts))
    throw invalidOption('options must be an object');
  const o = opts as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!KNOWN.has(k)) throw invalidOption(`unknown option "${k}"`);
  }
  const rq = o['resampleQuality'] === undefined ? 'balanced' : o['resampleQuality'];
  if (typeof rq !== 'string' || !Object.hasOwn(QUALITY, rq)) {
    throw invalidOption('resampleQuality must be "fast", "balanced" or "best"');
  }
  const dither = o['dither'] === undefined ? 'tpdf' : o['dither'];
  if (dither !== 'tpdf' && dither !== 'none')
    throw invalidOption('dither must be "tpdf" or "none"');
  const tagKeys: string[] = [];
  const tagValues: string[] = [];
  const tags = o['tags'] === undefined ? {} : o['tags'];
  if (tags !== false) {
    if (typeof tags !== 'object' || tags === null || !isPlainObject(tags)) {
      throw invalidOption('tags must be a plain object or false');
    }
    for (const [k, v] of Object.entries(tags)) {
      if (typeof v !== 'string') throw invalidOption(`tag "${k}" must be a string`);
      tagKeys.push(k);
      tagValues.push(v);
    }
  }
  const spi = o['seekPointInterval'] === undefined ? 10 : o['seekPointInterval'];
  if (typeof spi !== 'number' || !(spi >= 0) || !Number.isFinite(spi)) {
    throw invalidOption('seekPointInterval must be a finite number ≥ 0');
  }
  const signal = o['signal'];
  if (signal !== undefined && !isSignal(signal)) {
    throw invalidOption('signal must be an AbortSignal');
  }
  if (o['onProgress'] !== undefined && typeof o['onProgress'] !== 'function') {
    throw invalidOption('onProgress must be a function');
  }
  if (o['copy'] !== undefined && typeof o['copy'] !== 'boolean')
    throw invalidOption('copy must be a boolean');
  const pcm = normalizePcm(o['pcm']);
  return {
    level: uint(o, 'compressionLevel', 5, 8),
    blockSize: uint(o, 'blockSize', 0, 65535, 16),
    sampleRate: uint(o, 'sampleRate', 0, undefined, 1),
    quality: QUALITY[rq as ResampleQuality],
    bits: uint(o, 'bitsPerSample', 0, 32, 4),
    dither: dither === 'tpdf',
    seed: uint(o, 'ditherSeed', 0x5eedf1ac, Number.MAX_SAFE_INTEGER),
    tagsEnabled: tags !== false,
    tagKeys,
    tagValues,
    seekPointInterval: spi,
    padding: uint(o, 'padding', 8192),
    maxInputBytes: uint(o, 'maxInputBytes', -1, Number.MAX_SAFE_INTEGER),
    streaming,
    ...pcm,
  };
}

/**
 * Validates the `pcm` option's types.
 * @param v The option value.
 * @returns The PCM constructor arguments (all zero for WAV input).
 * @throws {Wav2FlacError} `INVALID_OPTIONS` for a malformed `pcm` object.
 */
function normalizePcm(
  v: unknown,
): Pick<EncoderArgs, 'pcmFormat' | 'pcmChannels' | 'pcmRate' | 'pcmTotalBytes'> {
  if (v === undefined) return { pcmFormat: 0, pcmChannels: 0, pcmRate: 0, pcmTotalBytes: -1 };
  if (typeof v !== 'object' || v === null || !isPlainObject(v))
    throw invalidOption('pcm must be a plain object');
  const p = v as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (k !== 'sampleRate' && k !== 'channels' && k !== 'format')
      throw invalidOption(`unknown pcm option "${k}"`);
  }
  for (const [k, max] of [
    ['sampleRate', 2 ** 32 - 1],
    ['channels', Number.MAX_SAFE_INTEGER],
  ] as const) {
    const n = p[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) {
      throw invalidOption(`pcm.${k} must be a positive integer`);
    }
  }
  // Any count above 8 gets the code and message of a WAV file with too many channels.
  if ((p['channels'] as number) > 8) {
    throw new Wav2FlacError(
      'TOO_MANY_CHANNELS',
      `${String(p['channels'])} channels (FLAC supports at most 8)`,
    );
  }
  const f = p['format'];
  let pcmFormat = -1;
  if (f !== undefined) {
    pcmFormat = PCM_FORMATS.indexOf(f as PcmSampleFormat) + 1;
    if (pcmFormat === 0) throw invalidOption(`pcm.format must be one of ${PCM_FORMATS.join(', ')}`);
  }
  return {
    pcmFormat,
    pcmChannels: p['channels'] as number,
    pcmRate: p['sampleRate'] as number,
    pcmTotalBytes: -1,
  };
}
