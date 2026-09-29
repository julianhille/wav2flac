// SPDX-License-Identifier: 0BSD
/**
 * Worker side of the protocol: runs jobs with the shared engine.
 * @module
 * @internal
 */
import { serializeError } from './errors.js';
import { runBuffered, runStream } from './engine.js';
import type { Progress } from './options.js';
import { ignore } from './platform.js';
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
  const promise = new Promise<T>((r) => { resolve = r; });
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
  let initError: unknown;

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
    new ReadableStream<Uint8Array>({
      async pull(c) {
        job.input = deferred();
        send({ t: 'need', id });
        const data = await job.input.promise;
        job.input = undefined;
        if (data === null) c.close();
        else c.enqueue(data);
      },
    }, { highWaterMark: 0 });

  const runJob = async (m: Extract<ToWorker, { t: 'job' }>): Promise<void> => {
    const job: HostJob = { abort: new AbortController(), input: undefined, credits: m.window, credit: undefined };
    jobs.set(m.id, job);
    const hooks = {
      signal: job.abort.signal,
      onProgress: m.progress ? (p: Progress) => send({ t: 'progress', id: m.id, p }) : undefined,
    };
    try {
      if (initError !== undefined) throw initError;
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
          initError = e;
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
        if (job === undefined) return;
        job.abort.abort();
        job.input?.resolve(null);
        job.credit?.resolve();
        return;
      }
      case 'probe':
        try {
          if (initError !== undefined) throw initError;
          send({ t: 'probe', id: m.id, info: probeBytes(m.data) });
        } catch (e) {
          send({ t: 'error', id: m.id, error: serializeError(e) });
        }
        return;
      case 'stats':
        // A worker whose wasm failed to start can't encode; say so.
        if (initError !== undefined) send({ t: 'error', id: m.id, error: serializeError(initError) });
        else send({ t: 'stats', id: m.id, wasmBytes: wasmMemoryBytes() });
        return;
    }
  }, ignore);
}
