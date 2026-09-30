// SPDX-License-Identifier: 0BSD
/**
 * Worker side of the protocol: runs jobs with the shared engine.
 * @module
 * @internal
 */
import { serializeError } from './errors.js';
import { runBuffered, runStream } from './engine.js';
import type { Progress } from './options.js';
import { probeBytes } from './probe.js';
import type { FromWorker, Port, ToWorker } from './protocol.js';
import { transferOf } from './protocol.js';
import { initSync, wasmMemoryBytes } from './wasm.js';

/** A resolvable promise. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}

/**
 * Creates a {@link Deferred}.
 * @returns The deferred.
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** State of one running job. */
interface HostJob {
  abort: AbortController;
  input: Deferred<Uint8Array | null> | undefined;
  credits: number;
  credit: Deferred<void> | undefined;
}

/**
 * Serves encode jobs on `port` until it closes.
 * @param port The worker's endpoint.
 */
export function serve(port: Port<ToWorker, FromWorker>): void {
  const jobs = new Map<number, HostJob>();
  /** Why this worker can't run jobs: its wasm failed to start, or a message was lost. */
  let fatal: unknown;

  const send = (msg: FromWorker, data?: Uint8Array): void => {
    port.post(msg, data === undefined ? [] : transferOf(data));
  };

  /**
   * A stream that pulls input chunks from the client on demand.
   * @param id Job id.
   * @param job Job state.
   * @returns The input stream.
   */
  const pulled = (id: number, job: HostJob): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>(
      {
        async pull(c) {
          job.input = deferred();
          send({ t: 'need', id });
          const data = await job.input.promise;
          job.input = undefined;
          if (data === null) c.close();
          else c.enqueue(data);
        },
      },
      { highWaterMark: 0 },
    );

  /**
   * Stops a running job.
   * @param job Job state.
   * @param reason Why.
   */
  const stop = (job: HostJob, reason?: unknown): void => {
    job.abort.abort(reason);
    job.input?.resolve(null);
    job.credit?.resolve();
  };

  /**
   * Handles a message that could not be deserialized, such as an `init` whose
   * wasm module can't be shared with this worker. Nothing tells which job it
   * belonged to, and a lost `init`, `chunk` or `ack` would leave jobs failing
   * obscurely or waiting forever, so the worker gives up: it fails every job
   * and tells the client to do the same.
   * @param e Why.
   */
  const lost = (e: Error): void => {
    fatal ??= e;
    send({ t: 'fatal', error: serializeError(e) });
    for (const job of jobs.values()) stop(job, e);
  };

  const runJob = async (m: Extract<ToWorker, { t: 'job' }>): Promise<void> => {
    const job: HostJob = {
      abort: new AbortController(),
      input: undefined,
      credits: m.window,
      credit: undefined,
    };
    jobs.set(m.id, job);
    const hooks = {
      signal: job.abort.signal,
      onProgress: m.progress ? (p: Progress) => send({ t: 'progress', id: m.id, p }) : undefined,
    };
    try {
      if (fatal !== undefined) throw fatal;
      const input = m.input ?? pulled(m.id, job);
      if (!m.args.streaming) {
        const out = await runBuffered(input, m.args, hooks);
        send({ t: 'done', id: m.id, data: out }, out);
        return;
      }
      const reader = runStream(input, m.args, hooks).getReader();
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          while (job.credits === 0) {
            job.credit = deferred();
            await job.credit.promise;
            job.abort.signal.throwIfAborted();
          }
          job.credits--;
          send({ t: 'out', id: m.id, data: r.value }, r.value);
        }
      } finally {
        reader.releaseLock();
      }
      send({ t: 'done', id: m.id, data: null });
    } catch (e) {
      send({ t: 'error', id: m.id, error: serializeError(e) });
    } finally {
      jobs.delete(m.id);
    }
  };

  port.listen((m) => {
    switch (m.t) {
      case 'init':
        try {
          initSync(m.module);
        } catch (e) {
          fatal ??= e;
        }
        return;
      case 'job':
        void runJob(m);
        return;
      case 'chunk':
      case 'end': {
        const job = jobs.get(m.id);
        job?.input?.resolve(m.t === 'chunk' ? m.data : null);
        return;
      }
      case 'ack': {
        const job = jobs.get(m.id);
        if (job === undefined) return;
        job.credits++;
        job.credit?.resolve();
        return;
      }
      case 'abort': {
        const job = jobs.get(m.id);
        if (job !== undefined) stop(job);
        return;
      }
      case 'probe':
        try {
          if (fatal !== undefined) throw fatal;
          send({ t: 'probe', id: m.id, info: probeBytes(m.data) });
        } catch (e) {
          send({ t: 'error', id: m.id, error: serializeError(e) });
        }
        return;
      case 'stats':
        // A worker whose wasm failed to start can't encode; say so.
        if (fatal !== undefined) send({ t: 'error', id: m.id, error: serializeError(fatal) });
        else send({ t: 'stats', id: m.id, wasmBytes: wasmMemoryBytes() });
        return;
    }
  }, lost);
}
