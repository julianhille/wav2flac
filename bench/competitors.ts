// SPDX-License-Identifier: 0BSD
/**
 * Other FLAC encoders for the web, benchmarked on the same input:
 *
 * - **libav.js** (`@libav.js/variant-flac`): FFmpeg's FLAC encoder compiled
 *   to wasm. By default it runs in its own Web Worker / worker thread and
 *   every call is a message round trip; the frames are muxed into a `.flac`
 *   file in its in-memory filesystem.
 * - **libflac.js** (`libflacjs`): the reference libFLAC compiled to wasm; a
 *   synchronous API on the calling thread.
 *
 * Neither reads WAV files, so both get the samples as raw PCM (prepared
 * before timing, like the `pcm-int` input). The conversion each library
 * needs on top of that (to `Int32Array`, or 24-bit samples shifted into the
 * top of 32 bits for FFmpeg) counts towards its time: it is work every caller
 * of that library has to do. Both are dev dependencies of the benchmark only;
 * they are not part of the package.
 * @module
 */

/** Interleaved integer samples and their format. */
export interface PcmSamples {
  /** Interleaved samples: `Int16Array` for 16-bit, 3-byte little-endian `Uint8Array` for 24-bit. */
  data: Int16Array | Uint8Array;
  /** Bits per sample, 16 or 24. */
  bits: 16 | 24;
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Channels. */
  channels: number;
}

/** A loaded competitor, ready to encode repeatedly. */
export interface Competitor {
  /**
   * Encodes one input to a complete FLAC file.
   * @param pcm The samples.
   * @param level Compression level 0–8.
   * @returns The FLAC bytes.
   */
  encode(pcm: PcmSamples, level: number): Promise<Uint8Array>;
  /**
   * The wasm memory of the encoding instance, if observable.
   * @returns Bytes, or `null` (e.g. inside libav.js's own worker).
   */
  wasmBytes(): number | null;
  /** Releases the instance (terminates libav.js's worker). */
  close(): void;
}

/** The parts of libav.js's `LibAV` instance the benchmark uses. */
export interface LibAVInstance {
  AV_SAMPLE_FMT_S16: number;
  AV_SAMPLE_FMT_S32: number;
  ff_init_encoder(
    name: string,
    opts: {
      ctx: Record<string, number>;
      time_base: [number, number];
      options?: Record<string, string>;
    },
  ): Promise<[number, number, number, number, number]>;
  ff_init_muxer(
    opts: { format_name: string; filename: string; open: boolean },
    streams: [number, number, number][],
  ): Promise<[number, number, number, number[]]>;
  avformat_write_header(oc: number, options: number): Promise<number>;
  ff_encode_multi(
    c: number,
    frame: number,
    pkt: number,
    frames: unknown[],
    fin: boolean,
  ): Promise<unknown[]>;
  ff_write_multi(oc: number, pkt: number, packets: unknown[]): Promise<void>;
  av_write_trailer(oc: number): Promise<number>;
  ff_free_muxer(oc: number, pb: number): Promise<void>;
  ff_free_encoder(c: number, frame: number, pkt: number): Promise<void>;
  readFile(name: string): Promise<Uint8Array>;
  unlink(name: string): Promise<void>;
  terminate?(): void;
}

/** The parts of libflac.js's `Flac` object the benchmark uses. */
export interface FlacLib {
  isReady(): boolean;
  on(event: 'ready', cb: () => void): void;
  create_libflac_encoder(
    rate: number,
    channels: number,
    bps: number,
    level: number,
    totalSamples: number,
    verify: boolean,
    blockSize: number,
  ): number;
  init_encoder_stream(enc: number, write: (data: Uint8Array) => void): number;
  FLAC__stream_encoder_process_interleaved(enc: number, buf: Int32Array, frames: number): boolean;
  FLAC__stream_encoder_finish(enc: number): boolean;
  FLAC__stream_encoder_delete(enc: number): void;
}

/** How a runner loads the libraries (URLs in the browser, packages in Node). */
export interface Loaders {
  /** Creates a libav.js instance (starts its worker). */
  libav(): Promise<LibAVInstance>;
  /** Loads libflac.js. */
  libflac(): Promise<FlacLib>;
}

/** Samples per libflac.js call. */
const FRAMES_PER_CALL = 4608;

/**
 * Concatenates chunks.
 * @param parts The chunks.
 * @returns One array.
 */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Widens interleaved samples to `Int32Array`.
 * @param pcm The samples.
 * @param shift Left shift applied to every sample.
 * @returns The samples as 32-bit integers.
 */
export function toInt32(pcm: PcmSamples, shift = 0): Int32Array {
  if (pcm.data instanceof Int16Array) {
    const out = new Int32Array(pcm.data.length);
    for (let i = 0; i < out.length; i++) out[i] = pcm.data[i]! << shift;
    return out;
  }
  const b = pcm.data;
  const out = new Int32Array(b.length / 3);
  for (let i = 0, j = 0; i < out.length; i++, j += 3) {
    out[i] = (((b[j]! | (b[j + 1]! << 8) | (b[j + 2]! << 16)) << 8) >> 8) << shift;
  }
  return out;
}

/**
 * FFmpeg's default channel layout mask for a channel count (`AV_CH_LAYOUT_*`).
 * @param channels Channels, 1–8.
 * @returns The mask.
 */
function layout(channels: number): number {
  return [0x4, 0x3, 0x7, 0x33, 0x37, 0x3f, 0x13f, 0x63f][channels - 1] ?? 0;
}

/**
 * Wraps a libav.js instance.
 * @param av The instance (already started).
 * @returns The competitor.
 */
