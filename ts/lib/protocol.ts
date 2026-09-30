// SPDX-License-Identifier: 0BSD
/**
 * Message protocol between the worker client and the worker host.
 *
 * Input: buffers are sent with the job; streams are pulled chunk by chunk
 * (`need` → `chunk` | `end`), so the worker never buffers more than one chunk.
 * Output (stream mode): at most `window` unacknowledged `out` messages are in
 * flight; the client acks each chunk its consumer takes.
 * @module
 * @internal
 */
import type { Bytes } from './engine.js';
import type { SerializedError } from './errors.js';
import type { EncoderArgs, Progress } from './options.js';
import type { WavInfo } from './probe.js';

/** Messages to the worker. */
export type ToWorker =
  | { t: 'init'; module: WebAssembly.Module }
  | {
      t: 'job';
      id: number;
      args: EncoderArgs;
      input: Uint8Array | null;
      progress: boolean;
      window: number;
    }
  | { t: 'chunk'; id: number; data: Uint8Array }
  | { t: 'end'; id: number }
  | { t: 'ack'; id: number }
  | { t: 'abort'; id: number }
  | { t: 'probe'; id: number; data: Uint8Array }
  | { t: 'stats'; id: number };

/** Messages from the worker. */
export type FromWorker =
  | { t: 'progress'; id: number; p: Progress }
  | { t: 'need'; id: number }
  | { t: 'out'; id: number; data: Bytes }
  | { t: 'done'; id: number; data: Bytes | null }
  | { t: 'error'; id: number; error: SerializedError }
  | { t: 'probe'; id: number; info: WavInfo }
  | { t: 'stats'; id: number; wasmBytes: number }
  /** The worker can't run jobs any more (a message to it was lost); fail them all. */
  | { t: 'fatal'; error: SerializedError };

/** A bidirectional message endpoint (Worker, worker_threads port, MessagePort). */
export interface Port<In, Out> {
  /** Sends a message, transferring the listed objects. */
  post(msg: Out, transfer: Transferable[]): void;
  /** Installs the message and error handlers. */
  listen(onMessage: (msg: In) => void, onError: (err: Error) => void): void;
}

/** The client's endpoint to a worker, which it also keeps alive and terminates. */
export interface WorkerPort<In, Out> extends Port<In, Out> {
  /** Keeps (`true`) or stops keeping (`false`) a Node process alive; no-op elsewhere. */
  ref(keep: boolean): void;
  /** Terminates the worker or closes the port. */
  close(): void;
}

/** Number of stream output chunks the worker may send ahead of the consumer. */
export const OUTPUT_WINDOW = 4;

/**
 * Returns what to transfer for `data`: its buffer when the view covers all of
 * a transferable buffer, otherwise nothing (it is then copied).
 * @param data Bytes to send.
 * @returns The transfer list.
 */
export function transferOf(data: Uint8Array): Transferable[] {
  const b = data.buffer;
  return Object.prototype.toString.call(b) === '[object ArrayBuffer]' &&
    data.byteOffset === 0 &&
    data.byteLength === b.byteLength
    ? [b]
    : [];
}
