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
    expect(g).toBeInstanceOf(RangeError);
    expect(g.message).toBe('r');
    expect(reviveError(serializeError(new WebAssembly.CompileError('c')))).toBeInstanceOf(
      WebAssembly.CompileError,
    );
    expect(reviveError(serializeError(new WebAssembly.LinkError('l')))).toBeInstanceOf(
      WebAssembly.LinkError,
    );

    // Any DOMException, not only aborts.
    const d = reviveError(serializeError(new DOMException('no clone', 'DataCloneError')));
    expect(d).toBeInstanceOf(DOMException);
    expect(d.name).toBe('DataCloneError');

    // An unknown type keeps its name.
    class MyError extends Error {
      override name = 'MyError';
    }
    const u = reviveError(serializeError(new MyError('m')));
    expect(u).toBeInstanceOf(Error);
    expect(u).toMatchObject({ name: 'MyError', message: 'm' });

    expect(serializeError(42)).toEqual({ name: 'Error', message: '42' });
    expect(reviveError({ name: 'Error', message: 'x' }).name).toBe('Error');
    expect(reviveError({ name: 'Wav2FlacError', code: 'BOGUS', message: 'm' })).not.toBeInstanceOf(
      Wav2FlacError,
    );
  });

  it('keeps the stack and the cause', () => {
    const inner = new TypeError('inner');
    const outer = new Wav2FlacError('INTERNAL', 'outer');
    Object.defineProperty(outer, 'cause', { value: inner });
    const r = reviveError(structuredClone(serializeError(outer)));
    expect(r.stack).toBe(outer.stack);
    expect(r.cause).toBeInstanceOf(TypeError);
    expect((r.cause as Error).message).toBe('inner');
    expect((r.cause as Error).stack).toBe(inner.stack);
    expect(Object.keys(r)).not.toContain('cause');

    // A cause that is not an error arrives as one.
    expect(reviveError(serializeError(new Error('e', { cause: 'why' }))).cause).toMatchObject({
      message: 'why',
    });

    // A cyclic chain is cut.
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b });
    let depth = 0;
    for (let c: unknown = reviveError(serializeError(a)); c instanceof Error; c = c.cause) depth++;
    expect(depth).toBe(9);
  });
});
