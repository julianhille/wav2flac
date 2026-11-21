// SPDX-License-Identifier: 0BSD
//! Piped WAV from ffmpeg/sox/arecord carries placeholder sizes (issue #87).
//! They are rejected unless `ignore_chunk_sizes` is set, which encodes the
//! audio up to the end of the input.
mod common;
use common::*;
use wav2flac::{probe, ErrorCode, Options};

/// (name, RIFF size, data size) placeholders for a given block align.
fn placeholders(block_align: u32) -> Vec<(&'static str, u32, u32)> {
    vec![
        ("ffmpeg", u32::MAX, u32::MAX),
        ("sox", 0x7fff_f024, 0x7fff_f000 / block_align * block_align),
        ("arecord", 0x8000_0024, 0x8000_0000),
    ]
}

fn ignoring() -> Options {
    Options {
        ignore_chunk_sizes: true,
        ..Options::default()
    }
}

#[test]
fn placeholders_are_rejected_by_default() {
    let s = signal(Signal::Noise, 16, 2, 1000, 3);
    for (name, riff, data) in placeholders(4) {
        for (r, d) in [(Some(riff), Some(data)), (None, Some(data))] {
            let mut b = WavBuilder::pcm(2, 8000, 16);
            b.riff_len_override = r;
            b.data_len_override = d;
            let bytes = b.build(&s);
            let e = wav2flac::encode_all(&bytes, Options::default()).unwrap_err();
            assert_eq!(e.code(), ErrorCode::UnsupportedFormat, "{name}");
            assert!(e.to_string().contains("ignoreChunkSizes"), "{name}: {e}");
            let e = probe(&bytes).unwrap_err();
            assert_eq!(e.code(), ErrorCode::UnsupportedFormat, "{name} probe");
        }
    }
}

#[test]
fn ignore_chunk_sizes_matches_proper_header() {
    for (ch, bits) in [(1u16, 16u16), (2, 24), (2, 16)] {
        let s = signal(Signal::Noise, u32::from(bits), usize::from(ch), 1000, 3);
        let good = wav2flac::encode_all(
            &WavBuilder::pcm(ch, 8000, bits).build(&s),
            Options::default(),
        )
        .unwrap();
        for (name, riff, data) in placeholders(u32::from(ch) * u32::from(bits) / 8) {
            let mut b = WavBuilder::pcm(ch, 8000, bits);
            b.riff_len_override = Some(riff);
            b.data_len_override = Some(data);
            let flac = wav2flac::encode_all(&b.build(&s), ignoring())
                .unwrap_or_else(|e| panic!("{name} {ch}ch {bits}b: {e}"));
            assert_eq!(flac, good, "{name} {ch}ch {bits}b");
        }
    }
}

#[test]
fn ignore_chunk_sizes_takes_any_wrong_size() {
    // RIFF size 0 and data size 0 with audio behind: both rejected otherwise.
    let s = signal(Signal::Noise, 16, 1, 500, 3);
    let good =
        wav2flac::encode_all(&WavBuilder::pcm(1, 8000, 16).build(&s), Options::default()).unwrap();
    let mut b = WavBuilder::pcm(1, 8000, 16);
    b.riff_len_override = Some(0);
    b.data_len_override = Some(0);
    assert_eq!(
        wav2flac::encode_all(&b.build(&s), ignoring()).unwrap(),
        good
    );
}

#[test]
fn incremental_encoder_with_ignore_chunk_sizes() {
    let s = signal(Signal::Noise, 16, 2, 1000, 3);
    let good =
        wav2flac::encode_all(&WavBuilder::pcm(2, 8000, 16).build(&s), Options::default()).unwrap();
    let mut b = WavBuilder::pcm(2, 8000, 16);
    b.data_len_override = Some(0x7fff_f000);
    let bytes = b.build(&s);
    assert_eq!(encode_chunked(&bytes, ignoring(), &[7]).unwrap(), good);
}
