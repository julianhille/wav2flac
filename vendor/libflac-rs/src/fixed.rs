//! Fixed predictors (orders 0–4), ported from `fixed.c`.
//!
//! The channel signal is carried as `i64` throughout the encoder so the 33-bit
//! side channel (32-bit stereo) and the wide fixed residuals fit without overflow;
//! for ≤24-bit signals every value fits `i32` and the results are identical to the
//! narrow path.

use crate::format::MAX_FIXED_ORDER;

/// Pick the fixed predictor order 0..=4 and its estimated residual bits-per-sample
/// (`FLAC__fixed_compute_best_predictor*`, `fixed.c:222/301/377/424`). The bps
/// estimate is what `process_subframe_` (`stream_encoder.c:3561`) compares against
/// `subframe_bps` to decide whether the fixed subframe is even worth evaluating.
/// Two selection modes match libFLAC's per-bps dispatch (`stream_encoder.c:3493`):
///
/// * `subframe_bps < 28` — the `_wide` path: the sum of `|residual|` for every
///   order over the **aligned** range `[MAX_FIXED_ORDER, len)`, lowest order
///   preferred on ties; the estimate uses the chosen order's sum.
/// * `subframe_bps >= 28` — the `_limit_residual` path: each order's sum is taken
///   over its **own** valid range `[order, len)`, an order is invalid if any
///   single residual magnitude exceeds `i32::MAX`, and `CHECK_ORDER_IS_VALID`
///   picks the smallest valid sum (lowest order on ties). Per the macro, the
///   estimate uses `total_error_0` for whichever order won, or `34.0` if no order
///   was valid (which then suppresses the fixed subframe).
pub fn compute_best_predictor_order(signal: &[i64], subframe_bps: u32) -> (u32, f32) {
    let n = signal.len();
    let data_len = (n - MAX_FIXED_ORDER as usize) as f64; // = blocksize - 4
    if subframe_bps < 28 {
        let mut te = [0u64; 5];
        for i in MAX_FIXED_ORDER as usize..n {
            let d0 = signal[i];
            let d1 = signal[i - 1];
            let d2 = signal[i - 2];
            let d3 = signal[i - 3];
            let d4 = signal[i - 4];
            te[0] += d0.unsigned_abs();
            te[1] += (d0 - d1).unsigned_abs();
            te[2] += (d0 - 2 * d1 + d2).unsigned_abs();
            te[3] += (d0 - 3 * d1 + 3 * d2 - d3).unsigned_abs();
            te[4] += (d0 - 4 * d1 + 6 * d2 - 4 * d3 + d4).unsigned_abs();
        }
        // Prefer the lowest order (the C uses `<=` against the min of the rest).
        let order = if te[0] <= te[1].min(te[2]).min(te[3]).min(te[4]) {
            0
        } else if te[1] <= te[2].min(te[3]).min(te[4]) {
            1
        } else if te[2] <= te[3].min(te[4]) {
            2
        } else if te[3] <= te[4] {
            3
        } else {
            4
        };
        (order, rbps_estimate(te[order as usize], data_len))
    } else {
        // `_limit_residual` / `_limit_residual_33bit`: per-order ranges + validity.
        let imax = i32::MAX as u64;
        let mut te = [0u64; 5];
        let mut valid = [true; 5];
        for i in 0..n {
            let mut check = |k: usize, e: i64| {
                let e = e.unsigned_abs();
                te[k] += e;
                if e > imax {
                    valid[k] = false;
                }
            };
            check(0, signal[i]);
            if i >= 1 {
                check(1, signal[i] - signal[i - 1]);
            }
            if i >= 2 {
                check(2, signal[i] - 2 * signal[i - 1] + signal[i - 2]);
            }
            if i >= 3 {
                check(
                    3,
                    signal[i] - 3 * signal[i - 1] + 3 * signal[i - 2] - signal[i - 3],
                );
            }
            if i >= 4 {
                check(
                    4,
                    signal[i] - 4 * signal[i - 1] + 6 * signal[i - 2] - 4 * signal[i - 3]
                        + signal[i - 4],
                );
            }
        }
        // CHECK_ORDER_IS_VALID, orders 0..4 in turn: smallest valid sum wins, with
        // lowest-order preference (strict `<` and increasing order).
        let mut order = 0u32;
        let mut smallest = u64::MAX;
        let mut found = false;
        for k in 0..5 {
            if valid[k] && te[k] < smallest {
                order = k as u32;
                smallest = te[k];
                found = true;
            }
        }
        // The macro computes the estimate from total_error_0 for the winning order,
        // or marks it 34.0 (the no-valid-order sentinel).
        let rbps = if found {
            rbps_estimate(te[0], data_len)
        } else {
            34.0
        };
        (order, rbps)
    }
}

/// The expected residual bits-per-sample estimate libFLAC derives from a fixed
/// predictor's total error (`fixed.c:284`): `log(ln2 * err / n) / ln2`, as `f32`.
fn rbps_estimate(total_error: u64, data_len: f64) -> f32 {
    if total_error > 0 {
        let ln2 = std::f64::consts::LN_2;
        (libm::log(ln2 * total_error as f64 / data_len) / ln2) as f32
    } else {
        0.0
    }
}

/// Fixed-predictor residual for `order` over `signal[order..]`
/// (`FLAC__fixed_compute_residual*`, `fixed.c:470`). Computed in `i64` and cast to
/// `i32`; the cast wraps for 32-bit signals exactly as the C's `_wide`/`_wide_33bit`
/// variants do (and is lossless for ≤24-bit, where it equals the narrow path).
pub fn compute_residual(signal: &[i64], order: u32) -> Vec<i32> {
    let n = signal.len();
    match order {
        0 => signal.iter().map(|&s| s as i32).collect(),
        1 => (1..n).map(|i| (signal[i] - signal[i - 1]) as i32).collect(),
        2 => (2..n)
            .map(|i| (signal[i] - 2 * signal[i - 1] + signal[i - 2]) as i32)
            .collect(),
        3 => (3..n)
            .map(|i| (signal[i] - 3 * signal[i - 1] + 3 * signal[i - 2] - signal[i - 3]) as i32)
            .collect(),
        4 => (4..n)
            .map(|i| {
                (signal[i] - 4 * signal[i - 1] + 6 * signal[i - 2] - 4 * signal[i - 3]
                    + signal[i - 4]) as i32
            })
            .collect(),
        _ => unreachable!("fixed order <= 4"),
    }
}
