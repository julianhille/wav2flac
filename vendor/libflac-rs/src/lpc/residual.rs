//! LPC residual from quantized coefficients
//! (`FLAC__lpc_compute_residual_from_qlp_coefficients*`, `lpc.c:321`).
//!
//! The prediction sum is accumulated in `i64` and the residual formed as
//! `data[i] - (sum >> shift)`. libFLAC has several variants (32-bit accumulator,
//! 64-bit, and an overflow-checking `limit_residual`) and `evaluate_lpc_subframe_`
//! selects among them by the predictor/residual bit bounds; whenever a 32-bit
//! accumulator is chosen the encoder has already proven it cannot overflow, so the
//! `i64` accumulation reproduces the chosen variant's output exactly. The bound
//! check and the overflow *bail* live in the subframe evaluator (it is what
//! distinguishes "use this residual" from "can't LPC at this order").

use crate::bitmath::silog2;

/// Compute `blocksize - order` residuals for the given quantized predictor.
/// `signal` is the full subframe signal (warmup included); `shift` is the
/// quantization level (`>= 0`).
pub fn compute_residual(signal: &[i64], order: usize, qlp_coeff: &[i32], shift: i32) -> Vec<i32> {
    let data_len = signal.len() - order;
    let mut residual = vec![0i32; data_len];
    for i in 0..data_len {
        let mut sum = 0i64;
        for j in 0..order {
            sum += qlp_coeff[j] as i64 * signal[order + i - 1 - j];
        }
        residual[i] = (signal[order + i] - (sum >> shift)) as i32;
    }
    residual
}

/// Overflow-checked residual (`..._limit_residual`, `lpc.c:832`). Returns `None`
/// if any residual would be `<= INT32_MIN` or `> INT32_MAX` (the C bails to "can't
/// LPC at this order"); the encoder selects this path when `max_residual_bps > 32`.
pub fn compute_residual_limit(
    signal: &[i64],
    order: usize,
    qlp_coeff: &[i32],
    shift: i32,
) -> Option<Vec<i32>> {
    let data_len = signal.len() - order;
    let mut residual = vec![0i32; data_len];
    for i in 0..data_len {
        let mut sum = 0i64;
        for j in 0..order {
            sum += qlp_coeff[j] as i64 * signal[order + i - 1 - j];
        }
        let r = signal[order + i] - (sum >> shift);
        if r <= i32::MIN as i64 || r > i32::MAX as i64 {
            return None;
        }
        residual[i] = r as i32;
    }
    Some(residual)
}

/// Max bits in the predictor sum before the shift
/// (`FLAC__lpc_max_prediction_before_shift_bps`, `lpc.c:942`):
/// `subframe_bps + silog2(Σ|qlp_coeff|)`.
pub fn max_prediction_before_shift_bps(subframe_bps: u32, qlp_coeff: &[i32], order: usize) -> u32 {
    let mut abs_sum = 0i32;
    for &c in &qlp_coeff[..order] {
        abs_sum += c.abs();
    }
    if abs_sum == 0 {
        abs_sum = 1;
    }
    subframe_bps + silog2(abs_sum as i64)
}

/// Max bits in a residual sample (`FLAC__lpc_max_residual_bps`, `lpc.c:958`); when
/// this exceeds 32 the encoder must use the overflow-checked residual path.
pub fn max_residual_bps(
    subframe_bps: u32,
    qlp_coeff: &[i32],
    order: usize,
    lp_quantization: i32,
) -> u32 {
    let predictor_sum_bps =
        max_prediction_before_shift_bps(subframe_bps, qlp_coeff, order) as i32 - lp_quantization;
    if subframe_bps as i32 > predictor_sum_bps {
        subframe_bps + 1
    } else {
        (predictor_sum_bps + 1) as u32
    }
}
