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
    /** The inputs of the jobs, in the order the workers started them. */
    static started: string[] = [];
    /** Jobs with the input 'hold' wait for it. */
    static gate: Promise<void> = Promise.resolve();
    readonly id = StubWorker.all.push(this);
    dead = false;
    /** Stopped without an error event: nothing it was sent settles until terminate(). */
    gone = false;
    jobs = 0;
    /** Rejects the calls still pending, like terminate() on a real worker encoder. */
    private readonly pending = new Set<(e: Error) => void>();
    private hang<T>(signal?: AbortSignal): Promise<T> {
      return new Promise((_, reject) => {
        this.pending.add(reject);
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    }
    async encode(input: string, options?: { signal?: AbortSignal }): Promise<string> {
      if (this.dead) throw new Error('wav2flac worker exited with code 1');
      this.jobs++;
      StubWorker.started.push(input);
      if (input === 'hold') await StubWorker.gate;
      if (input === 'vanish') {
        this.gone = true;
        return this.hang(options?.signal);
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
      if (this.dead) throw new Error('wav2flac worker exited with code 1');
      if (this.gone) return this.hang();
      return 1 << 20;
    }
    terminate(): void {
      this.dead = true;
      for (const reject of this.pending) reject(new Error('The worker was terminated.'));
      this.pending.clear();
    }
  }

  type Pool = { encode(input: string, options?: { signal?: AbortSignal }): Promise<string>; terminate(): void };
  const createEncoderPool = async (size?: unknown): Promise<Pool> => {
    StubWorker.all = [];
    StubWorker.started = [];
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

  it('rejects a waiting job as soon as its signal aborts', async () => {
    const pool = await createEncoderPool(1);
    const busy = new AbortController();
    const running = pool.encode('vanish', { signal: busy.signal });
    const stop = new AbortController();
    const waiting = pool.encode('a', { signal: stop.signal });
    const after = pool.encode('b');
    stop.abort(new Error('gave up'));
    await expect(waiting).rejects.toThrow('gave up');
    await expect(pool.encode('c', { signal: AbortSignal.abort(new Error('early')) })).rejects.toThrow('early');
    // The worker is still busy with the first job, and the next job still waits.
    expect(StubWorker.all[0]!.jobs).toBe(1);
    busy.abort(new Error('done'));
    await expect(running).rejects.toThrow('done');
    pool.terminate();
    await expect(after).rejects.toThrow('terminated');
    // terminate() ended the check of the busy worker without a replacement.
    await tick();
    expect(StubWorker.all).toHaveLength(1);
  });

  /**
   * Holds the jobs with the input 'hold' until the returned function is called.
   * @returns Lets them go on.
   */
  const hold = (): (() => void) => {
    let open!: () => void;
    StubWorker.gate = new Promise((r) => { open = r; });
    return open;
  };
  /** Settles with `p`, or with 'pending' when it doesn't settle soon. */
  const soon = <T>(p: Promise<T>): Promise<T | 'pending'> => Promise.race([p, tick(50).then(() => 'pending' as const)]);

  it('starts waiting jobs in the order they came', async () => {
    const pool = await createEncoderPool(1);
    const open = hold();
    const jobs = ['hold', 'a', 'b', 'c'].map((f) => pool.encode(f));
    open();
    await Promise.all(jobs);
    expect(StubWorker.started).toEqual(['hold', 'a', 'b', 'c']);
    pool.terminate();
  });

  it('hands the worker to the next job after a waiting job aborted', async () => {
    const pool = await createEncoderPool(1);
    const open = hold();
    const running = pool.encode('hold');
    const stop = new AbortController();
    const waiting = pool.encode('a', { signal: stop.signal });
    const after = pool.encode('b');
    stop.abort(new Error('gave up'));
    await expect(waiting).rejects.toThrow('gave up');
    open();
    await running;
    expect(await soon(after)).toBe('flac(b)@1');
    pool.terminate();
  });

  it('ignores the signal of a job once it has a worker', async () => {
    const pool = await createEncoderPool(1);
    const open = hold();
    const running = pool.encode('hold');
    const stop = new AbortController();
    const started = pool.encode('b', { signal: stop.signal });
    const last = pool.encode('c');
    open();
    await running;
    // 'b' has the worker; its abort must not drop 'c' from the queue.
    stop.abort();
    await started;
    expect(await soon(last)).toBe('flac(c)@1');
    pool.terminate();
  });

  it('does not take a worker for a job whose signal already aborted', async () => {
    const pool = await createEncoderPool(1);
    await expect(pool.encode('a', { signal: AbortSignal.abort(new Error('early')) })).rejects.toThrow('early');
    expect(StubWorker.all[0]!.jobs).toBe(0);
    pool.terminate();
  });

  it('leaves no timer behind after checking a worker', async () => {
    vi.useFakeTimers();
    try {
      const pool = await createEncoderPool(1);
      const job = expect(pool.encode('bad')).rejects.toThrow('not a WAV');
      await vi.advanceTimersByTimeAsync(0);
      await job;
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(StubWorker.all).toHaveLength(1);
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
