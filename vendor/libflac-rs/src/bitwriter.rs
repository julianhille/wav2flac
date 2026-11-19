//! Bit-level writer with CRC-8/CRC-16, ported from `bitwriter.c`.
//!
//! libFLAC accumulates bits MSB-first into `bwword`s (32- or 64-bit, an internal
//! detail) and exposes the result as a big-endian byte stream
//! (`FLAC__bitwriter_get_buffer`, `bitwriter.c:247`); the frame CRCs are then
//! computed over those output bytes (`bitwriter.c:207`). We accumulate directly
//! into a `Vec<u8>`, flushing whole bytes as they complete: the emitted byte
//! stream — and therefore every CRC — is identical, independent of libFLAC's word
//! width (`ENABLE_64_BIT_WORDS`). All writes are big-endian / MSB-first.

use crate::crc;

#[derive(Debug, Default, Clone)]
pub struct BitWriter {
    /// Completed output bytes (MSB-first).
    buf: Vec<u8>,
    /// Pending bits, right-justified in the low `nbits` bits.
    accum: u64,
    /// Number of valid pending bits; always `0..8` between operations.
    nbits: u32,
}

impl BitWriter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Total bits written so far (`FLAC__bitwriter_get_input_bits_unconsumed`).
    /// Part of the faithful bit-writer mirror; exercised by the unit tests.
    #[allow(dead_code)]
    pub fn len_bits(&self) -> usize {
        self.buf.len() * 8 + self.nbits as usize
    }

    /// True when the next bit starts a fresh byte (`FLAC__bitwriter_is_byte_aligned`).
    pub fn is_byte_aligned(&self) -> bool {
        self.nbits == 0
    }

    /// The output bytes. Requires byte alignment, as libFLAC's `get_buffer` does.
    pub fn as_bytes(&self) -> &[u8] {
        debug_assert_eq!(self.nbits, 0, "as_bytes() requires byte alignment");
        &self.buf
    }

    /// CRC-8 over the bytes written so far (`FLAC__bitwriter_get_write_crc8`).
    pub fn crc8(&self) -> u8 {
        crc::crc8(self.as_bytes())
    }

    /// CRC-16 over the bytes written so far (`FLAC__bitwriter_get_write_crc16`).
    pub fn crc16(&self) -> u16 {
        crc::crc16(self.as_bytes())
    }

    /// Write the low `bits` bits of `val`, MSB-first
    /// (`FLAC__bitwriter_write_raw_uint32`). `bits` must be `<= 32`.
    pub fn write_raw_u32(&mut self, val: u32, bits: u32) {
        debug_assert!(bits <= 32);
        if bits == 0 {
            return;
        }
        // Keep only the `bits` low bits so stale high bits can't corrupt the stream
        // (matches the masking in `write_raw_int32`; a no-op for clean callers).
        let val = if bits < 32 {
            val & ((1u32 << bits) - 1)
        } else {
            val
        };
        self.accum = (self.accum << bits) | val as u64;
        self.nbits += bits;
        while self.nbits >= 8 {
            self.nbits -= 8;
            self.buf.push((self.accum >> self.nbits) as u8);
        }
    }

    /// Write the low `bits` bits of a signed value
    /// (`FLAC__bitwriter_write_raw_int32`). Two's-complement low bits.
    pub fn write_raw_i32(&mut self, val: i32, bits: u32) {
        self.write_raw_u32(val as u32, bits);
    }

    /// Write the low `bits` bits of a 64-bit value
    /// (`FLAC__bitwriter_write_raw_uint64`): high `bits-32` then low 32.
    pub fn write_raw_u64(&mut self, val: u64, bits: u32) {
        debug_assert!(bits <= 64);
        if bits > 32 {
            self.write_raw_u32((val >> 32) as u32, bits - 32);
            self.write_raw_u32(val as u32, 32);
        } else {
            self.write_raw_u32(val as u32, bits);
        }
    }

    /// Write `bits` zero bits (`FLAC__bitwriter_write_zeroes`).
    pub fn write_zeroes(&mut self, mut bits: u32) {
        while bits > 32 {
            self.write_raw_u32(0, 32);
            bits -= 32;
        }
        if bits > 0 {
            self.write_raw_u32(0, bits);
        }
    }

    /// Write `val` in little-endian byte order, 32 bits
    /// (`FLAC__bitwriter_write_raw_uint32_little_endian`). Used by metadata only.
    pub fn write_raw_u32_little_endian(&mut self, val: u32) {
        self.write_raw_u32(val & 0xff, 8);
        self.write_raw_u32((val >> 8) & 0xff, 8);
        self.write_raw_u32((val >> 16) & 0xff, 8);
        self.write_raw_u32(val >> 24, 8);
    }

    /// Write a block of bytes (`FLAC__bitwriter_write_byte_block`).
    pub fn write_byte_block(&mut self, vals: &[u8]) {
        for &v in vals {
            self.write_raw_u32(v as u32, 8);
        }
    }

    /// Unary: `val` zero bits then a terminating `1` (`FLAC__bitwriter_write_unary_unsigned`).
    pub fn write_unary_unsigned(&mut self, val: u32) {
        self.write_zeroes(val);
        self.write_raw_u32(1, 1);
    }

    /// Write the low `bits` bits of a signed 64-bit value
    /// (`FLAC__bitwriter_write_raw_int64`). Two's-complement low bits.
    pub fn write_raw_i64(&mut self, val: i64, bits: u32) {
        self.write_raw_u64(val as u64, bits);
    }

    /// Zero-pad to the next byte boundary
    /// (`FLAC__bitwriter_zero_pad_to_byte_boundary`).
    pub fn zero_pad_to_byte_boundary(&mut self) {
        if self.nbits != 0 {
            self.write_zeroes(8 - self.nbits);
        }
    }

    /// UTF-8-style coding of a 31-bit value (`FLAC__bitwriter_write_utf8_uint32`),
    /// used for the frame number in a fixed-block-size stream.
    pub fn write_utf8_u32(&mut self, val: u32) {
        debug_assert_eq!(val & 0x8000_0000, 0, "write_utf8_u32 handles 31 bits");
        if val < 0x80 {
            self.write_raw_u32(val, 8);
        } else if val < 0x800 {
            self.write_raw_u32(0xC0 | (val >> 6), 8);
            self.write_raw_u32(0x80 | (val & 0x3F), 8);
        } else if val < 0x10000 {
            self.write_raw_u32(0xE0 | (val >> 12), 8);
            self.write_raw_u32(0x80 | ((val >> 6) & 0x3F), 8);
            self.write_raw_u32(0x80 | (val & 0x3F), 8);
        } else if val < 0x200000 {
            self.write_raw_u32(0xF0 | (val >> 18), 8);
            self.write_raw_u32(0x80 | ((val >> 12) & 0x3F), 8);
            self.write_raw_u32(0x80 | ((val >> 6) & 0x3F), 8);
            self.write_raw_u32(0x80 | (val & 0x3F), 8);
        } else if val < 0x400_0000 {
            self.write_raw_u32(0xF8 | (val >> 24), 8);
            self.write_raw_u32(0x80 | ((val >> 18) & 0x3F), 8);
            self.write_raw_u32(0x80 | ((val >> 12) & 0x3F), 8);
            self.write_raw_u32(0x80 | ((val >> 6) & 0x3F), 8);
            self.write_raw_u32(0x80 | (val & 0x3F), 8);
        } else {
            self.write_raw_u32(0xFC | (val >> 30), 8);
            self.write_raw_u32(0x80 | ((val >> 24) & 0x3F), 8);
            self.write_raw_u32(0x80 | ((val >> 18) & 0x3F), 8);
            self.write_raw_u32(0x80 | ((val >> 12) & 0x3F), 8);
            self.write_raw_u32(0x80 | ((val >> 6) & 0x3F), 8);
            self.write_raw_u32(0x80 | (val & 0x3F), 8);
        }
    }

    /// UTF-8-style coding of a 36-bit value (`FLAC__bitwriter_write_utf8_uint64`),
    /// used for the sample number in a variable-block-size stream. Extends the 6-byte
    /// UTF-8 form with a 7-byte form (`0xFE` lead, no value bits) for 32–36 bits.
    /// The encoder only emits fixed block size, so this mirror is currently used just
    /// by the decoder's variable-block-size tests.
    #[allow(dead_code)]
    pub fn write_utf8_u64(&mut self, val: u64) {
        debug_assert_eq!(
            val & 0xFFFF_FFF0_0000_0000,
            0,
            "write_utf8_u64 handles 36 bits"
        );
        if val < 0x80 {
            self.write_raw_u32(val as u32, 8);
        } else if val < 0x800 {
            self.write_raw_u32(0xC0 | (val >> 6) as u32, 8);
            self.write_raw_u32(0x80 | (val & 0x3F) as u32, 8);
        } else if val < 0x10000 {
            self.write_raw_u32(0xE0 | (val >> 12) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 6) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | (val & 0x3F) as u32, 8);
        } else if val < 0x200000 {
            self.write_raw_u32(0xF0 | (val >> 18) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 12) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 6) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | (val & 0x3F) as u32, 8);
        } else if val < 0x4000000 {
            self.write_raw_u32(0xF8 | (val >> 24) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 18) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 12) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 6) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | (val & 0x3F) as u32, 8);
        } else if val < 0x80000000 {
            self.write_raw_u32(0xFC | (val >> 30) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 24) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 18) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 12) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 6) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | (val & 0x3F) as u32, 8);
        } else {
            // 7-byte form: 0xFE lead carries no value bits; six continuations = 36b.
            self.write_raw_u32(0xFE, 8);
            self.write_raw_u32(0x80 | ((val >> 30) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 24) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 18) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 12) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | ((val >> 6) & 0x3F) as u32, 8);
            self.write_raw_u32(0x80 | (val & 0x3F) as u32, 8);
        }
    }

    /// Rice-code a block of signed residuals with a single parameter
    /// (`FLAC__bitwriter_write_rice_signed_block`). Per value: `msbs` zero bits, a
    /// `1` stop bit, then the low `parameter` bits of the zigzag-folded value. The
    /// C version's `wide_accum` machinery is just word-buffer batching; the emitted
    /// bits are identical.
    pub fn write_rice_signed_block(&mut self, vals: &[i32], parameter: u32) {
        debug_assert!(parameter < 31);
        let lsb_mask = (1u32 << parameter) - 1;
        let stop = 1u32 << parameter;
        for &val in vals {
            // fold signed -> unsigned (zigzag): negative? -2v-1 : 2v.
            let uval = ((val as u32) << 1) ^ ((val >> 31) as u32);
            self.write_zeroes(uval >> parameter); // unary MSBs
            self.write_raw_u32(stop | (uval & lsb_mask), 1 + parameter); // stop bit + LSBs
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_u32_msb_first_bytes() {
        let mut bw = BitWriter::new();
        bw.write_raw_u32(0xABCD, 16);
        assert!(bw.is_byte_aligned());
        assert_eq!(bw.as_bytes(), &[0xAB, 0xCD]);
        assert_eq!(bw.len_bits(), 16);
    }

    #[test]
    fn unaligned_then_aligned() {
        let mut bw = BitWriter::new();
        bw.write_raw_u32(0b101, 3);
        bw.write_raw_u32(0b11110, 5);
        assert!(bw.is_byte_aligned());
        assert_eq!(bw.as_bytes(), &[0b10111110]);
    }

    #[test]
    fn crosses_byte_and_word_boundaries() {
        let mut bw = BitWriter::new();
        // 12 + 12 + 8 = 32 bits -> 4 bytes.
        bw.write_raw_u32(0xABC, 12);
        bw.write_raw_u32(0xDEF, 12);
        bw.write_raw_u32(0x42, 8);
        assert_eq!(bw.as_bytes(), &[0xAB, 0xCD, 0xEF, 0x42]);
    }

    #[test]
    fn raw_u64_splits_high_then_low() {
        let mut bw = BitWriter::new();
        bw.write_raw_u64(0x0123_4567_89AB_CDEF, 64);
        assert_eq!(
            bw.as_bytes(),
            &[0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF]
        );
    }

    #[test]
    fn raw_u64_partial() {
        let mut bw = BitWriter::new();
        bw.write_raw_u64(0x3_FFFF_FFFF, 34); // 0b11 then 32 ones
        bw.write_zeroes(6); // pad to 40 bits = 5 bytes
        assert_eq!(bw.as_bytes(), &[0xFF, 0xFF, 0xFF, 0xFF, 0xC0]);
    }

    #[test]
    fn int32_twos_complement_low_bits() {
        let mut bw = BitWriter::new();
        bw.write_raw_i32(-1, 4); // low 4 bits of ...1111 = 0b1111
        bw.write_raw_i32(-2, 4); // 0b1110
        assert_eq!(bw.as_bytes(), &[0xFE]);
    }

    #[test]
    fn unary_small_and_large() {
        let mut bw = BitWriter::new();
        bw.write_unary_unsigned(0); // just "1"
        bw.write_unary_unsigned(3); // "0001"
        // bits: "1" "0001" "000" pad = 10001000
        bw.write_zeroes(3);
        assert_eq!(bw.as_bytes(), &[0b10001000]);

        let mut bw = BitWriter::new();
        bw.write_unary_unsigned(10); // ten zeroes then 1 = 11 bits
        bw.write_zeroes(5);
        // bits: 0000000000 1 00000 = 0x00, 0x20
        assert_eq!(bw.as_bytes(), &[0x00, 0b00100000]);
    }

    #[test]
    fn zeroes_long_run() {
        let mut bw = BitWriter::new();
        bw.write_zeroes(80);
        assert_eq!(bw.as_bytes(), &[0u8; 10]);
        assert_eq!(bw.len_bits(), 80);
    }

    #[test]
    fn byte_block_roundtrip() {
        let mut bw = BitWriter::new();
        bw.write_byte_block(b"fLaC");
        assert_eq!(bw.as_bytes(), b"fLaC");
    }

    #[test]
    fn little_endian_u32() {
        let mut bw = BitWriter::new();
        bw.write_raw_u32_little_endian(0x11223344);
        assert_eq!(bw.as_bytes(), &[0x44, 0x33, 0x22, 0x11]);
    }
}
