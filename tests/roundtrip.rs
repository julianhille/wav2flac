// SPDX-License-Identifier: 0BSD
//! Lossless round trips across bit depths, channel counts, rates and signals.
mod common;
use common::*;
use wav2flac::Options;

/// Covers every frame-header sample-rate code: the fixed ones, rates in kHz
/// (12k, 64k, 128k), in Hz (11025, 12345), in tens of Hz (384k) and "see
/// STREAMINFO" (1 048 575 Hz, the largest rate FLAC can store).
const RATES: [u32; 18] = [
    8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000, 128_000,
    176_400, 192_000, 384_000, 12345, 1_048_575,
];

#[test]
fn matrix_bits_channels_signals() {
    let mut cases = 0;
    for bits in [8u16, 16, 24, 32] {
        for channels in 1u16..=8 {
            for (i, sig) in ALL_SIGNALS.iter().enumerate() {
                // Quick tier: a rotating subset; full tier: everything.
                if tier() == Tier::Quick && (i + usize::from(channels) + usize::from(bits)) % 3 != 0
                {
                    continue;
                }
                let frames = 5000;
                let s = signal(*sig, u32::from(bits), usize::from(channels), frames, 42);
                assert_roundtrip(&s, channels, 44100, bits, Options::default());
                cases += 1;
            }
        }
    }
    assert!(cases > 0);
}

#[test]
fn all_sample_rates() {
    for rate in sample_matrix(&RATES, 1) {
        for bits in [16u16, 24, 32] {
            // Several frames, so frames numbered above 0 are rewritten too.
            let s = signal(Signal::Sine, u32::from(bits), 2, 9000, 1);
            assert_roundtrip(&s, 2, rate, bits, Options::default());
        }
    }
}

#[test]
fn full_rate_signal_matrix() {
    if tier() < Tier::Full {
        return;
    }
    for rate in RATES {
        for bits in [8u16, 16, 24] {
            for channels in [1u16, 2, 6, 8] {
                for sig in ALL_SIGNALS {
                    let s = signal(sig, u32::from(bits), usize::from(channels), 2500, 9);
                    assert_roundtrip(&s, channels, rate, bits, Options::default());
                }
            }
        }
    }
}

#[test]
fn long_noise_many_frames() {
    let frames = if tier() >= Tier::Full {
        1_000_000
    } else {
        100_000
    };
    let s = signal(Signal::Noise, 16, 2, frames, 3);
    assert_roundtrip(&s, 2, 48000, 16, Options::default());
}

#[test]
fn streaminfo_block_and_frame_sizes() {
    let s = signal(Signal::Noise, 16, 2, 10_000, 5);
    let flac = encode(&wav(2, 44100, 16, &s), Options::default());
    let d = decode(&flac);
    assert_eq!(d.min_block, 4096);
    assert_eq!(d.max_block, 4096);
    let (blocks, _) = metadata_blocks(&flac);
    let si = &blocks[0].2;
    let min_frame = u32::from_be_bytes([0, si[4], si[5], si[6]]);
    let max_frame = u32::from_be_bytes([0, si[7], si[8], si[9]]);
    assert!(
        min_frame > 0 && min_frame <= max_frame,
        "{min_frame} {max_frame}"
    );
}
