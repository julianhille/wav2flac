// SPDX-License-Identifier: 0BSD
/**
 * Deterministic WAV generator shared by the JS tests and the benchmark.
 * @module
 */

/** Signal shapes. `music` mixes tones, harmonics and noise (realistic compression). */
export type Signal = 'silence' | 'sine' | 'noise' | 'music';

/** WAV generation parameters. */
export interface WavSpec {
  /** Sample frames (samples per channel). */
  frames: number;
  /** Sample rate in Hz. Default 44100. */
  rate?: number;
  /** Channels. Default 2. */
  channels?: number;
  /** Bits per sample: 8, 16, 24, 32 (int) or 32 with `float`. Default 16. */
  bits?: 8 | 16 | 24 | 32;
  /** Write IEEE float samples (bits must be 32). */
  float?: boolean;
  /** Signal shape. Default `'music'`. */
  signal?: Signal;
  /** PRNG seed. Default 1. */
  seed?: number;
  /** Write WAVE_FORMAT_EXTENSIBLE with this channel mask. */
  channelMask?: number;
}

/**
 * mulberry32 PRNG.
 * @param seed Seed.
 * @returns A function returning floats in [0, 1).
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds a WAV file.
 * @param spec Parameters.
 * @returns The file bytes.
 */
export function makeWav(spec: WavSpec): Uint8Array<ArrayBuffer> {
  const rate = spec.rate ?? 44100;
  const ch = spec.channels ?? 2;
  const bits = spec.bits ?? 16;
  const float = spec.float ?? false;
  const bytesPer = bits / 8;
  const ext = spec.channelMask !== undefined;
  const fmtLen = ext ? 40 : 16;
  const dataLen = spec.frames * ch * bytesPer;
  const hdr = 12 + 8 + fmtLen + 8;
  const buf = new Uint8Array(hdr + dataLen + (dataLen & 1));
  const v = new DataView(buf.buffer);
  const tag = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, buf.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, fmtLen, true);
  const fmtTag = float ? 3 : 1;
  v.setUint16(20, ext ? 0xfffe : fmtTag, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * ch * bytesPer, true);
  v.setUint16(32, ch * bytesPer, true);
  v.setUint16(34, bits, true);
  if (ext) {
    v.setUint16(36, 22, true);
    v.setUint16(38, bits, true);
    v.setUint32(40, spec.channelMask!, true);
    // KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT GUID
    v.setUint16(44, fmtTag, true);
    buf.set([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 46);
  }
  tag(12 + 8 + fmtLen, 'data');
  v.setUint32(12 + 8 + fmtLen + 4, dataLen, true);

  const rnd = rng(spec.seed ?? 1);
  const signal = spec.signal ?? 'music';
  const full = float ? 1 : 2 ** (bits - 1) - 1;
  const w = (2 * Math.PI) / rate;
  let o = hdr;
  for (let i = 0; i < spec.frames; i++) {
    for (let c = 0; c < ch; c++) {
      let x: number;
      switch (signal) {
        case 'silence': x = 0; break;
        case 'sine': x = 0.5 * Math.sin(w * 997 * (c + 1) * i); break;
        case 'noise': x = rnd() * 2 - 1; break;
        default: {
          const env = 0.6 + 0.4 * Math.sin(w * 0.5 * i);
          x = env * (0.3 * Math.sin(w * 220 * (c + 1) * i) + 0.15 * Math.sin(w * 660 * i + c) + 0.08 * Math.sin(w * 3520 * i))
            + 0.02 * (rnd() * 2 - 1);
        }
      }
      if (float) v.setFloat32(o, x, true);
      else {
        const s = Math.max(-full - 1, Math.min(full, Math.round(x * full)));
        if (bits === 8) buf[o] = s + 128;
        else if (bits === 16) v.setInt16(o, s, true);
        else if (bits === 24) {
          buf[o] = s & 0xff;
          buf[o + 1] = (s >> 8) & 0xff;
          buf[o + 2] = (s >> 16) & 0xff;
        } else v.setInt32(o, s, true);
      }
      o += bytesPer;
    }
  }
  return buf;
}

/**
 * A `ReadableStream` over `bytes` in chunks of `size`.
 * @param bytes The bytes.
 * @param size Chunk size.
 * @returns The stream.
 */
export function streamOf(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= bytes.length) c.close();
      else {
        c.enqueue(bytes.slice(i, i + size));
        i += size;
      }
    },
  });
}

/**
 * Reads a whole stream into one buffer.
 * @param s The stream.
 * @returns The concatenated bytes.
 */
export async function collect(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of s) parts.push(p);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
