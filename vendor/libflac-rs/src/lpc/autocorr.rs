//! Autocorrelation (`FLAC__lpc_compute_autocorrelation`, `lpc.c:110`), the plain
//! `double` template from `deduplication/lpc_compute_autocorrelation_intrin.c`.
//!
//! **Bit-exactness:** operands are promoted `f32`→`f64` and multiplied with a
//! plain `*` (NO `mul_add`/FMA — see CLAUDE.md's SIMD note: MAME builds libFLAC
//! without `FLAC__USE_AVX`, so the SSE2 `double` path == this scalar path). Each
//! `autoc[j]` accumulates `data[i]*data[i-j]` over strictly increasing `i`; the
//! C template interleaves the lags but updates each `autoc[j]` in that same order,
//! and IEEE multiply is commutative, so this per-lag loop is bit-identical to both
//! the template (lag ≤ 16) and the generic (small `data_len`) C paths.

/// Compute `autoc[0..lag]` for the windowed signal `data`. `lag` must be `> 0`
/// and `<= data.len()`; `autoc` must hold at least `lag` elements.
pub fn compute_autocorrelation(data: &[f32], lag: usize, autoc: &mut [f64]) {
    debug_assert!(lag > 0 && lag <= data.len());
    let data_len = data.len();
    for j in 0..lag {
        let mut d = 0.0f64;
        for i in j..data_len {
            d += data[i] as f64 * data[i - j] as f64;
        }
        autoc[j] = d;
    }
}
