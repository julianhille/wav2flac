//! Integer log helpers, ported from `bitmath.c` (`FLAC__bitmath_ilog2*` /
//! `FLAC__bitmath_silog2`). Used by the LPC residual bit-width bounds and the
//! auto qlp-precision clamp.

/// `floor(log2(v))` for `v > 0` (`FLAC__bitmath_ilog2`): the index of the highest
/// set bit.
#[inline]
pub fn ilog2(v: u32) -> u32 {
    debug_assert!(v > 0);
    31 - v.leading_zeros()
}

/// `floor(log2(v))` for a 64-bit `v > 0` (`FLAC__bitmath_ilog2_wide`).
#[inline]
pub fn ilog2_wide(v: u64) -> u32 {
    debug_assert!(v > 0);
    63 - v.leading_zeros()
}

/// Bits needed to represent the signed value `v`, two's-complement
/// (`FLAC__bitmath_silog2`, `bitmath.c:63`): 0 for `v == 0`, otherwise
/// `ilog2(|adjusted|) + 2`. See the worked examples in `bitmath.c`.
pub fn silog2(v: i64) -> u32 {
    if v == 0 {
        return 0;
    }
    if v == -1 {
        return 2;
    }
    let v = if v < 0 { -(v + 1) } else { v };
    ilog2_wide(v as u64) + 2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silog2_matches_reference_table() {
        // The exact table from the bitmath.c doc comment.
        let cases: &[(i64, u32)] = &[
            (-10, 5),
            (-9, 5),
            (-8, 4),
            (-7, 4),
            (-6, 4),
            (-5, 4),
            (-4, 3),
            (-3, 3),
            (-2, 2),
            (-1, 2),
            (0, 0),
            (1, 2),
            (2, 3),
            (3, 3),
            (4, 4),
            (5, 4),
            (6, 4),
            (7, 4),
            (8, 5),
            (9, 5),
            (10, 5),
        ];
        for &(v, want) in cases {
            assert_eq!(silog2(v), want, "silog2({v})");
        }
    }

    #[test]
    fn ilog2_basics() {
        assert_eq!(ilog2(1), 0);
        assert_eq!(ilog2(2), 1);
        assert_eq!(ilog2(3), 1);
        assert_eq!(ilog2(12), 3);
        assert_eq!(ilog2(0x8000_0000), 31);
    }
}
