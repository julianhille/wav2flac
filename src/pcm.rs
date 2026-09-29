// SPDX-License-Identifier: 0BSD
//! Unpacking of little-endian PCM bytes into samples.

use crate::error::{err, ErrorCode, Result};
use crate::riff::{Justify, SampleFormat, WavHeader};

/// Describes how to turn raw sample bytes into integers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PcmLayout {
    /// Integer or float.
    pub format: SampleFormat,
    /// Bytes per sample in the container (1..=4).
    pub container_bytes: usize,
    /// Meaningful bits per sample.
    pub valid_bits: u32,
    /// Alignment of the valid bits in the container.
    pub justify: Justify,
}

impl PcmLayout {
    /// Builds the layout from a parsed header.
    #[must_use]
    pub fn from_header(h: &WavHeader) -> Self {
        Self {
            format: h.format,
            container_bytes: usize::from(h.container_bytes),
            valid_bits: u32::from(h.valid_bits),
            justify: h.justify,
        }
    }

    /// Number of bits by which a left-justified sample must be shifted.
    fn shift(&self) -> u32 {
        (self.container_bytes as u32) * 8 - self.valid_bits
    }
}

/// Reads one sample container as a sign-extended integer holding
/// `container_bytes * 8` bits. 8-bit WAV is unsigned and is re-centred.
#[inline]
fn read_container(bytes: &[u8]) -> i32 {
    match bytes.len() {
        1 => i32::from(bytes[0]) - 128,
        2 => i32::from(i16::from_le_bytes([bytes[0], bytes[1]])),
        3 => (i32::from_le_bytes([0, bytes[0], bytes[1], bytes[2]])) >> 8,
        _ => i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
    }
}

/// Decodes integer PCM `bytes` (a whole number of samples) into `out`.
///
/// Values are returned at `valid_bits` precision. Samples whose padding bits
/// would be lost are rejected rather than silently truncated.
///
/// # Errors
///
/// `InvalidWav` if a left-justified sample has non-zero padding bits or a
/// right-justified sample does not fit into `valid_bits`.
pub fn decode_int(layout: &PcmLayout, bytes: &[u8], out: &mut Vec<i32>) -> Result<()> {
    debug_assert_eq!(layout.format, SampleFormat::Int);
    let cb = layout.container_bytes;
    debug_assert_eq!(bytes.len() % cb, 0);
    out.reserve(bytes.len() / cb);
    let shift = layout.shift();
    if shift == 0 {
        out.extend(bytes.chunks_exact(cb).map(read_container));
        return Ok(());
    }
    match layout.justify {
        Justify::Left => {
            // shift is 1..=31; computed unsigned so shift 31 cannot overflow.
            let mask = (1u32 << shift) - 1;
            for c in bytes.chunks_exact(cb) {
                let v = read_container(c);
                if v.cast_unsigned() & mask != 0 {
                    return err(
                        ErrorCode::InvalidWav,
                        format!(
                            "sample has non-zero padding bits \
                             ({} valid bits in a {}-bit container); \
                             refusing lossy truncation",
                            layout.valid_bits,
                            cb * 8
                        ),
                    );
                }
                out.push(v >> shift);
            }
        }
        Justify::Right => {
            let max = (1i32 << (layout.valid_bits - 1)) - 1;
            let min = -(1i32 << (layout.valid_bits - 1));
            for c in bytes.chunks_exact(cb) {
                let v = read_container(c);
                if v < min || v > max {
                    return err(
                        ErrorCode::InvalidWav,
                        format!(
                            "sample value {v} does not fit into {} valid bits",
                            layout.valid_bits
                        ),
                    );
                }
                out.push(v);
            }
        }
    }
    Ok(())
}

/// Decodes 32-bit float PCM `bytes` into `out` (unscaled, nominal range ±1.0).
pub fn decode_f32(bytes: &[u8], out: &mut Vec<f64>) {
    out.reserve(bytes.len() / 4);
    out.extend(
        bytes
            .chunks_exact(4)
            .map(|c| f64::from(f32::from_le_bytes([c[0], c[1], c[2], c[3]]))),
    );
}

/// Sample encoding of raw (headerless) PCM input: little-endian, interleaved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PcmFormat {
    /// Unsigned 8-bit (silence = 128), as in 8-bit WAV.
    U8,
    /// Signed 16-bit.
    S16,
    /// Signed 24-bit, packed in 3 bytes.
    S24,
    /// Signed 32-bit.
    S32,
    /// IEEE 754 32-bit float, nominal range −1.0..=1.0. Needs a target `bits_per_sample`.
    F32,
}

