// SPDX-License-Identifier: 0BSD
// The worker client and host, connected in-process through a MessageChannel.
import { getEventListeners } from 'node:events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wav2FlacError } from '../../ts/lib/errors.js';
import { encodeSync } from '../../ts/index.js';
import { liveSessions } from '../../ts/lib/engine.js';
import type { FromWorker, Port, ToWorker } from '../../ts/lib/protocol.js';
import { OUTPUT_WINDOW, transferOf } from '../../ts/lib/protocol.js';
import { normalizeOptions } from '../../ts/lib/options.js';
import { connect, createWorkerEncoder, type WorkerEncoder } from '../../ts/lib/worker-client.js';
import { serve } from '../../ts/lib/worker-host.js';
import { collect, makeWav, streamOf } from '../helpers/wav.js';

const wasm = readFileSync('build/bindgen/wav2flac_bg.wasm');
const wav = makeWav({ frames: 44100 * 2, seed: 5 });

/**
 * Wraps a MessagePort as a protocol port and records traffic.
 * @param p The port.
 * @param log Messages sent through it.
 */
function wrap<I, O>(p: MessagePort, log: O[] = []): Port<I, O> {
  return {
    post: (m, t) => { log.push(m); p.postMessage(m, t as never); },
    listen: (on, onErr) => { p.on('message', on); p.on('messageerror', onErr); },
    ref: (k) => (k ? p.ref() : p.unref()),
    close: () => p.close(),
  };
}

let open: WorkerEncoder[] = [];
afterEach(() => {
  for (const w of open) w.terminate();
  open = [];
});

/** A client/host pair over a fresh channel. */
function pair(): { w: WorkerEncoder; toHost: ToWorker[]; toClient: FromWorker[]; hostPort: MessagePort } {
  const ch = new MessageChannel();
  const toHost: ToWorker[] = [];
  const toClient: FromWorker[] = [];
  serve(wrap<ToWorker, FromWorker>(ch.port2, toClient));
  const w = connect(wrap<FromWorker, ToWorker>(ch.port1, toHost), wasm);
  open.push(w);
  return { w, toHost, toClient, hostPort: ch.port2 };
}

