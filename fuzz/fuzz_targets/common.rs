// SPDX-License-Identifier: 0BSD
//! Fuzzer-chosen encoder options, bounded so one run stays fast.
// Each target uses only part of this module.
#![allow(dead_code)]
use arbitrary::Arbitrary;
use wav2flac::{Dither, Options, OutputMode, ResampleQuality, Tags};

/// Output rates the fuzzer picks from: a free `u32` mostly hits ratios the
/// encoder rejects, or upsamples a few bytes into megabytes.
pub const RATES: [u32; 8] = [8_000, 11_025, 16_000, 22_050, 44_100, 48_000, 96_000, 1];

/// The options, as the fuzzer draws them. Out-of-range values are kept on
/// purpose: validation must reject them with an `Error`, not a panic.
#[derive(Arbitrary, Debug)]
pub struct FuzzOptions {
    compression_level: u8,
    block_size: Option<u16>,
    sample_rate: Option<u8>,
    quality: u8,
    bits_per_sample: Option<u8>,
    dither: bool,
    dither_seed: u64,
    tags: Option<Vec<(String, String)>>,
    seek_point_interval: u8,
    padding: u16,
    max_input_bytes: Option<u16>,
    streaming: bool,
}

impl FuzzOptions {
    pub fn options(&self) -> Options {
        Options {
            compression_level: self.compression_level % 10,
            block_size: self.block_size.map(usize::from),
            sample_rate: self
                .sample_rate
                .map(|i| RATES[usize::from(i) % RATES.len()]),
            resample_quality: match self.quality % 3 {
                0 => ResampleQuality::Fast,
                1 => ResampleQuality::Balanced,
                _ => ResampleQuality::Best,
            },
            bits_per_sample: self.bits_per_sample.map(|b| u32::from(b % 36)),
            dither: if self.dither {
                Dither::Tpdf
            } else {
                Dither::None
            },
            dither_seed: self.dither_seed,
            tags: match &self.tags {
                None => Tags::Disabled,
                Some(t) => Tags::FromWav(t.iter().take(8).cloned().collect()),
            },
            seek_point_interval: f64::from(self.seek_point_interval) / 16.0,
            padding: u32::from(self.padding),
            max_input_bytes: self.max_input_bytes.map(u64::from),
            mode: if self.streaming {
                OutputMode::Streaming
            } else {
                OutputMode::Buffered
            },
        }
    }
}

/// Cuts `data` into pieces of the given sizes, cycling; zero counts as one.
pub fn pieces<'a>(data: &'a [u8], sizes: &[u16]) -> Vec<&'a [u8]> {
    let mut out = Vec::new();
    let mut rest = data;
    let mut i = 0;
    while !rest.is_empty() {
        let n = sizes
            .get(i % sizes.len().max(1))
            .map_or(rest.len(), |&s| usize::from(s).max(1));
        let (a, b) = rest.split_at(n.min(rest.len()));
        out.push(a);
        rest = b;
        i += 1;
    }
    out
}
