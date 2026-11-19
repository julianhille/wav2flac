//! CRC-8 (frame header) and CRC-16 (frame footer), ported from `crc.c`.
//!
//! - CRC-8: poly `x^8 + x^2 + x^1 + x^0` (0x07), init 0.
//! - CRC-16: poly `x^16 + x^15 + x^2 + x^0` (0x8005), init 0.
//!
//! `crc.c` ships precomputed tables (an 8×256 CRC-16 table for an 8-byte-at-a-time
//! loop); we generate the 256-entry tables from the polynomials at compile time
//! instead — byte-at-a-time with `table[0]` yields bit-identical results, asserted
//! byte-for-byte against the C `FLAC__crc8`/`FLAC__crc16` (`crc.c:366`, `crc.c:376`)
//! by the differential harness (see `ORACLE.md`).

/// CRC-8 table: `table[i]` = CRC-8 of the single byte `i` (`crc.c:41`).
const fn crc8_table() -> [u8; 256] {
    let mut t = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u8;
        let mut j = 0;
        while j < 8 {
            crc = (crc << 1) ^ if crc & 0x80 != 0 { 0x07 } else { 0 };
            j += 1;
        }
        t[i] = crc;
        i += 1;
    }
    t
}

/// CRC-16 table[0] (`crc.c:344`, the documented generator): `table[i] = ` the
/// CRC-16 of `i << 8` reduced by the 0x8005 polynomial.
const fn crc16_table() -> [u16; 256] {
    let mut t = [0u16; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = (i as u16) << 8;
        let mut j = 0;
        while j < 8 {
            crc = (crc << 1) ^ if crc & 0x8000 != 0 { 0x8005 } else { 0 };
            j += 1;
        }
        t[i] = crc;
        i += 1;
    }
    t
}

static CRC8_TABLE: [u8; 256] = crc8_table();
static CRC16_TABLE: [u16; 256] = crc16_table();

/// CRC-8 of `data` (`FLAC__crc8`, `crc.c:366`).
pub fn crc8(data: &[u8]) -> u8 {
    let mut crc = 0u8;
    for &b in data {
        crc = CRC8_TABLE[(crc ^ b) as usize];
    }
    crc
}

/// CRC-16 of `data` (`FLAC__crc16`, `crc.c:376`). Byte-at-a-time form of the C's
/// table-of-8 loop; identical result.
pub fn crc16(data: &[u8]) -> u16 {
    let mut crc = 0u16;
    for &b in data {
        crc = (crc << 8) ^ CRC16_TABLE[((crc >> 8) as u8 ^ b) as usize];
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc8_known_vectors() {
        assert_eq!(crc8(&[]), 0);
        // Table entries are the CRC of single bytes.
        assert_eq!(crc8(&[0x01]), 0x07);
        assert_eq!(crc8(&[0x02]), 0x0E);
        assert_eq!(crc8(&[0xFF]), 0xF3);
    }

    #[test]
    fn crc16_known_vectors() {
        assert_eq!(crc16(&[]), 0);
        // CRC-16/BUYPASS check value: "123456789" -> 0xFEE8.
        assert_eq!(crc16(b"123456789"), 0xFEE8);
    }

    #[test]
    fn crc8_first_table_row_matches_reference() {
        // A spot check of the generated table against crc.c:41's literal values.
        let t = crc8_table();
        assert_eq!(t[0], 0x00);
        assert_eq!(t[7], 0x15);
        assert_eq!(t[8], 0x38);
        assert_eq!(t[255], 0xF3);
    }

    #[test]
    fn crc16_first_table_row_matches_reference() {
        let t = crc16_table();
        assert_eq!(t[0], 0x0000);
        assert_eq!(t[1], 0x8005);
        assert_eq!(t[2], 0x800F);
        assert_eq!(t[255], 0x0202);
    }
}
