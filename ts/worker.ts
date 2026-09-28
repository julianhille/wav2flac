// SPDX-License-Identifier: 0BSD
/**
 * Worker entry point (browser `Worker` or Node `worker_threads`). Started by
 * `createWorkerEncoder()`; not meant to be imported.
 * @module
 * @internal
 */
import { builtin, ignore, isNode } from './lib/platform.js';
import type { FromWorker, Port, ToWorker } from './lib/protocol.js';
import { serve } from './lib/worker-host.js';

/** The parts of `DedicatedWorkerGlobalScope` used here. */
interface WorkerScope {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  close(): void;
}

/**
 * The endpoint back to the thread that created this worker.
 * @returns The port.
 */
function parent(): Port<ToWorker, FromWorker> {
  const pp = isNode() ? builtin<typeof import('node:worker_threads')>('worker_threads').parentPort : null;
  if (pp !== null) {
    return {
      post: (msg, transfer) => pp.postMessage(msg, transfer as never),
      listen: (onMessage) => { pp.on('message', onMessage); },
      ref: ignore,
      close: () => pp.close(),
    };
  }
  const scope = globalThis as unknown as WorkerScope;
  return {
    post: (msg, transfer) => scope.postMessage(msg, transfer),
    listen: (onMessage) => { scope.onmessage = (e: MessageEvent<ToWorker>) => onMessage(e.data); },
    ref: ignore,
    close: () => scope.close(),
  };
}

serve(parent());
