// SPDX-License-Identifier: 0BSD
// The browser path of createWorkerEncoder, with a fake global `Worker` that
// runs the real host over a MessageChannel. This exercises the adapter only;
// no real browser runs in these tests.
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FromWorker, Port, ToWorker } from '../../ts/lib/protocol.js';
import { serve } from '../../ts/lib/worker-host.js';
import { encodeSync } from '../../ts/index.js';
import { makeWav } from '../helpers/wav.js';

vi.mock('../../ts/lib/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../ts/lib/platform.js')>()),
  isNode: () => false,
}));

const { createWorkerEncoder } = await import('../../ts/lib/worker-client.js');

const wasm = readFileSync('build/bindgen/wav2flac_bg.wasm');
const wav = makeWav({ frames: 44100, seed: 9 });

/** Host side of the fake worker. */
function hostPort(p: MessagePort): Port<ToWorker, FromWorker> {
  return {
    post: (m, t) => p.postMessage(m, t as never),
    listen: (on) => { p.on('message', on); },
    ref: () => undefined,
    close: () => p.close(),
  };
}

/** Minimal stand-in for the DOM `Worker`. */
class FakeWorker {
  static last: FakeWorker | undefined;
  readonly url: string;
  readonly opts: unknown;
  onmessage: ((e: { data: FromWorker }) => void) | null = null;
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  private readonly port: MessagePort;

  constructor(url: URL | string, opts: unknown) {
    this.url = String(url);
    this.opts = opts;
    const ch = new MessageChannel();
    this.port = ch.port1;
    this.port.on('message', (data: FromWorker) => this.onmessage?.({ data }));
    serve(hostPort(ch.port2));
    FakeWorker.last = this;
  }

  postMessage(msg: unknown, transfer: Transferable[]): void {
    this.port.postMessage(msg, transfer as never);
  }

  terminate(): void {
    this.terminated = true;
    this.port.close();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.last = undefined;
});

describe('browser worker adapter', () => {
  it('spawns a module worker next to the bundle and encodes', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const w = createWorkerEncoder({ wasm });
    const fake = FakeWorker.last!;
    expect(fake.url).toMatch(/worker\.js$/);
    expect(fake.opts).toEqual({ type: 'module' });
    expect(await w.encode(wav.slice())).toEqual(encodeSync(wav));
    w.terminate();
    expect(fake.terminated).toBe(true);
  });

  it('uses a custom URL and maps worker errors', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const w = createWorkerEncoder({ url: 'https://example.test/w.js', wasm });
    const fake = FakeWorker.last!;
    expect(fake.url).toBe('https://example.test/w.js');
    const p = w.encode(wav.slice());
    const preventDefault = vi.fn();
    fake.onerror?.({ message: 'boom', preventDefault });
    await expect(p).rejects.toThrow('wav2flac worker failed: boom');
    expect(preventDefault).toHaveBeenCalled();
  });

  it('maps undeserializable messages to errors', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const w = createWorkerEncoder({ wasm });
    const p = w.encode(wav.slice());
    FakeWorker.last!.onmessageerror?.();
    await expect(p).rejects.toThrow(/could not be deserialized/);
  });
});
