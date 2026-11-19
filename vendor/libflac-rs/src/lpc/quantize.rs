//! LPC coefficient quantization (`FLAC__lpc_quantize_coefficients`, `lpc.c:220`).
//!
//! **Bit-exactness hazards:**
//! * The scale exponent comes from `frexp(cmax)` — replicated here exactly,
//!   including subnormals, via the IEEE-754 exponent field.
//! * The error-feedback accumulator is `f64`, but each `lp_coeff[i] * (1<<shift)`
//!   term is an `f32` product (C computes `float * int` in `float`) promoted to
//!   `f64` for the running sum.
//! * `q = lround(error)` is glibc's `lround` (round half away from zero, C99) —
//!   matched by `f64::round` + cast (the oracle is built `HAVE_LROUND=1`).

use crate::format::SUBFRAME_LPC_QLP_SHIFT_LEN;

/// Quantized coefficients plus the right-shift to apply when predicting.
pub struct Quantized {
    pub qlp_coeff: Vec<i32>,
    pub shift: i32,
}

/// The `frexp` exponent: the `e` for which `x == m * 2^e`, `m ∈ [0.5, 1)`. `x`
/// must be positive and finite. Matches glibc `frexp`'s out-parameter exactly,
/// including subnormal inputs (which `frexp` normalizes).
fn frexp_exponent(x: f64) -> i32 {
    debug_assert!(x > 0.0 && x.is_finite());
    let raw = ((x.to_bits() >> 52) & 0x7ff) as i32;
    if raw != 0 {
        raw - 1022 // (raw - 1023) + 1
    } else {
        // Subnormal: scale into the normal range by 2^64, then correct.
        let scaled = x * (2f64).powi(64);
        (((scaled.to_bits() >> 52) & 0x7ff) as i32) - 1022 - 64
    }
}

/// Quantize `lp_coeff[0..order]` to `precision`-bit integers with a common shift
/// (`FLAC__lpc_quantize_coefficients`). Returns `Err(code)` matching the C return
/// codes — `1` = coefficients need more shift than the 5-bit field allows, `2` =
/// all-zero coefficients — which the caller treats as "can't LPC at this order".
pub fn quantize_coefficients(
    lp_coeff: &[f32],
    order: usize,
    precision: u32,
) -> Result<Quantized, i32> {
    // Drop one bit for the sign; consider only |lp_coeff[i]| from here.
    let precision = precision - 1;
    let qmax0 = 1i32 << precision;
    let qmin = -qmax0;
    let qmax = qmax0 - 1;

    let mut cmax = 0.0f64;
    for &c in &lp_coeff[..order] {
        let d = (c as f64).abs();
        if d > cmax {
            cmax = d;
        }
    }

    if cmax <= 0.0 {
        // Coefficients are all 0, which means constant-detect didn't work.
        return Err(2);
    }

    let max_shiftlimit = (1i32 << (SUBFRAME_LPC_QLP_SHIFT_LEN - 1)) - 1; // 15
    let min_shiftlimit = -max_shiftlimit - 1; // -16
    // C: `(void)frexp(cmax, &log2cmax); log2cmax--;` — frexp's exponent minus one.
    let log2cmax = frexp_exponent(cmax) - 1;
    let mut shift = precision as i32 - log2cmax - 1;
    if shift > max_shiftlimit {
        shift = max_shiftlimit;
    } else if shift < min_shiftlimit {
        return Err(1);
    }

    let mut qlp_coeff = vec![0i32; order];
    if shift >= 0 {
        let scale = (1i32 << shift) as f32;
        let mut error = 0.0f64;
        for i in 0..order {
            error += (lp_coeff[i] * scale) as f64;
            let mut q = error.round() as i32;
            if q > qmax {
                q = qmax;
            } else if q < qmin {
                q = qmin;
            }
            error -= q as f64;
            qlp_coeff[i] = q;
        }
    } else {
        // Negative shift is very rare; the decoder forbids it, so scale the coeffs
        // down instead and emit shift 0.
        let divisor = (1i32 << -shift) as f32;
        let mut error = 0.0f64;
        for i in 0..order {
            error += (lp_coeff[i] / divisor) as f64;
            let mut q = error.round() as i32;
            if q > qmax {
                q = qmax;
            } else if q < qmin {
                q = qmin;
            }
            error -= q as f64;
            qlp_coeff[i] = q;
        }
        shift = 0;
    }

    Ok(Quantized { qlp_coeff, shift })
}