impl PcmFormat {
    /// Bytes per sample of one channel.
    #[must_use]
    pub fn bytes(self) -> usize {
        match self {
            Self::U8 => 1,
            Self::S16 => 2,
            Self::S24 => 3,
            Self::S32 | Self::F32 => 4,
        }
    }
}

/// Description of raw PCM input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PcmSpec {
    /// Sample encoding.
    pub format: PcmFormat,
    /// Channel count (1..=8), interleaved in FLAC/WAV channel order.
    pub channels: u16,
    /// Sample rate in Hz.
    pub sample_rate: u32,
}

impl PcmSpec {
    /// Bytes per interleaved frame (one sample of every channel).
    #[must_use]
    pub fn frame_bytes(&self) -> usize {
        self.format.bytes() * usize::from(self.channels)
    }

    /// The equivalent WAV header, as if the samples came from a plain WAV
    /// file with `data_len` bytes of data.
    #[must_use]
    pub(crate) fn to_header(self, data_len: u32) -> WavHeader {
        let (format, bytes) = match self.format {
            PcmFormat::F32 => (SampleFormat::Float, 4),
            f => (SampleFormat::Int, f.bytes() as u16),
        };
        WavHeader {
            format,
            channels: self.channels,
            sample_rate: self.sample_rate,
            valid_bits: bytes * 8,
            container_bytes: bytes,
            justify: Justify::Right,
            channel_mask: None,
            data_offset: 0,
            data_len,
            riff_end: u64::MAX,
            tags: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(cb: usize, bits: u32, justify: Justify) -> PcmLayout {
        PcmLayout {
            format: SampleFormat::Int,
            container_bytes: cb,
            valid_bits: bits,
            justify,
        }
    }

    #[test]
    fn eight_bit_is_unsigned() {
        let mut out = vec![];
        decode_int(&layout(1, 8, Justify::Right), &[0, 128, 255], &mut out).unwrap();
        assert_eq!(out, vec![-128, 0, 127]);
    }

    #[test]
    fn sixteen_and_twentyfour_bit() {
        let mut out = vec![];
        decode_int(
            &layout(2, 16, Justify::Right),
            &[0x00, 0x80, 0xFF, 0x7F],
            &mut out,
        )
        .unwrap();
        assert_eq!(out, vec![-32768, 32767]);
        out.clear();
        decode_int(
            &layout(3, 24, Justify::Right),
            &[0x00, 0x00, 0x80, 0xFF, 0xFF, 0x7F, 0xFF, 0xFF, 0xFF],
            &mut out,
        )
        .unwrap();
        assert_eq!(out, vec![-8_388_608, 8_388_607, -1]);
    }

    #[test]
    fn left_justified_20_in_24() {
        let mut out = vec![];
        // 0x7FFFF0 >> 4 = 0x7FFFF
        decode_int(&layout(3, 20, Justify::Left), &[0xF0, 0xFF, 0x7F], &mut out).unwrap();
        assert_eq!(out, vec![0x7FFFF]);
        let e = decode_int(&layout(3, 20, Justify::Left), &[0x01, 0, 0], &mut out).unwrap_err();
        assert_eq!(e.code(), ErrorCode::InvalidWav);
    }

    #[test]
    fn one_valid_bit_in_32() {
        let mut out = vec![];
        let l = layout(4, 1, Justify::Left);
        decode_int(&l, &[0, 0, 0, 0x80, 0, 0, 0, 0], &mut out).unwrap();
        assert_eq!(out, vec![-1, 0]);
        let e = decode_int(&l, &[1, 0, 0, 0], &mut out).unwrap_err();
        assert_eq!(e.code(), ErrorCode::InvalidWav);
        out.clear();
        decode_int(&layout(4, 1, Justify::Right), &[0xFF; 4], &mut out).unwrap();
        assert_eq!(out, vec![-1]);
    }

    #[test]
    fn right_justified_24_in_32() {
        let mut out = vec![];
        decode_int(
            &layout(4, 24, Justify::Right),
            &[0xFF, 0xFF, 0x7F, 0x00, 0x00, 0x00, 0x80, 0xFF],
            &mut out,
        )
        .unwrap();
        assert_eq!(out, vec![8_388_607, -8_388_608]);
        let e = decode_int(&layout(4, 24, Justify::Right), &[0, 0, 0, 0x01], &mut out).unwrap_err();
        assert_eq!(e.code(), ErrorCode::InvalidWav);
    }

    #[test]
    fn float_decoding() {
        let mut out = vec![];
        let mut b = 0.5f32.to_le_bytes().to_vec();
        b.extend_from_slice(&(-1.0f32).to_le_bytes());
        decode_f32(&b, &mut out);
        assert_eq!(out, vec![0.5, -1.0]);
    }
}
