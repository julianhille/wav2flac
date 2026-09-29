// SPDX-License-Identifier: 0BSD
import { describe, expect, it, vi } from 'vitest';
import { ASYNC_SLICE_BYTES, chunks, isStream, SLICE_BYTES, slices, toBytes } from '../../ts/lib/input.js';

const all = async (it: AsyncIterable<Uint8Array>): Promise<number[]> => {
  const sizes: number[] = [];
  for await (const c of it) sizes.push(c.length);
  return sizes;
};

describe('input', () => {
  it('views bytes without copying', () => {
    const buf = new ArrayBuffer(8);
    const u = new Uint8Array(buf, 2, 4);
    expect(toBytes(u)).toBe(u);
    expect(toBytes(buf).buffer).toBe(buf);
    const i8 = new Int8Array(buf, 1, 3);
    const v = toBytes(i8);
    expect([v.buffer, v.byteOffset, v.length]).toEqual([buf, 1, 3]);
    expect(toBytes(new SharedArrayBuffer(4)).length).toBe(4);
  });

  it.each([[null], ['str'], [[1, 2]], [new Uint16Array(2)], [new DataView(new ArrayBuffer(2))]])(
    'rejects %o with TypeError', (x) => {
      expect(() => toBytes(x)).toThrow(TypeError);
    });

  it('slices into 1 MiB views', () => {
    const b = new Uint8Array(SLICE_BYTES * 2 + 5);
    expect([...slices(b)].map((s) => s.length)).toEqual([SLICE_BYTES, SLICE_BYTES, 5]);
    expect([...slices(new Uint8Array(0))]).toEqual([]);
  });

  it('detects streams', () => {
    expect(isStream(new ReadableStream())).toBe(true);
    expect(isStream(new Uint8Array(1))).toBe(false);
    expect(isStream(null)).toBe(false);
  });

  it('iterates buffers and streams, slicing large chunks', async () => {
    expect(await all(chunks(new Uint8Array(10)))).toEqual([10]);
    const s = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(3));
        c.enqueue(new Uint8Array(ASYNC_SLICE_BYTES * 2 + 1));
        c.close();
      },
    });
    expect(await all(chunks(s))).toEqual([3, ASYNC_SLICE_BYTES, ASYNC_SLICE_BYTES, 1]);
    expect(await all(chunks(new Uint8Array(SLICE_BYTES + 1), SLICE_BYTES))).toEqual([SLICE_BYTES, 1]);
  });

  it('rejects non-byte stream chunks and cancels the stream', async () => {
    const cancel = vi.fn();
    const s = new ReadableStream<unknown>({ start(c) { c.enqueue('nope'); }, cancel });
    await expect(all(chunks(s as ReadableStream<Uint8Array>))).rejects.toThrow(TypeError);
    expect(cancel).toHaveBeenCalled();
  });

  it('cancels the stream when iteration stops early', async () => {
    const cancel = vi.fn();
    const s = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(1)); }, cancel });
    for await (const _ of chunks(s)) break;
    expect(cancel).toHaveBeenCalled();
  });

  it('propagates stream errors', async () => {
    const s = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error('boom')); } });
    await expect(all(chunks(s))).rejects.toThrow('boom');
  });

  it('accepts buffers and views from another realm', async () => {
    const { runInNewContext } = await import('node:vm');
    const [buf, view, i16] = runInNewContext(
      'const b = new ArrayBuffer(8); [b, new Uint8Array(b, 2, 4), new Int16Array(2)]',
    ) as [ArrayBuffer, Uint8Array, Int16Array];
    expect(buf instanceof ArrayBuffer).toBe(false);
    expect(toBytes(buf).length).toBe(8);
    expect(toBytes(view).length).toBe(4);
    expect(() => toBytes(i16)).toThrow(TypeError);
  });

  it('names what the caller accepts in the type error', () => {
    expect(() => toBytes(1, 'input', 'a Uint8Array or ArrayBuffer')).toThrow('input must be a Uint8Array or ArrayBuffer');
  });
});

