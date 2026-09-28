// SPDX-License-Identifier: 0BSD
/**
 * Error types and conversion of errors crossing the wasm and worker boundaries.
 * @module
 */

/** Stable, machine-readable error codes. */
export type ErrorCode =
  | 'INVALID_WAV'
  | 'UNSUPPORTED_FORMAT'
  | 'UNSUPPORTED_BIT_DEPTH'
  | 'TOO_MANY_CHANNELS'
  | 'TRUNCATED'
  | 'INVALID_OPTIONS'
  | 'ENCODER_STATE'
  | 'LIMIT_EXCEEDED'
  | 'INTERNAL';

const CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'INVALID_WAV', 'UNSUPPORTED_FORMAT', 'UNSUPPORTED_BIT_DEPTH', 'TOO_MANY_CHANNELS',
  'TRUNCATED', 'INVALID_OPTIONS', 'ENCODER_STATE', 'LIMIT_EXCEEDED', 'INTERNAL',
]);

/**
 * Checks whether a string is a known {@link ErrorCode}.
 * @param code Candidate code.
 * @returns `true` if `code` is an error code.
 */
function isErrorCode(code: string | undefined): code is ErrorCode {
  return code !== undefined && CODES.has(code);
}

/**
 * Error raised for invalid input, unsupported formats and invalid options.
 *
 * Other failures keep their own types: a `TypeError` for input of the wrong
 * type or a detached (transferred) buffer, the signal's reason (usually a
 * `DOMException` named `AbortError`) after an abort, the error of a failing
 * input stream or progress callback, and an `Error` when the wasm cannot be
 * loaded or a worker dies.
 *
 * @example
 * ```ts
 * try {
 *   await encode(bytes);
 * } catch (e) {
 *   if (e instanceof Wav2FlacError && e.code === 'UNSUPPORTED_FORMAT') {
 *     // e.g. float WAV: retry with { bitsPerSample: 24 }. With a worker
 *     // encoder the input was transferred (detached) unless `copy: true`
 *     // was set, so the retry needs a fresh copy of the bytes.
 *   }
 * }
 * ```
 */
export class Wav2FlacError extends Error {
  /** Stable error code, safe to branch on. */
  readonly code: ErrorCode;
  override readonly name = 'Wav2FlacError' as const;

  /**
   * @param code Stable error code.
   * @param message Human-readable description.
   */
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Converts an error thrown by the wasm module (`"[CODE] message"`) into a
 * {@link Wav2FlacError}; any other value is returned unchanged.
 * @param e The caught value.
 * @returns The converted error.
 * @internal
 */
export function fromWasmError(e: unknown): unknown {
  if (e instanceof Error && !(e instanceof Wav2FlacError)) {
    const m = /^\[([A-Z_]+)\] ([\s\S]*)$/.exec(e.message);
    if (m && isErrorCode(m[1])) return new Wav2FlacError(m[1], m[2] ?? '');
  }
  return e;
}

/**
 * Creates an `INVALID_OPTIONS` error.
 * @param message Description of the offending option.
 * @returns The error.
 * @internal
 */
export function invalidOption(message: string): Wav2FlacError {
  return new Wav2FlacError('INVALID_OPTIONS', message);
}

/** An error as sent through `postMessage`. @internal */
export interface SerializedError {
  name: string;
  message: string;
  code?: string;
}

/**
 * Serializes an error for `postMessage`.
 * @param e The error.
 * @returns A plain, structured-cloneable object.
 * @internal
 */
export function serializeError(e: unknown): SerializedError {
  if (e instanceof Wav2FlacError) return { name: e.name, code: e.code, message: e.message };
  if (e instanceof Error || e instanceof DOMException) return { name: e.name, message: e.message };
  return { name: 'Error', message: String(e) };
}

/**
 * Rebuilds an error that was serialized across a worker boundary.
 * @param e Serialized error.
 * @returns The reconstructed error.
 * @internal
 */
export function reviveError(e: SerializedError): Error {
  if (e.name === 'Wav2FlacError' && isErrorCode(e.code)) return new Wav2FlacError(e.code, e.message);
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return abortError(e.message, e.name);
  const err = e.name === 'TypeError' ? new TypeError(e.message) : new Error(e.message);
  return err;
}

/**
 * Creates a `DOMException` named `AbortError` (or another name, e.g. `TimeoutError`).
 * @param message Message.
 * @param name Exception name.
 * @returns The exception.
 * @internal
 */
export function abortError(message = 'The operation was aborted.', name = 'AbortError'): Error {
  return new DOMException(message, name) as unknown as Error;
}
