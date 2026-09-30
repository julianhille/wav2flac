// SPDX-License-Identifier: 0BSD
import { describe, expect, it, vi } from 'vitest';
import {
  assemble,
  PROGRESS_INTERVAL_MS,
  Reporter,
  runBuffered,
  runStream,
  Session,
} from '../../ts/lib/engine.js';
import { normalizeOptions } from '../../ts/lib/options.js';

describe('engine internals', () => {
  it('assembles header, parts and tail in one buffer', () => {
    const out = assemble(
      Uint8Array.of(1),
      [Uint8Array.of(2, 3), new Uint8Array(0), Uint8Array.of(4)],
      Uint8Array.of(5),
    );
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
    expect(assemble(new Uint8Array(0), [], new Uint8Array(0)).length).toBe(0);
  });

  it('throttles progress but always delivers forced reports', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const cb = vi.fn();
      const r = new Reporter(cb);
      const s = {
        progress: () => ({ bytesIn: 1, samplesOut: 0, fraction: null }),
      } as unknown as Session;
      r.update(s);
      r.update(s);
      expect(cb).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
      r.update(s);
      r.update(s, true);
      expect(cb).toHaveBeenCalledTimes(3);
      new Reporter(undefined).update(s, true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects out-of-range options from the core and use after free', () => {
    expect(() => new Session({ ...normalizeOptions({}, false), level: 9 })).toThrow(/compression/i);
    const s = new Session(normalizeOptions({}, false));
    s.free();
    s.free();
    expect(() => s.push(new Uint8Array(1))).toThrow(/freed/);
    expect(() => s.finish()).toThrow(/freed/);
  });

  it.each([
    ['blockSize', 2 ** 32 + 4096],
    ['blockSize', 4096.5],
    ['sampleRate', -1],
    ['bits', Number.NaN],
    ['seed', Infinity],
    ['padding', 2 ** 32],
    ['level', 256],
    ['maxInputBytes', 2 ** 53],
    ['pcmChannels', 1.5],
    ['quality', 3],
    ['quality', 256],
    ['pcmFormat', 6],
    ['pcmFormat', 256 + 5],
  ])('rejects %s = %d at the wasm boundary instead of wrapping it', (key, value) => {
    const base = normalizeOptions({ pcm: { sampleRate: 8000, channels: 1, format: 's16' } }, false);
    expect(() => new Session({ ...base, [key]: value })).toThrow(
      expect.objectContaining({ code: 'INVALID_OPTIONS' }),
    );
  });

  it.each([9, 65536, 2 ** 32])('reports TOO_MANY_CHANNELS for %d pcm channels', (channels) => {
    const base = normalizeOptions({ pcm: { sampleRate: 8000, channels: 1, format: 's16' } }, false);
    const args = { ...base, pcmChannels: channels };
    expect(() => new Session(args)).toThrow(
      expect.objectContaining({
        code: 'TOO_MANY_CHANNELS',
        message: expect.stringContaining(`${channels} channels`),
      }),
    );
  });

  it('refuses a pcm format that was never resolved', () => {
    const args = normalizeOptions({ pcm: { sampleRate: 8000, channels: 1 } }, false);
    expect(args.pcmFormat).toBe(-1);
    expect(() => new Session(args)).toThrow(/pcm format not resolved/);
  });

  it('reports ENCODER_STATE for push after finish', () => {
    const s = new Session(normalizeOptions({}, false));
    try {
      expect(() => s.finish()).toThrow(expect.objectContaining({ code: 'TRUNCATED' }));
      expect(() => s.push(new Uint8Array(4))).toThrow(
        expect.objectContaining({ code: 'ENCODER_STATE' }),
      );
    } finally {
      s.free();
    }
  });

  it('cancels a stream input when a run fails before reading it', async () => {
    const cancelled: unknown[] = [];
    const input = (): ReadableStream<Uint8Array> =>
      new ReadableStream({ cancel: (r) => void cancelled.push(r) });
    const bad = { ...normalizeOptions({}, false), level: 9 };
    await expect(runBuffered(input(), bad, {})).rejects.toThrow(/compression/i);
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(
      runBuffered(input(), normalizeOptions({}, false), { signal: ac.signal }),
    ).rejects.toThrow('stop');
    const out = runStream(input(), normalizeOptions({}, true), { signal: ac.signal });
    await expect(out.getReader().read()).rejects.toThrow('stop');
    expect(cancelled).toHaveLength(3);
  });
});
