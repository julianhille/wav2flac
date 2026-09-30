// SPDX-License-Identifier: 0BSD
/**
 * Worker entry point (browser `Worker` or Node `worker_threads`). Started by
 * `createWorkerEncoder()`; not meant to be imported.
 * @module
 * @internal
 */
import { builtin, isNode } from './lib/platform.js';
import type { FromWorker, Port, ToWorker } from './lib/protocol.js';
import { serve } from './lib/worker-host.js';

/** The parts of `DedicatedWorkerGlobalScope` used here. */
interface WorkerScope {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  onmessageerror: (() => void) | null;
}

/**
 * The error for a message this worker could not deserialize.
 * @param detail What the platform says, if anything.
 * @returns The error.
 */
function lost(detail?: string): Error {
  const msg = 'wav2flac worker: a message to the worker could not be deserialized';
  return new Error(detail === undefined ? msg : `${msg}: ${detail}`);
}

/**
 * The endpoint back to the thread that created this worker.
 * @returns The port.
 */
function parent(): Port<ToWorker, FromWorker> {
  const pp = isNode()
    ? builtin<typeof import('node:worker_threads')>('worker_threads').parentPort
    : null;
  if (pp !== null) {
    return {
      post: (msg, transfer) => pp.postMessage(msg, transfer as never),
      listen: (onMessage, onError) => {
        pp.on('message', onMessage);
        pp.on('messageerror', (e: Error) => onError(lost(e.message)));
      },
    };
  }
  const scope = globalThis as unknown as WorkerScope;
  return {
    post: (msg, transfer) => scope.postMessage(msg, transfer),
    listen: (onMessage, onError) => {
      scope.onmessage = (e: MessageEvent<ToWorker>) => onMessage(e.data);
      scope.onmessageerror = () => onError(lost());
    },
  };
}

serve(parent());
