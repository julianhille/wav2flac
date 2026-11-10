// SPDX-License-Identifier: 0BSD
//! Raw PCM of any format, declared length or none, in arbitrary pieces.
#![no_main]
mod common;

use arbitrary::Arbitrary;
use common::{pieces, FuzzOptions};
use libfuzzer_sys::fuzz_target;
use wav2flac::{Encoder, PcmFormat, PcmSpec};

#[derive(Arbitrary, Debug)]
struct Input<'a> {
    opts: FuzzOptions,
    format: u8,
    channels: u16,
    sample_rate: u32,
    total_bytes: Option<u16>,
    sizes: Vec<u16>,
    pcm: &'a [u8],
}

fuzz_target!(|input: Input<'_>| {
    let spec = PcmSpec {
        format: match input.format % 5 {
            0 => PcmFormat::U8,
            1 => PcmFormat::S16,
            2 => PcmFormat::S24,
            3 => PcmFormat::S32,
            _ => PcmFormat::F32,
        },
        channels: input.channels,
        // Bounded, or a low input rate with a high output rate upsamples a
        // few bytes into gigabytes; the ratio limit still gets exercised.
        sample_rate: input.sample_rate % 200_000,
    };
    let total = input.total_bytes.map(u64::from);
    let Ok(mut e) = Encoder::new_pcm(input.opts.options(), spec, total) else {
        return;
    };
    for p in pieces(input.pcm, &input.sizes) {
        if e.push(p).is_err() {
            assert!(
                e.push(p).is_err() && e.finish().is_err(),
                "usable after an error"
            );
            return;
        }
    }
    let _ = e.finish();
});
