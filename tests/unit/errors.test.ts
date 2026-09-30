// SPDX-License-Identifier: 0BSD
import { describe, expect, it } from 'vitest';
import {
  abortError,
  fromWasmError,
  invalidOption,
  reviveError,
  serializeError,
  Wav2FlacError,
} from '../../ts/lib/errors.js';

describe('errors', () => {
  it('parses "[CODE] message" from wasm', () => {
    const e = fromWasmError(new Error('[INVALID_WAV] no RIFF header'));
    expect(e).toBeInstanceOf(Wav2FlacError);
    expect(e).toMatchObject({
      code: 'INVALID_WAV',
      message: 'no RIFF header',
      name: 'Wav2FlacError',
    });
  });

  it('keeps multi-line messages', () => {
    expect(fromWasmError(new Error('[INTERNAL] a\nb'))).toMatchObject({ message: 'a\nb' });
  });

  it('passes through unknown codes, non-errors and Wav2FlacErrors', () => {
    const plain = new Error('[NOPE] x');
    expect(fromWasmError(plain)).toBe(plain);
    expect(fromWasmError('str')).toBe('str');
    const w = invalidOption('bad');
    expect(fromWasmError(w)).toBe(w);
    expect(w.code).toBe('INVALID_OPTIONS');
  });

  it('round-trips through serialization', () => {
    const w = reviveError(serializeError(new Wav2FlacError('TRUNCATED', 'cut')));
    expect(w).toBeInstanceOf(Wav2FlacError);
    expect(w).toMatchObject({ code: 'TRUNCATED', message: 'cut' });

    const a = reviveError(serializeError(abortError()));
    expect(a).toBeInstanceOf(DOMException);
    expect(a.name).toBe('AbortError');
    expect(reviveError(serializeError(abortError('t', 'TimeoutError'))).name).toBe('TimeoutError');

    const t = reviveError(serializeError(new TypeError('tt')));
    expect(t).toBeInstanceOf(TypeError);
    expect(t.message).toBe('tt');

    const g = reviveError(serializeError(new RangeError('r')));
    expect(g).toBeInstanceOf(Error);
    expect(g.message).toBe('r');

    expect(serializeError(42)).toEqual({ name: 'Error', message: '42' });
    expect(reviveError({ name: 'Wav2FlacError', code: 'BOGUS', message: 'm' })).not.toBeInstanceOf(
      Wav2FlacError,
    );
  });
});
