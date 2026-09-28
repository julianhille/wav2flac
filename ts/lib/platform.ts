// SPDX-License-Identifier: 0BSD
/**
 * Small runtime helpers: Node detection, synchronous built-in access and
 * cooperative yielding.
 * @module
 * @internal
 */

/** Minimal view of Node's `process` used here. */
interface NodeProcess {
  versions?: { node?: string };
  getBuiltinModule?: (id: string) => unknown;
}

/**
 * Returns Node's `process` object when running in Node (or a compatible
 * runtime), otherwise `undefined`.
 * @returns The process object or `undefined`.
 */
function nodeProcess(): NodeProcess | undefined {
  const p = (globalThis as { process?: NodeProcess }).process;
  return p?.versions?.node !== undefined ? p : undefined;
}

/**
 * Does nothing: used to deliberately ignore a callback or a rejection whose
 * outcome no longer matters (e.g. cancelling a stream during cleanup).
 * @returns `undefined`.
 */
export function ignore(): undefined {
  return undefined;
}

/**
 * Whether the code runs in Node.js (or Deno/Bun in Node-compat mode).
 * @returns `true` in Node.
 */
export function isNode(): boolean {
  return nodeProcess() !== undefined;
}

/**
 * Loads a Node built-in module synchronously (`process.getBuiltinModule`,
 * Node ≥ 22.12), without a static import that would break browser bundles.
 * @param id Module id, e.g. `'fs'`.
 * @returns The module.
 * @throws {Error} If not running in Node ≥ 22.12.
 */
export function builtin<T>(id: string): T {
  const get = nodeProcess()?.getBuiltinModule;
  if (get === undefined) throw new Error(`wav2flac: Node built-in "${id}" is unavailable (needs Node ≥ 22.12)`);
  return get(id) as T;
}

/** Longest stretch of main-thread work between yields, in milliseconds. */
export const YIELD_EVERY_MS = 8;

type Yielder = () => Promise<void>;

/**
 * Picks the fastest available way to yield to the event loop: `setImmediate`,
 * then a `MessageChannel` round trip, then `setTimeout`.
 *
 * `scheduler.yield()` is deliberately not used: its continuations run before
 * the page's other queued tasks, so a long encode would starve timers and
 * messages until it finishes. A posted message queues fairly behind them.
 * @returns A function resolving on the next macrotask.
 */
function pickYielder(): Yielder {
  const si = (globalThis as { setImmediate?: (cb: () => void) => unknown }).setImmediate;
  if (typeof si === 'function') return () => new Promise<void>((r) => { si(r); });
  if (typeof MessageChannel === 'function') {
    const ch = new MessageChannel();
    const queue: (() => void)[] = [];
    ch.port1.onmessage = () => queue.shift()?.();
    return () => new Promise<void>((r) => { queue.push(r); ch.port2.postMessage(0); });
  }
  return () => new Promise<void>((r) => { setTimeout(r, 0); });
}

let yielder: Yielder | undefined;

/**
 * Yields to the event loop so UI and I/O stay responsive.
 * @returns A promise resolving on the next macrotask.
 */
export function yieldNow(): Promise<void> {
  yielder ??= pickYielder();
  return yielder();
}

/**
 * Tracks elapsed work time and yields every {@link YIELD_EVERY_MS} ms.
 * @internal
 */
export class Pacer {
  #last = performance.now();

  /**
   * Yields if enough time has passed since the last yield.
   * @returns Resolves immediately or after yielding.
   */
  async maybeYield(): Promise<void> {
    if (performance.now() - this.#last >= YIELD_EVERY_MS) {
      await yieldNow();
      this.#last = performance.now();
    }
  }
}
