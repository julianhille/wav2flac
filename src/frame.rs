// SPDX-License-Identifier: 0BSD
//! Post-processing of encoded FLAC frames.
//!
//! libflac-rs encodes whole buffers and numbers the frames of every call from
//! zero. We encode one block per call (bounded memory, output independent of
//! how the input was chunked) and rewrite each frame's number here,
//! recomputing the header CRC-8 and the frame CRC-16.

use crate::error::{err, ErrorCode, Result};

/// CRC-8, polynomial x^8 + x^2 + x + 1 (0x07), init 0 (frame header).
#[must_use]
pub fn crc8(data: &[u8]) -> u8 {
    let mut crc = 0u8;
    for &b in data {
        crc ^= b;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x07
            } else {
                crc << 1
            };
        }
    }
    crc
}

const fn crc16_table() -> [u16; 256] {
    let mut t = [0u16; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = (i as u16) << 8;
        let mut k = 0;
        while k < 8 {
            c = if c & 0x8000 != 0 {
                (c << 1) ^ 0x8005
            } else {
                c << 1
            };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
}

static CRC16_TABLE: [u16; 256] = crc16_table();

/// CRC-16, polynomial x^16 + x^15 + x^2 + 1 (0x8005), init 0 (whole frame).
#[must_use]
pub fn crc16(data: &[u8]) -> u16 {
    data.iter().fold(0u16, |crc, &b| {
        (crc << 8) ^ CRC16_TABLE[usize::from((crc >> 8) as u8 ^ b)]
    })
}

/// Appends `n` in FLAC's UTF-8-like variable-length coding.
fn put_utf8(n: u32, out: &mut Vec<u8>) {
    if n < 0x80 {
        out.push(n as u8);
        return;
    }
    let len = match n {
        0..=0x7FF => 2,
        0x800..=0xFFFF => 3,
        0x1_0000..=0x1F_FFFF => 4,
        0x20_0000..=0x3FF_FFFF => 5,
        _ => 6,
    };
    let lead = (0xFF00u16 >> len) as u8; // 110xxxxx, 1110xxxx, ...
    out.push(lead | (n >> (6 * (len - 1))) as u8);
    for i in (0..len - 1).rev() {
        out.push(0x80 | ((n >> (6 * i)) & 0x3F) as u8);
    }
}

/// Length of the header fields after the coded frame number
/// (block-size and sample-rate hints), excluding the CRC-8.
fn hint_len(b2: u8) -> usize {
    let bs = match b2 >> 4 {
        0b0110 => 1,
        0b0111 => 2,
        _ => 0,
    };
    let sr = match b2 & 0x0F {
        0b1100 => 1,
        0b1101 | 0b1110 => 2,
        _ => 0,
    };
    bs + sr
}

/// Copies a single fixed-blocksize `frame` (numbered 0) to `out`, rewriting its
/// frame number to `number`. Returns the number of bytes written.
///
/// # Errors
///
/// `Internal` if `frame` is not a well-formed frame numbered 0.
pub fn renumber(frame: &[u8], number: u32, out: &mut Vec<u8>) -> Result<usize> {
    if frame.len() < 8 || frame[0] != 0xFF || frame[1] != 0xF8 || frame[4] != 0 {
        return err(ErrorCode::Internal, "unexpected frame header from encoder");
    }
    let hints = hint_len(frame[2]);
    let old_hl = 5 + hints; // bytes before the CRC-8
    if frame.len() < old_hl + 3 {
        return err(ErrorCode::Internal, "frame shorter than its header");
    }
    let start = out.len();
    out.extend_from_slice(&frame[..4]);
    put_utf8(number, out);
    out.extend_from_slice(&frame[5..old_hl]);
    let c8 = crc8(&out[start..]);
    out.push(c8);
    out.extend_from_slice(&frame[old_hl + 1..frame.len() - 2]);
    let c16 = crc16(&out[start..]);
    out.extend_from_slice(&c16.to_be_bytes());
    Ok(out.len() - start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_reference_values() {
        // "123456789" check values for CRC-8/SMBUS and CRC-16/UMTS (FLAC's CRCs).
        assert_eq!(crc8(b"123456789"), 0xF4);
        assert_eq!(crc16(b"123456789"), 0xFEE8);
    }

    #[test]
    fn hint_len_covers_every_code() {
        // Extra header bytes per block-size code (upper nibble) and
        // sample-rate code (lower nibble), from the FLAC format spec:
        // 0110/0111 = 8/16-bit block size; 1100 = 8-bit kHz, 1101/1110 =
        // 16-bit Hz / tens of Hz.
        const BS: [usize; 16] = [0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0];
        const SR: [usize; 16] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 0];
        for bs in 0..16u8 {
            for sr in 0..16u8 {
                let want = BS[usize::from(bs)] + SR[usize::from(sr)];
                assert_eq!(hint_len((bs << 4) | sr), want, "{bs:04b} {sr:04b}");
            }
        }
    }

    #[test]
    fn utf8_coding_matches_flac() {
        let enc = |n| {
            let mut v = vec![];
            put_utf8(n, &mut v);
            v
        };
        assert_eq!(enc(0), vec![0]);
        assert_eq!(enc(0x7F), vec![0x7F]);
        assert_eq!(enc(0x80), vec![0xC2, 0x80]);
        assert_eq!(enc(0x7FF), vec![0xDF, 0xBF]);
        assert_eq!(enc(0x800), vec![0xE0, 0xA0, 0x80]);
        assert_eq!(enc(0x7FFF_FFFF), vec![0xFD, 0xBF, 0xBF, 0xBF, 0xBF, 0xBF]);
    }
}