export function libavCompetitor(av: LibAVInstance): Competitor {
  let n = 0;
  return {
    async encode(pcm, level) {
      const s16 = pcm.bits === 16;
      const format = s16 ? av.AV_SAMPLE_FMT_S16 : av.AV_SAMPLE_FMT_S32;
      // FFmpeg takes 24-bit audio as S32 with the samples in the top 24 bits.
      const data = s16 ? (pcm.data as Int16Array) : toInt32(pcm, 8);
      const [, c, frame, pkt, frameSize] = await av.ff_init_encoder('flac', {
        ctx: {
          sample_fmt: format,
          sample_rate: pcm.sampleRate,
          channel_layout: layout(pcm.channels),
          channels: pcm.channels,
        },
        time_base: [1, pcm.sampleRate],
        options: { compression_level: String(level) },
      });
      const file = `bench-${n++}.flac`;
      const [oc, , pb] = await av.ff_init_muxer(
        { format_name: 'flac', filename: file, open: true },
        [[c, 1, pcm.sampleRate]],
      );
      try {
        await av.avformat_write_header(oc, 0);
        const frames = [];
        // FFmpeg's FLAC encoder takes exactly `frameSize` samples per frame (it depends on the rate).
        const step = frameSize * pcm.channels;
        for (let o = 0; o < data.length; o += step) {
          const d = data.subarray(o, o + step);
          frames.push({
            data: d,
            format,
            pts: o / pcm.channels,
            sample_rate: pcm.sampleRate,
            channel_layout: layout(pcm.channels),
            channels: pcm.channels,
            nb_samples: d.length / pcm.channels,
          });
        }
        const packets = await av.ff_encode_multi(c, frame, pkt, frames, true);
        await av.ff_write_multi(oc, pkt, packets);
        await av.av_write_trailer(oc);
      } finally {
        await av.ff_free_muxer(oc, pb);
        await av.ff_free_encoder(c, frame, pkt);
      }
      const out = await av.readFile(file);
      await av.unlink(file);
      return out;
    },
    wasmBytes: () => null,
    close: () => av.terminate?.(),
  };
}

/**
 * Wraps libflac.js.
 * @param flac The loaded library.
 * @returns The competitor.
 */
export function libflacCompetitor(flac: FlacLib): Competitor {
  return {
    async encode(pcm, level) {
      const samples = toInt32(pcm);
      const frames = samples.length / pcm.channels;
      const enc = flac.create_libflac_encoder(
        pcm.sampleRate,
        pcm.channels,
        pcm.bits,
        level,
        frames,
        false,
        0,
      );
      if (enc === 0) throw new Error('libflac.js: creating the encoder failed');
      const parts: Uint8Array[] = [];
      try {
        const status = flac.init_encoder_stream(enc, (d) => parts.push(new Uint8Array(d)));
        if (status !== 0) throw new Error(`libflac.js: init failed (${status})`);
        const step = FRAMES_PER_CALL * pcm.channels;
        for (let o = 0; o < samples.length; o += step) {
          const chunk = samples.subarray(o, o + step);
          if (
            !flac.FLAC__stream_encoder_process_interleaved(enc, chunk, chunk.length / pcm.channels)
          ) {
            throw new Error('libflac.js: encoding failed');
          }
        }
        if (!flac.FLAC__stream_encoder_finish(enc)) throw new Error('libflac.js: finish failed');
      } finally {
        flac.FLAC__stream_encoder_delete(enc);
      }
      return concat(parts);
    },
    // libflac.js keeps its Emscripten module private.
    wasmBytes: () => null,
    close: () => undefined,
  };
}

/** A competitor mode. */
export type CompetitorMode = 'libav' | 'libflac';

/**
 * Loads a competitor.
 * @param mode Which one.
 * @param load The runner's loaders.
 * @returns The competitor.
 */
export async function loadCompetitor(mode: CompetitorMode, load: Loaders): Promise<Competitor> {
  if (mode === 'libav') return libavCompetitor(await load.libav());
  const flac = await load.libflac();
  if (!flac.isReady()) await new Promise<void>((ok) => flac.on('ready', ok));
  return libflacCompetitor(flac);
}

/**
 * The raw samples a competitor gets for a WAV (before timing).
 * @param wav WAV bytes, 16- or 24-bit integer PCM.
 * @returns The samples.
 * @throws {Error} For other formats.
 */
export function competitorInput(wav: Uint8Array<ArrayBuffer>): PcmSamples {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let fmt: { channels: number; rate: number; bits: number; tag: number } | undefined;
  for (let o = 12; o + 8 <= wav.length;) {
    const id = String.fromCharCode(...wav.subarray(o, o + 4));
    const len = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      let tag = v.getUint16(o + 8, true);
      if (tag === 0xfffe && len >= 26) tag = v.getUint16(o + 32, true);
      fmt = {
        tag,
        channels: v.getUint16(o + 10, true),
        rate: v.getUint32(o + 12, true),
        bits: v.getUint16(o + 22, true),
      };
    } else if (id === 'data') {
      if (fmt === undefined) throw new Error('WAV has no fmt chunk before data');
      if (fmt.tag !== 1 || (fmt.bits !== 16 && fmt.bits !== 24)) {
        throw new Error('the other encoders are benchmarked on 16- and 24-bit integer WAVs only');
      }
      const align = (fmt.bits / 8) * fmt.channels;
      const n = Math.min(len, wav.length - o - 8);
      const bytes = wav.slice(o + 8, o + 8 + n - (n % align));
      const data = fmt.bits === 16 ? new Int16Array(bytes.buffer, 0, bytes.length / 2) : bytes;
      return { data, bits: fmt.bits, sampleRate: fmt.rate, channels: fmt.channels };
    }
    o += 8 + len + (len & 1);
  }
  throw new Error('WAV has no data chunk');
}
