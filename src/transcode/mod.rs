// SPDX-License-Identifier: 0BSD
//! Sample pipeline between WAV decoding and FLAC framing.
//!
//! * Lossless passthrough when neither rate nor bit depth changes.
//! * Exact left shift when only the bit depth increases.
//! * Otherwise: normalize to `f64`, optionally resample, then requantize
//!   (with dither) to the target depth.

pub mod requantize;
pub mod resample;

use crate::error::{err, ErrorCode, Result};
use crate::options::{Options, MAX_BITS, MIN_BITS};
use crate::riff::SampleFormat;
use requantize::Requantizer;
use resample::Resample;

/// Decoded input samples, interleaved.
pub enum Samples<'a> {
    /// Integer samples at the input's valid bit depth.
    Int(&'a [i32]),
    /// Float samples (nominal ±1.0).
    Float(&'a [f64]),
}

enum Mode {
    Passthrough,
    Shift(u32),
    Convert {
        in_scale: f64,
        resampler: Option<Resample>,
        requant: Requantizer,
        scratch_in: Vec<f64>,
        scratch_out: Vec<f64>,
    },
}

/// Parameters of the output stream (after resampling and requantizing).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputSpec {
    /// Output sample rate.
    pub sample_rate: u32,
    /// Output bits per sample (4..=32).
    pub bits: u32,
}

/// Converts decoded samples to the output format.
pub struct Transcoder {
    mode: Mode,
    /// Output parameters.
    pub spec: OutputSpec,
}

impl Transcoder {
    /// Decides the pipeline for an input format and the options.
    ///
    /// # Errors
    ///
    /// `UnsupportedBitDepth` / `UnsupportedFormat` when the input cannot be
    /// encoded losslessly and no explicit `bitsPerSample` was given.
    pub fn plan(
        format: SampleFormat,
        in_bits: u32,
        in_rate: u32,
        channels: usize,
        opts: &Options,
    ) -> Result<Self> {
        let out_rate = opts.sample_rate.unwrap_or(in_rate);
        let resampling = out_rate != in_rate;
        let out_bits = match (format, opts.bits_per_sample) {
            (_, Some(b)) => b,
            (SampleFormat::Float, None) => {
                return err(
                    ErrorCode::UnsupportedFormat,
                    "float WAV cannot be stored losslessly in FLAC; set bitsPerSample (e.g. 24 or 32) to convert",
                )
            }
            (SampleFormat::Int, None) if (MIN_BITS..=MAX_BITS).contains(&in_bits) => in_bits,
            (SampleFormat::Int, None) => {
                return err(
                    ErrorCode::UnsupportedBitDepth,
                    format!("{in_bits}-bit samples are outside FLAC's 4..=32 bit range"),
                )
            }
        };
        let int_in = format == SampleFormat::Int;
        let mode = if int_in && !resampling && out_bits == in_bits {
            Mode::Passthrough
        } else if int_in && !resampling && out_bits > in_bits {
            Mode::Shift(out_bits - in_bits)
        } else {
            let in_scale = if int_in {
                1.0 / f64::from(1u32 << (in_bits - 1))
            } else {
                1.0
            };
            let resampler = if resampling {
                Some(Resample::new(
                    in_rate,
                    out_rate,
                    channels,
                    opts.resample_quality,
                )?)
            } else {
                None
            };
            Mode::Convert {
                in_scale,
                resampler,
                requant: Requantizer::new(out_bits, opts.dither, opts.dither_seed),
                scratch_in: Vec::new(),
                scratch_out: Vec::new(),
            }
        };
        Ok(Self {
            mode,
            spec: OutputSpec {
                sample_rate: out_rate,
                bits: out_bits,
            },
        })
    }

    /// Converts `input`, appending output samples to `out`.
    ///
    /// # Errors
    ///
    /// `Internal` if the resampler fails.
    pub fn process(&mut self, input: Samples<'_>, out: &mut Vec<i32>) -> Result<()> {
        match (&mut self.mode, input) {
            (Mode::Passthrough, Samples::Int(s)) => out.extend_from_slice(s),
            (Mode::Shift(k), Samples::Int(s)) => {
                let k = *k;
                out.extend(s.iter().map(|v| v << k));
            }
            (
                Mode::Convert {
                    in_scale,
                    resampler,
                    requant,
                    scratch_in,
                    scratch_out,
                },
                input,
            ) => {
                scratch_in.clear();
                match input {
                    Samples::Int(s) => {
                        scratch_in.extend(s.iter().map(|v| f64::from(*v) * *in_scale));
                    }
                    // A NaN or infinity would spread through the resampler's
                    // filter to its neighbours: NaN becomes silence and
                    // infinities full scale, as the requantizer treats them.
                    Samples::Float(s) => scratch_in.extend(s.iter().map(|&v| {
                        if v.is_nan() {
                            0.0
                        } else if v.is_infinite() {
                            v.signum()
                        } else {
                            v
                        }
                    })),
                }
                if let Some(r) = resampler {
                    scratch_out.clear();
                    r.push(scratch_in, scratch_out)?;
                    requant.run(scratch_out, out);
                } else {
                    requant.run(scratch_in, out);
                }
            }
            _ => return err(ErrorCode::Internal, "sample kind does not match pipeline"),
        }
        Ok(())
    }

    /// Flushes buffered samples (resampler tail).
    ///
    /// # Errors
    ///
    /// `Internal` if the resampler fails.
    pub fn finish(&mut self, out: &mut Vec<i32>) -> Result<()> {
        if let Mode::Convert {
            resampler: Some(r),
            requant,
            scratch_out,
            ..
        } = &mut self.mode
        {
            scratch_out.clear();
            r.finish(scratch_out)?;
            requant.run(scratch_out, out);
        }
        Ok(())
    }
}
