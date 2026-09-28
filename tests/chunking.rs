// SPDX-License-Identifier: 0BSD
//! Output must not depend on how the input is split across `push` calls.
mod common;
use common::*;
use wav2flac::{Options, OutputMode};

fn fixtures() -> Vec<(Vec<u8>, Options)> {
    let mut b = WavBuilder::pcm(2, 44100, 24).extensible(32, 24, 0x3);
    b.chunks_before = vec![
        (*b"LIST", info_list(&[(b"INAM", b"chunky")])),
        (*b"odd ", vec![1; 5]),
    ];
    vec![
        (
            wav(2, 44100, 16, &signal(Signal::Noise, 16, 2, 20_000, 1)),
            Options::default(),
        ),
        (
            b.build(&signal(Signal::Sine, 24, 2, 9000, 2)),
            Options::default(),
        ),
        (
            wav(1, 8000, 8, &signal(Signal::Ramp, 8, 1, 7777, 3)),
            Options {
                block_size: Some(100),
                ..Options::default()
            },
        ),
        (
            wav(2, 48000, 24, &signal(Signal::Sine, 24, 2, 20_000, 4)),
            Options {
                sample_rate: Some(44100),
                bits_per_sample: Some(16),
                ..Options::default()
            },
        ),
    ]
}

#[test]
fn fixed_chunk_sizes_are_equivalent() {
    for (w, opts) in fixtures() {
        let reference = encode(&w, opts.clone());
        for sz in [1usize, 2, 3, 7, 13, 4095, 4096, 65536] {
            let got = encode_chunked(&w, opts.clone(), &[sz]).unwrap();
            assert!(got == reference, "chunk size {sz} differs");
        }
    }
}

#[test]
fn random_split_patterns_are_equivalent() {
    let n = if tier() >= Tier::Full { 200 } else { 25 };
    let mut rng = Rng(7);
    for (w, opts) in fixtures() {
        let reference = encode(&w, opts.clone());
        for _ in 0..n {
            let pattern: Vec<usize> = (0..1 + rng.below(8))
                .map(|_| 1 + rng.below(5000) as usize)
                .collect();
            let got = encode_chunked(&w, opts.clone(), &pattern).unwrap();
            assert!(got == reference, "pattern {pattern:?} differs");
        }
    }
}

#[test]
fn split_at_every_header_byte() {
    let (w, opts) = fixtures().swap_remove(1);
    let reference = encode(&w, opts.clone());
    for cut in 1..120.min(w.len()) {
        let got = encode_chunked(&w, opts.clone(), &[cut, w.len()]).unwrap();
        assert!(got == reference, "cut at {cut} differs");
    }
}

#[test]
fn streaming_mode_is_chunk_invariant_too() {
    for (w, opts) in fixtures() {
        let opts = Options {
            mode: OutputMode::Streaming,
            ..opts
        };
        let reference = encode_chunked(&w, opts.clone(), &[w.len()]).unwrap();
        for sz in [1usize, 5, 1000] {
            assert!(encode_chunked(&w, opts.clone(), &[sz]).unwrap() == reference);
        }
    }
}

#[test]
fn odd_chunks_are_processed_once_at_every_split() {
    // An odd-sized LIST (its last INFO value has no pad byte) and an odd-sized
    // `fmt ` chunk: the pad lookahead past each of them can need more input,
    // and resuming must not parse the chunk again (duplicate tags or a
    // "duplicate fmt chunk" error).
    let mut list = b"INFOINAM".to_vec();
    list.extend_from_slice(&5u32.to_le_bytes());
    list.extend_from_slice(b"Title");
    let mut b = WavBuilder::pcm(1, 8000, 16);
    b.fmt_size = Some(17);
    b.chunks_before = vec![(*b"LIST", list)];
    let w = b.build(&signal(Signal::Sine, 16, 1, 300, 3));
    let opts = Options::default();
    let reference = encode(&w, opts.clone());
    let (blocks, _) = metadata_blocks(&reference);
    let (_, comments) = parse_vorbis(&blocks.iter().find(|b| b.0 == 4).unwrap().2);
    let titles = comments.iter().filter(|(k, _)| k == "TITLE").count();
    assert_eq!(titles, 1, "{comments:?}");
    let header_len = w.len() - 600;
    for cut in 1..header_len + 2 {
        let got = encode_chunked(&w, opts.clone(), &[cut, w.len()]).unwrap();
        assert!(got == reference, "cut at {cut} differs");
    }
    for sz in [1usize, 2, 3] {
        assert!(encode_chunked(&w, opts.clone(), &[sz]).unwrap() == reference);
    }
}
