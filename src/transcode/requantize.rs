// SPDX-License-Identifier: 0BSD
//! Conversion of normalized `f64` samples to integers of a target bit depth,
//! with optional TPDF dither from a deterministic generator.

use crate::options::Dither;

/// SplitMix64: tiny, fast, deterministic and good enough for dither noise.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    /// Creates a generator from a seed.
    #[must_use]
    pub const fn new(seed: u64) -> Self {
        Self(seed)
    }

    /// Next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }
}

/// Quantizes normalized samples (nominal range ±1.0) to `bits`-bit integers.
#[derive(Debug, Clone)]
pub struct Requantizer {
    scale: f64,
    min: f64,
    max: f64,
    dither: Dither,
    rng: Rng,
}

impl Requantizer {
    /// Creates a quantizer for `bits` (4..=32) output bits.
    #[must_use]
    pub fn new(bits: u32, dither: Dither, seed: u64) -> Self {
        let scale = f64::from(1u32 << (bits - 1));
        Self {
            scale,
            min: -scale,
            max: scale - 1.0,
            dither,
            rng: Rng::new(seed),
        }
    }

    /// Quantizes one sample, saturating at the integer range.
    #[inline]
    pub fn quantize(&mut self, x: f64) -> i32 {
        let mut v = x * self.scale;
        if self.dither == Dither::Tpdf {
            v += self.rng.next_f64() - self.rng.next_f64();
        }
        let r = v.round();
        // `clamp` passes NaN through; map it to silence explicitly.
        let r = if r.is_nan() {
            0.0
        } else {
            r.clamp(self.min, self.max)
        };
        r as i32
    }

    /// Quantizes all samples of `input` into `out`.
    pub fn run(&mut self, input: &[f64], out: &mut Vec<i32>) {
        out.reserve(input.len());
        for &x in input {
            let q = self.quantize(x);
            out.push(q);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_without_dither() {
        let mut q = Requantizer::new(16, Dither::None, 0);
        assert_eq!(q.quantize(0.0), 0);
        assert_eq!(q.quantize(1.0), 32767);
        assert_eq!(q.quantize(-1.0), -32768);
        assert_eq!(q.quantize(2.0), 32767);
        assert_eq!(q.quantize(f64::NAN), 0);
        assert_eq!(q.quantize(0.5 / 32768.0 * 3.0), 2); // 1.5 rounds away from zero
    }

    #[test]
    fn dither_is_deterministic_and_bounded() {
        let mut a = Requantizer::new(16, Dither::Tpdf, 7);
        let mut b = Requantizer::new(16, Dither::Tpdf, 7);
        let mut c = Requantizer::new(16, Dither::Tpdf, 8);
        let xs: Vec<f64> = (0..1000).map(|i| f64::from(i) / 1000.0 - 0.5).collect();
        let (mut oa, mut ob, mut oc) = (vec![], vec![], vec![]);
        a.run(&xs, &mut oa);
        b.run(&xs, &mut ob);
        c.run(&xs, &mut oc);
        assert_eq!(oa, ob);
        assert_ne!(oa, oc);
        for (x, q) in xs.iter().zip(&oa) {
            assert!((f64::from(*q) - x * 32768.0).abs() <= 1.5);
        }
    }
}
