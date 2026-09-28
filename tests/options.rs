// SPDX-License-Identifier: 0BSD
//! Every compression level and block size must be lossless; bad options are rejected.
mod common;
use common::*;
use wav2flac::{Encoder, ErrorCode, Options};

#[test]
fn levels_by_block_sizes() {
    let blocks = [16usize, 32, 192, 576, 1152, 4096, 4608, 16384, 32767, 65535];
    let s = signal(Signal::Sine, 16, 2, 40_000, 2);
    for level in 0..=8u8 {
        for bs in sample_matrix(&blocks, 3) {
            let opts = Options {
                compression_level: level,
                block_size: Some(bs),
                ..Options::default()
            };
            assert_roundtrip(&s, 2, 44100, 16, opts);
        }
    }
}

#[test]
fn higher_levels_are_not_larger() {
    // Soft monotonicity on a compressible signal: level 8 <= level 0.
    let s = signal(Signal::Sine, 16, 2, 100_000, 3);
    let w = wav(2, 44100, 16, &s);
    let size = |level| {
        encode(
            &w,
            Options {
                compression_level: level,
                padding: 0,
                ..Options::default()
            },
        )
        .len()
    };
    let (l0, l5, l8) = (size(0), size(5), size(8));
    assert!(l5 <= l0, "level5 {l5} > level0 {l0}");
    assert!(l8 <= l0, "level8 {l8} > level0 {l0}");
}

#[test]
fn invalid_options_rejected_at_construction() {
    let bad = [
        Options {
            compression_level: 9,
            ..Options::default()
        },
        Options {
            block_size: Some(15),
            ..Options::default()
        },
        Options {
            block_size: Some(65536),
            ..Options::default()
        },
        Options {
            sample_rate: Some(0),
            ..Options::default()
        },
        Options {
            sample_rate: Some(2_000_000),
            ..Options::default()
        },
        Options {
            bits_per_sample: Some(3),
            ..Options::default()
        },
        Options {
            bits_per_sample: Some(33),
            ..Options::default()
        },
        Options {
            seek_point_interval: -1.0,
            ..Options::default()
        },
        Options {
            padding: 1 << 24,
            ..Options::default()
        },
    ];
    for o in bad {
        let e = Encoder::new(o.clone()).err().expect("should fail");
        assert_eq!(e.code(), ErrorCode::InvalidOptions, "{o:?}");
    }
}

#[test]
fn padding_option_controls_block() {
    let s = signal(Signal::Noise, 16, 1, 100, 1);
    for pad in [0u32, 1, 8192, 100_000] {
        let flac = encode(
            &wav(1, 8000, 16, &s),
            Options {
                padding: pad,
                ..Options::default()
            },
        );
        let (blocks, _) = metadata_blocks(&flac);
        let p: Vec<_> = blocks.iter().filter(|b| b.0 == 1).collect();
        if pad == 0 {
            assert!(p.is_empty());
        } else {
            assert_eq!(p.len(), 1);
            assert_eq!(p[0].2.len(), pad as usize);
        }
    }
}
