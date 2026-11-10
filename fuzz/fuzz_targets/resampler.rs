// SPDX-License-Identifier: 0BSD
//! A stream resampler fed arbitrary pieces: never panics, and once flushed
//! its output has exactly ceil(frames_in * out / in) frames.
#![no_main]
mod common;

use arbitrary::Arbitrary;
use common::RATES;
use libfuzzer_sys::fuzz_target;
use wav2flac::{ResampleQuality, StreamResampler};

#[derive(Arbitrary, Debug)]
struct Input {
    from: u8,
    to: u8,
    channels: u8,
    quality: u8,
    pushes: Vec<Vec<f32>>,
}

fuzz_target!(|input: Input| {
    let from = RATES[usize::from(input.from) % RATES.len()];
    let to = RATES[usize::from(input.to) % RATES.len()];
    let channels = u16::from(input.channels % 10);
    let quality = match input.quality % 3 {
        0 => ResampleQuality::Fast,
        1 => ResampleQuality::Balanced,
        _ => ResampleQuality::Best,
    };
    let Ok(mut r) = StreamResampler::new(from, to, channels, quality) else {
        return;
    };
    let (mut samples_in, mut samples_out) = (0u64, 0u64);
    for p in input.pushes.iter().take(64) {
        samples_in += p.len() as u64;
        if r.push(p, |s| samples_out += s.len() as u64).is_err() {
            return;
        }
    }
    if r.flush(|s| samples_out += s.len() as u64).is_ok() {
        let ch = u64::from(channels);
        let frames_in = samples_in / ch;
        let want = (frames_in * u64::from(to)).div_ceil(u64::from(from));
        assert_eq!(
            samples_out,
            want * ch,
            "{frames_in} frames, {from} -> {to} Hz"
        );
    }
});
