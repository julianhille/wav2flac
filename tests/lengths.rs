// SPDX-License-Identifier: 0BSD
//! Edge-case lengths: empty, tiny, and around block boundaries (including a
//! final block shorter than flacenc's 32-sample minimum).
mod common;
use common::*;
use wav2flac::Options;

#[test]
fn boundary_lengths_default_block() {
    let bs = 4096usize;
    let lengths = [
        0usize,
        1,
        2,
        31,
        32,
        33,
        1000,
        bs - 1,
        bs,
        bs + 1,
        2 * bs - 1,
        2 * bs,
        2 * bs + 1,
        7919,
        104_729,
    ];
    for &n in &lengths {
        for channels in [1u16, 2, 5] {
            let s = signal(Signal::Noise, 16, usize::from(channels), n, n as u64);
            assert_roundtrip(&s, channels, 44100, 16, Options::default());
        }
    }
}

#[test]
fn boundary_lengths_small_blocks() {
    for bs in [32usize, 33, 192, 576, 1152] {
        for n in [0usize, 1, bs - 1, bs, bs + 1, 3 * bs + 17] {
            let s = signal(Signal::Sine, 24, 2, n, 1);
            let opts = Options {
                block_size: Some(bs),
                ..Options::default()
            };
            let flac = assert_roundtrip(&s, 2, 48000, 24, opts);
            let d = decode(&flac);
            assert_eq!(usize::from(d.max_block), bs);
        }
    }
}

#[test]
fn empty_file_is_valid_flac() {
    let flac = encode(&wav(2, 44100, 16, &[]), Options::default());
    let d = decode(&flac);
    assert!(d.samples.is_empty());
    assert_eq!(d.total_samples.unwrap_or(0), 0);
    // MD5 of nothing
    assert_eq!(d.md5, pcm_md5(&[], 16));
}
