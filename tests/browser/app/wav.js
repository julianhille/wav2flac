// SPDX-License-Identifier: 0BSD
/**
 * Deterministic test WAV shared by the browser app and the Node reference:
 * 16-bit stereo, 2 s at 44.1 kHz, a chord plus xorshift noise.
 * @returns {Uint8Array} the WAV file
 */
export function testWav() {
  const rate = 44100,
    frames = rate * 2,
    ch = 2;
  const buf = new Uint8Array(44 + frames * ch * 2);
  const v = new DataView(buf.buffer);
  const tag = (o, s) => {
    for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, buf.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, frames * ch * 2, true);
  let x = 0x9e3779b9;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      const t = i / rate;
      const s =
        8000 * Math.sin(2 * Math.PI * 440 * t) + 5000 * Math.sin(2 * Math.PI * (554 + c) * t);
      v.setInt16(44 + (i * ch + c) * 2, Math.round(s + ((x >>> 0) % 512) - 256), true);
    }
  }
  return buf;
}

/** Options for every encode in the smoke test (exercises the resampler too). */
export const OPTIONS = { sampleRate: 22050, bitsPerSample: 16, compressionLevel: 6 };
