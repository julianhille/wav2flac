// SPDX-License-Identifier: 0BSD
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const fresh = async (): Promise<typeof import('../../ts/lib/platform.js')> =>
  import('../../ts/lib/platform.js');

describe('platform', () => {
  it('detects Node and loads built-ins', async () => {
    const p = await fresh();
    expect(p.isNode()).toBe(true);
    expect(p.builtin<typeof import('node:path')>('path').sep).toBe('/');
  });

  it('fails clearly without getBuiltinModule', async () => {
    vi.stubGlobal('process', { versions: { node: '18.0.0' } });
    const p = await fresh();
    expect(() => p.builtin('fs')).toThrow(/22\.12/);
    vi.stubGlobal('process', {});
    expect(p.isNode()).toBe(false);
  });

  it.each([
    ['setImmediate', () => undefined],
    ['MessageChannel', () => vi.stubGlobal('setImmediate', undefined)],
    [
      'setTimeout',
      () => {
        vi.stubGlobal('setImmediate', undefined);
        vi.stubGlobal('MessageChannel', undefined);
      },
    ],
  ])('yields via %s', async (_, stub) => {
    stub();
    const p = await fresh();
    let flag = false;
    const y = p.yieldNow().then(() => {
      flag = true;
    });
    expect(flag).toBe(false);
    await y;
    await p.yieldNow();
    expect(flag).toBe(true);
  });

  it('ignores scheduler.yield, whose continuations starve other tasks', async () => {
    const y = vi.fn(() => Promise.resolve());
    vi.stubGlobal('scheduler', { yield: y });
    const p = await fresh();
    await p.yieldNow();
    expect(y).not.toHaveBeenCalled();
  });

  it('paces yields by elapsed time', async () => {
    const p = await fresh();
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const pacer = new p.Pacer();
      let ticked = false;
      setImmediate(() => {
        ticked = true;
      });
      await pacer.maybeYield();
      expect(ticked).toBe(false);
      vi.advanceTimersByTime(p.YIELD_EVERY_MS);
      await pacer.maybeYield();
      expect(ticked).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
