// SPDX-License-Identifier: 0BSD
// The code samples of the how-to guides, run as they are printed. Each sample
// is read from its Markdown file; its `import` lines are replaced by stubs.
import { execFileSync } from 'node:child_process';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { encode } from '../../ts/index.js';
import { asScript, jsBlocks, run } from '../helpers/samples.js';
import { makeWav } from '../helpers/wav.js';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('parallel-encoding.md', () => {
  const [poolCode = '', batchCode = ''] = jsBlocks('docs/how-to/parallel-encoding.md', 2).map(asScript);

  /** A stand-in for a worker encoder whose jobs can fail or crash it. */
  class StubWorker {
    static all: StubWorker[] = [];
    readonly id = StubWorker.all.push(this);
    dead = false;
    /** Stopped without an error event: nothing it was sent ever settles. */
    gone = false;
    jobs = 0;
    async encode(input: string, options?: { signal?: AbortSignal }): Promise<string> {
      if (this.dead) throw new Error('wav2flac worker exited with code 1');
      this.jobs++;
      if (input === 'vanish') {
        this.gone = true;
        return new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason));
        });
      }
      await tick();
      if (input === 'crash') {
        this.dead = true;
        throw new Error('wav2flac worker exited with code 1');
      }
      if (input === 'bad') throw new Error('not a WAV file');
      return `flac(${input})@${this.id}`;
    }
    async wasmMemoryBytes(): Promise<number> {
      if (this.gone) return new Promise(() => {});
      if (this.dead) throw new Error('wav2flac worker exited with code 1');
      return 1 << 20;
    }
    terminate(): void {
      this.dead = true;
    }
  }

  type Pool = { encode(input: string, options?: { signal?: AbortSignal }): Promise<string>; terminate(): void };
  const createEncoderPool = async (size?: unknown): Promise<Pool> => {
    StubWorker.all = [];
    const factory = (await run(`${poolCode}\nreturn createEncoderPool;`, {
      createWorkerEncoder: () => new StubWorker(),
      navigator: { hardwareConcurrency: 4 },
    })) as (size?: unknown) => Pool;
    return factory(size);
  };

  it('rejects a pool size that is not a positive integer', async () => {
    for (const size of [0, -1, 1.5, Number.NaN, '2']) {
      await expect(createEncoderPool(size), String(size)).rejects.toThrow(RangeError);
    }
    await createEncoderPool();
    expect(StubWorker.all).toHaveLength(3);
  });

  it('replaces a crashed worker and keeps a healthy one after a failed job', async () => {
    const pool = await createEncoderPool(2);
    await expect(pool.encode('crash')).rejects.toThrow('exited');
    await expect(pool.encode('bad')).rejects.toThrow('not a WAV');
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => pool.encode(`f${i}`)));
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => expect.stringMatching(`^flac\\(f${i}\\)`)));
    // The crashed worker was replaced once; the one with the bad input was kept.
    expect(StubWorker.all).toHaveLength(3);
    expect(StubWorker.all.filter((w) => w.dead)).toHaveLength(1);
    pool.terminate();
    expect(StubWorker.all.every((w) => w.dead)).toBe(true);
  });

  it('fails a job on its signal at once, and replaces a worker that stopped answering', async () => {
    vi.useFakeTimers();
    try {
      const pool = await createEncoderPool(1);
      const timeout = new AbortController();
      const job = pool.encode('vanish', { signal: timeout.signal });
      const next = pool.encode('a');
      await vi.advanceTimersByTimeAsync(0);
      timeout.abort(new Error('timed out'));
      await expect(job).rejects.toThrow('timed out');
      // The check gets no answer; the worker is replaced after 5 seconds.
      await vi.advanceTimersByTimeAsync(4999);
      expect(StubWorker.all).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(StubWorker.all).toHaveLength(2);
      expect(StubWorker.all[0]!.dead).toBe(true);
      const done = expect(next).resolves.toBe('flac(a)@2');
      await vi.advanceTimersByTimeAsync(10);
      await done;
      pool.terminate();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the other results of a batch when files fail', async () => {
    StubWorker.all = [];
    const files = ['a', 'crash', 'b', 'bad', 'c', 'd', 'e', 'f'];
    const results = await run(`${poolCode}\n${batchCode}\nreturn results;`, {
      createWorkerEncoder: () => new StubWorker(),
      navigator: { hardwareConcurrency: 3 },
      files,
      console: { error: () => {} },
    });
    const status = (results as PromiseSettledResult<string>[]).map((r) => r.status);
    expect(status).toEqual(files.map((f) => (f === 'crash' || f === 'bad' ? 'rejected' : 'fulfilled')));
  });

  it('rejects waiting jobs on terminate, and replaces nothing after it', async () => {
    const pool = await createEncoderPool(1);
    const running = pool.encode('crash');
    const waiting = pool.encode('a');
    pool.terminate();
    await expect(running).rejects.toThrow();
    await expect(waiting).rejects.toThrow('terminated');
    await expect(pool.encode('b')).rejects.toThrow('terminated');
    expect(StubWorker.all).toHaveLength(1);
  });
});

describe('fifo-queue.md', () => {
  const [queueCode = '', uploadCode = '', workerCode = ''] = jsBlocks('docs/how-to/fifo-queue.md', 3).map(asScript);
  const wavA = makeWav({ frames: 4410, seed: 1 });
  const wavB = makeWav({ frames: 441, seed: 2 });

  it('runs jobs one at a time, in call order', async () => {
    const [first, second] = (await run(`${queueCode}\nreturn [first, second];`, {
      encode,
      wavA,
      wavB,
    })) as [Promise<Uint8Array>, Promise<Uint8Array>];
    const order: string[] = [];
    await Promise.all([first.then(() => order.push('A')), second.then(() => order.push('B'))]);
    expect(order).toEqual(['A', 'B']);
  });

  it('moves on after a failed job, and runs the upload and worker samples', async () => {
    const uploaded: unknown[] = [];
    const errors: unknown[] = [];
    const worker = { encode: async (x: unknown) => (x === 'bad' ? Promise.reject(new Error('bad')) : `flac(${x})`) };
    await run(`${queueCode.replace(/^const enqueue[\s\S]*/m, '')}\n${workerCode}\n${uploadCode}`, {
      createWorkerEncoder: () => worker,
      recordings: ['r1', 'bad', 'r2'],
      upload: (f: unknown) => uploaded.push(f),
      console: { error: (_: string, e: unknown) => errors.push(e) },
    });
    await tick(10);
    expect(uploaded).toEqual(['flac(r1)', 'flac(r2)']);
    expect(errors).toHaveLength(1);
  });

  it('does not keep the last result alive', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const enqueue = (await run(`${queueCode.replace(/^const enqueue[\s\S]*/m, '')}\nreturn createQueue;`, {})) as (
      run: () => Promise<object>,
    ) => () => Promise<object>;
    const queue = enqueue(async () => ({ big: new Uint8Array(1 << 20) }));
    let ref: WeakRef<object> | undefined;
    await queue().then((r) => {
      ref = new WeakRef(r);
    });
    await tick();
    gc();
    await tick();
    gc();
    expect(ref?.deref()).toBeUndefined();
  });

  it('reports a rejection that nobody handles', () => {
    const code = `${queueCode.replace(/^const enqueue[\s\S]*/m, '')}
      let n = 0;
      process.on('unhandledRejection', () => n++);
      const enqueue = createQueue(async () => { throw new Error('x'); });
      enqueue();
      enqueue().catch(() => {});
      setTimeout(() => console.log(n), 50);`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    expect(out.trim()).toBe('1');
  });
});