describe('worker protocol', () => {
  it('encodes buffers identically, transferring or copying input', async () => {
    const { w } = pair();
    const ref = encodeSync(wav);
    const t = wav.slice();
    expect(await w.encode(t)).toEqual(ref);
    expect(t.byteLength).toBe(0); // transferred (detached)
    const kept = wav.slice();
    expect(await w.encode(kept, { copy: true })).toEqual(ref);
    expect(kept.byteLength).toBe(wav.length);
    const padded = new Uint8Array(wav.length + 3);
    padded.set(wav, 3);
    expect(await w.encode(padded.subarray(3))).toEqual(ref); // views of larger buffers are copied
    expect(padded.byteLength).toBe(wav.length + 3);
  });

  it('pulls stream input chunk by chunk', async () => {
    const { w, toHost } = pair();
    expect(await w.encode(streamOf(wav, 50_000))).toEqual(encodeSync(wav));
    expect(toHost.filter((m) => m.t === 'chunk').length).toBe(Math.ceil(wav.length / 50_000));
    expect(toHost.some((m) => m.t === 'end')).toBe(true);
  });

  it('streams output with a bounded window', async () => {
    const { w, toClient } = pair();
    const long = makeWav({ frames: 44100 * 6, signal: 'noise' });
    const s = w.encodeStream(streamOf(long, 64 * 1024)).getReader();
    const first = await s.read();
    expect(first.done).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    // Without further reads the worker may only run OUTPUT_WINDOW chunks ahead.
    expect(toClient.filter((m) => m.t === 'out').length).toBeLessThanOrEqual(OUTPUT_WINDOW + 1);
    expect(Object.prototype.toString.call(first.value!.buffer)).toBe('[object ArrayBuffer]');
    const rest: Uint8Array[] = [first.value!];
    for (;;) {
      const r = await s.read();
      if (r.done) break;
      rest.push(r.value);
    }
    const all = await collect(new ReadableStream({ start(c) { rest.forEach((x) => c.enqueue(x)); c.close(); } }));
    const ref = await collect((await import('../../ts/index.js')).encodeStream(long));
    expect(all).toEqual(ref);
  });

  it('forwards progress and errors', async () => {
    const { w } = pair();
    const seen: number[] = [];
    await w.encode(wav.slice(), { onProgress: (p) => seen.push(p.fraction ?? -1) });
    expect(seen.at(-1)).toBe(1);
    await expect(w.encode(new Uint8Array(64))).rejects.toBeInstanceOf(Wav2FlacError);
    await expect(collect(w.encodeStream(new Uint8Array(64)))).rejects.toMatchObject({ code: 'INVALID_WAV' });
    await expect(w.encode(wav.slice(), { compressionLevel: 42 })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(w.encode(wav, { bogus: true } as never)).rejects.toThrow(Wav2FlacError);
    const boom = new Error('cb');
    await expect(w.encode(wav.slice(), { onProgress: () => { throw boom; } })).rejects.toBe(boom);
  });

  it('rejects bad stream chunks and stream errors', async () => {
    const { w } = pair();
    const bad = new ReadableStream<unknown>({ start(c) { c.enqueue('x'); } }) as ReadableStream<Uint8Array>;
    await expect(w.encode(bad)).rejects.toThrow(TypeError);
    const err = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error('src')); } });
    await expect(w.encode(err)).rejects.toThrow('src');
    // The worker stays usable.
    expect((await w.encode(wav.slice())).length).toBeGreaterThan(0);
  });

  it('aborts before, during and while streaming; the worker survives', async () => {
    const { w, toHost, toClient } = pair();
    const reason = new Error('why');
    await expect(w.encode(wav.slice(), { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    const ac = new AbortController();
    const p = w.encode(streamOf(wav, 1000), { signal: ac.signal, onProgress: () => ac.abort(reason) });
    await expect(p).rejects.toBe(reason);
    expect(toHost.some((m) => m.t === 'abort')).toBe(true);

    const ac2 = new AbortController();
    const r = w.encodeStream(streamOf(makeWav({ frames: 44100 * 5, signal: 'noise' }), 8192), { signal: ac2.signal }).getReader();
    await r.read();
    ac2.abort(reason);
    await expect(r.read()).rejects.toBe(reason);

    const r2 = w.encodeStream(streamOf(wav, 8192)).getReader();
    await r2.read();
    await r2.cancel();
    expect(await w.encode(wav.slice())).toEqual(encodeSync(wav));
    // The host ends every stopped job with an error and frees its encoder.
    const stopped = toHost.flatMap((m) => (m.t === 'abort' ? [m.id] : []));
    expect(stopped).toHaveLength(3);
    for (const id of stopped) expect(toClient.some((m) => m.t === 'error' && m.id === id), `job ${id}`).toBe(true);
    expect(liveSessions()).toBe(0);
    expect(await w.wasmMemoryBytes()).toBeGreaterThan(0);
  });

  it('removes its abort listeners from a long-lived signal', async () => {
    const { w } = pair();
    const signal = new AbortController().signal;
    await w.encode(wav.slice(), { signal });
    await w.encode(streamOf(wav, 65536), { signal });
    await w.encode(new Uint8Array(100), { signal }).catch(() => 0);
    await collect(w.encodeStream(streamOf(wav, 65536), { signal }));
    await collect(w.encodeStream(new Uint8Array(100), { signal })).catch(() => 0);
    const r = w.encodeStream(streamOf(wav, 4096), { signal }).getReader();
    await r.read();
    await r.cancel();
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('probes in the worker', async () => {
    const { w } = pair();
    await expect(w.probe(wav)).resolves.toMatchObject({ channels: 2, frames: 44100 * 2 });
    await expect(w.probe(new Uint8Array(100))).rejects.toMatchObject({ code: 'INVALID_WAV' });
  });

  it('probes a header behind a large chunk by growing the prefix', async () => {
    const { w } = pair();
    const junk = 300_000;
    const big = new Uint8Array(wav.length + 8 + junk);
    big.set(wav.subarray(0, 12));
    big.set([0x4a, 0x55, 0x4e, 0x4b], 12); // "JUNK"
    new DataView(big.buffer).setUint32(16, junk, true);
    big.set(wav.subarray(12), 20 + junk);
    new DataView(big.buffer).setUint32(4, big.length - 8, true);
    await expect(w.probe(big)).resolves.toMatchObject({ channels: 2, frames: 44100 * 2 });
    expect(big.length).toBeGreaterThan(junk); // still attached: only prefixes were copied
  });

  it('explains a retry with an input transferred by an earlier call', async () => {
    const { w } = pair();
    const input = wav.slice();
    await w.encode(input);
    await expect(w.encode(input)).rejects.toThrow(/transferred.*copy: true/);
    expect(() => encodeSync(input)).toThrow(TypeError);
  });

  it('rejects pending and later jobs after terminate', async () => {
    const { w } = pair();
    const p = w.encode(streamOf(wav, 1000));
    const s = collect(w.encodeStream(streamOf(wav, 1000)));
    w.terminate();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await expect(s).rejects.toMatchObject({ name: 'AbortError' });
    await expect(w.encode(wav)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(collect(w.encodeStream(wav))).rejects.toThrow(/terminated/);
    await expect(w.probe(wav)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fails all jobs when the worker errors', async () => {
    const ch = new MessageChannel();
    let fire: (e: Error) => void = () => undefined;
    const port: Port<FromWorker, ToWorker> = {
      post: () => undefined,
      listen: (_on, onErr) => { fire = onErr; },
      ref: () => undefined,
      close: vi.fn(),
    };
    const w = connect(port, wasm);
    const p = w.encode(wav.slice());
    await new Promise((r) => setTimeout(r, 10));
    fire(new Error('crashed'));
    await expect(p).rejects.toThrow('crashed');
    expect(port.close).toHaveBeenCalled();
    ch.port1.close();
  });

  it('rejects requests when the worker dies while loading', async () => {
    let fire: (e: Error) => void = () => undefined;
    const port: Port<FromWorker, ToWorker> = {
      post: () => undefined,
      listen: (_on, onErr) => { fire = onErr; },
      ref: () => undefined,
      close: () => undefined,
    };
    const w = connect(port, wasm);
    const p = w.probe(wav.slice());
    fire(new Error('crashed'));
    await expect(p).rejects.toThrow('crashed');
    await expect(w.wasmMemoryBytes()).rejects.toThrow('crashed');
  });

  it('rejects requests on terminate while the wasm still loads', async () => {
    // A fresh loader, whose download never finishes.
    vi.resetModules();
    const client = await import('../../ts/lib/worker-client.js');
    const port: Port<FromWorker, ToWorker> = {
      post: vi.fn(),
      listen: () => undefined,
      ref: () => undefined,
      close: () => undefined,
    };
    const w = client.connect(port, new Promise<Response>(() => {}));
    const stats = w.wasmMemoryBytes();
    const info = w.probe(wav.slice(0, 64));
    w.terminate();
    await expect(stats).rejects.toMatchObject({ name: 'AbortError' });
    await expect(info).rejects.toMatchObject({ name: 'AbortError' });
    expect(port.post).not.toHaveBeenCalled();
  });

  it('rejects a request whose message cannot be posted', async () => {
    const ch = new MessageChannel();
    serve(wrap<ToWorker, FromWorker>(ch.port2));
    const inner = wrap<FromWorker, ToWorker>(ch.port1);
    let held = false;
    const w = connect({
      ...inner,
      post: (m, t) => {
        if (m.t === 'stats') throw new Error('cannot post');
        inner.post(m, t);
      },
      ref: (keep) => {
        held = keep;
        inner.ref(keep);
      },
    }, wasm);
    open.push(w);
    await expect(w.wasmMemoryBytes()).rejects.toThrow('cannot post');
    // Nothing is pending, so the port no longer keeps the process alive.
    expect(held).toBe(false);
    await expect(w.probe(wav)).resolves.toMatchObject({ channels: 2 });
  });

  it('does not lock a stream when the signal is already aborted', async () => {
    const { w } = pair();
    const s = streamOf(wav, 4096);
    const reason = new Error('stop');
    await expect(w.encode(s, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(s.locked).toBe(false);
  });

  it('reports init failures in the worker to every job', async () => {
    // A fresh host module whose realm has no wasm instance yet.
    vi.resetModules();
    const host = await import('../../ts/lib/worker-host.js');
    const ch = new MessageChannel();
    host.serve(wrap<ToWorker, FromWorker>(ch.port2));
    const client = wrap<FromWorker, ToWorker>(ch.port1);
    const inbox: FromWorker[] = [];
    client.listen((m) => inbox.push(m), () => undefined);
    // A module importing a function the glue does not provide cannot be instantiated.
    const bad = new WebAssembly.Module(new Uint8Array([
      0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, // magic, version
      1, 4, 1, 0x60, 0, 0, // type section: () -> ()
      2, 9, 1, 3, 0x65, 0x6e, 0x76, 1, 0x66, 0, 0, // import section: env.f
    ]));
    client.post({ t: 'init', module: bad }, []);
    client.post({ t: 'probe', id: 1, data: wav.slice(0, 64) }, []);
    const args = normalizeOptions(undefined, false);
    client.post({ t: 'job', id: 2, args, input: wav.slice(), progress: false, window: OUTPUT_WINDOW }, []);
    // So wasmMemoryBytes() tells a caller that this worker cannot encode.
    client.post({ t: 'stats', id: 3 }, []);
    await vi.waitFor(() => expect(inbox).toHaveLength(3));
    for (const m of inbox) expect(m).toMatchObject({ t: 'error', error: { message: expect.stringMatching(/env/) } });
    ch.port1.close();
  });

  it('ignores messages for unknown jobs', async () => {
    const { w, hostPort } = pair();
    hostPort.postMessage({ t: 'out', id: 999, data: new Uint8Array(1) });
    const ch = new MessageChannel();
    serve(wrap<ToWorker, FromWorker>(ch.port2));
    for (const t of ['ack', 'abort', 'chunk', 'end'] as const) ch.port1.postMessage({ t, id: 12345, data: new Uint8Array(1) });
    expect((await w.encode(wav.slice())).length).toBeGreaterThan(0);
    ch.port1.close();
  });

  it('transfers only whole buffers', () => {
    const b = new Uint8Array(8);
    expect(transferOf(b)).toEqual([b.buffer]);
    expect(transferOf(b.subarray(1))).toEqual([]);
    expect(transferOf(new Uint8Array(new SharedArrayBuffer(4)))).toEqual([]);
  });

  it('spawns a real worker by URL', async () => {
    const w = createWorkerEncoder({ url: new URL('../pkg-worker-missing.js', import.meta.url), wasm });
    open.push(w);
    await expect(w.encode(wav.slice())).rejects.toThrow();
  });

  it('fails pending jobs when a real worker exits unexpectedly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wav2flac-'));
    const script = join(dir, 'exit.mjs');
    // Exits once the client's init message arrives, like a crash mid-job.
    writeFileSync(script, "import { parentPort } from 'node:worker_threads';\nparentPort.on('message', () => process.exit(3));\n");
    try {
      const w = createWorkerEncoder({ url: pathToFileURL(script), wasm });
      open.push(w);
      await expect(w.encode(wav.slice())).rejects.toThrow('wav2flac worker exited with code 3');
      await expect(w.probe(wav)).rejects.toThrow(/code 3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
