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
  'INVALID_WAV',
  'UNSUPPORTED_FORMAT',
  'UNSUPPORTED_BIT_DEPTH',
  'TOO_MANY_CHANNELS',
  'TRUNCATED',
  'INVALID_OPTIONS',
  'ENCODER_STATE',
  'LIMIT_EXCEEDED',
  'INTERNAL',
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
  stack?: string;
  /** Set for a `DOMException`, which is revived as one. */
  dom?: true;
  /** The error's `cause`; a cause that is not an error arrives as an `Error`. */
  cause?: SerializedError;
}

/** How many nested causes cross the boundary; also stops cyclic ones. */
const MAX_CAUSES = 8;

/**
 * Serializes an error for `postMessage`.
 * @param e The error.
 * @param depth Nesting level of `e` in a chain of causes.
 * @returns A plain, structured-cloneable object.
 * @internal
 */
export function serializeError(e: unknown, depth = 0): SerializedError {
  if (!(e instanceof Error || e instanceof DOMException))
    return { name: 'Error', message: String(e) };
  const out: SerializedError = { name: e.name, message: e.message };
  if (e instanceof Wav2FlacError) out.code = e.code;
  if (e instanceof DOMException) out.dom = true;
  if (typeof e.stack === 'string') out.stack = e.stack;
  // An absent cause and `cause: undefined` both arrive as no cause.
  if (e.cause !== undefined && depth < MAX_CAUSES) out.cause = serializeError(e.cause, depth + 1);
  return out;
}

/**
 * The error types revived by name; any other name gives an `Error` with that name.
 * @returns Constructors by name.
 */
function errorTypes(): Readonly<Record<string, new (message: string) => Error>> {
  const types: Record<string, new (message: string) => Error> = {
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    EvalError,
    URIError,
  };
  if (typeof WebAssembly === 'object') {
    types['CompileError'] = WebAssembly.CompileError;
    types['LinkError'] = WebAssembly.LinkError;
    types['RuntimeError'] = WebAssembly.RuntimeError;
  }
  return types;
}

/**
 * Rebuilds an error that was serialized across a worker boundary, with the
 * worker's stack and cause.
 * @param e Serialized error.
 * @returns The reconstructed error.
 * @internal
 */
export function reviveError(e: SerializedError): Error {
  let err: Error;
  if (e.name === 'Wav2FlacError' && isErrorCode(e.code)) err = new Wav2FlacError(e.code, e.message);
  else if (e.dom === true) err = abortError(e.message, e.name);
  else {
    const types = errorTypes();
    err = new (Object.hasOwn(types, e.name) ? types[e.name]! : Error)(e.message);
    if (err.name !== e.name) err.name = e.name;
  }
  const own = { configurable: true, writable: true, enumerable: false };
  if (e.stack !== undefined) Object.defineProperty(err, 'stack', { ...own, value: e.stack });
  if (e.cause !== undefined)
    Object.defineProperty(err, 'cause', { ...own, value: reviveError(e.cause) });
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
