// SPDX-License-Identifier: 0BSD
import { describe, expect, it } from 'vitest';
import { Wav2FlacError } from '../../ts/lib/errors.js';
import { normalizeOptions, type Options } from '../../ts/lib/options.js';

const bad = (o: unknown): unknown => {
  try {
    normalizeOptions(o as Options, false);
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('normalizeOptions', () => {
  it('has lossless level-5 defaults', () => {
    expect(normalizeOptions(undefined, false)).toEqual({
      level: 5, blockSize: 0, sampleRate: 0, quality: 1, bits: 0, dither: true, seed: 0x5eedf1ac,
      tagsEnabled: true, tagKeys: [], tagValues: [], seekPointInterval: 10, padding: 8192,
      maxInputBytes: -1, streaming: false,
    });
    expect(normalizeOptions(null, true).streaming).toBe(true);
  });

  it('maps every option', () => {
    const a = normalizeOptions({
      compressionLevel: 8, blockSize: 4096, sampleRate: 48000, resampleQuality: 'best', bitsPerSample: 16,
      dither: 'none', ditherSeed: 7, tags: { TITLE: 't', ARTIST: '' }, seekPointInterval: 2.5, padding: 0,
      maxInputBytes: 1000, signal: new AbortController().signal, onProgress: () => undefined, copy: true,
    }, false);
    expect(a).toMatchObject({
      level: 8, blockSize: 4096, sampleRate: 48000, quality: 2, bits: 16, dither: false, seed: 7,
      tagKeys: ['TITLE', 'ARTIST'], tagValues: ['t', ''], seekPointInterval: 2.5, padding: 0, maxInputBytes: 1000,
    });
    expect(normalizeOptions({ resampleQuality: 'fast', tags: false }, false)).toMatchObject({ quality: 0, tagsEnabled: false });
  });

  it.each([
    ['not an object', 5],
    ['unknown key', { level: 5 }],
    ['non-integer level', { compressionLevel: 1.5 }],
    ['negative block size', { blockSize: -1 }],
    ['string rate', { sampleRate: '48000' }],
    ['huge padding', { padding: 2 ** 33 }],
    ['bad quality', { resampleQuality: 'ultra' }],
    ['inherited quality key', { resampleQuality: 'toString' }],
    ['bad dither', { dither: 'rpdf' }],
    ['array tags', { tags: ['a'] }],
    ['null tags', { tags: null }],
    ['non-string tag', { tags: { A: 1 } }],
    ['negative seek interval', { seekPointInterval: -1 }],
    ['NaN seek interval', { seekPointInterval: Number.NaN }],
    ['bad signal', { signal: {} }],
    ['bad onProgress', { onProgress: 'x' }],
    ['bad copy', { copy: 1 }],
    ['zero block size', { blockSize: 0 }],
    ['zero sample rate', { sampleRate: 0 }],
    ['zero bits per sample', { bitsPerSample: 0 }],
    ['level 9', { compressionLevel: 9 }],
    ['block size 15', { blockSize: 15 }],
    ['block size 65536', { blockSize: 65536 }],
    ['3 bits per sample', { bitsPerSample: 3 }],
    ['33 bits per sample', { bitsPerSample: 33 }],
    ['Map tags', { tags: new Map([['TITLE', 't']]) }],
    ['class instance tags', { tags: new Date() }],
  ])('rejects %s', (_, o) => {
    const e = bad(o);
    expect(e).toBeInstanceOf(Wav2FlacError);
    expect((e as Wav2FlacError).code).toBe('INVALID_OPTIONS');
  });

  it('names the accepted range', () => {
    expect((bad({ compressionLevel: 9 }) as Error).message).toMatch(/between 0 and 8/);
    expect((bad({ blockSize: 1 }) as Error).message).toMatch(/between 16 and 65535/);
    expect((bad({ bitsPerSample: 64 }) as Error).message).toMatch(/between 4 and 32/);
    expect((bad({ tags: new Map() }) as Error).message).toMatch(/plain object/);
  });

  it('accepts the range limits and null-prototype tags', () => {
    expect(normalizeOptions({ compressionLevel: 0, blockSize: 16, bitsPerSample: 4 }, false))
      .toMatchObject({ level: 0, blockSize: 16, bits: 4 });
    expect(normalizeOptions({ compressionLevel: 8, blockSize: 65535, bitsPerSample: 32 }, false))
      .toMatchObject({ level: 8, blockSize: 65535, bits: 32 });
    const tags = Object.assign(Object.create(null) as Record<string, string>, { TITLE: 't' });
    expect(normalizeOptions({ tags }, false)).toMatchObject({ tagKeys: ['TITLE'], tagValues: ['t'] });
  });
});
