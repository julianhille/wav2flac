// SPDX-License-Identifier: 0BSD
//! Streaming mode: header first (unknown totals), identical frames, bounded memory.
mod common;
use common::*;
use wav2flac::{Encoder, Options, OutputMode};

fn streaming() -> Options {
    Options {
        mode: OutputMode::Streaming,
        ..Options::default()
    }
}

#[test]
fn header_has_unknown_totals_and_decodes() {
    let s = signal(Signal::Noise, 16, 2, 30_000, 1);
    let w = wav(2, 44100, 16, &s);
    let flac = encode_chunked(&w, streaming(), &[4096]).unwrap();
    let (blocks, _) = metadata_blocks(&flac);
    let si = &blocks[0].2;
    assert_eq!(&si[4..10], &[0; 6], "frame sizes unknown");
    assert_eq!(si[13] & 0x0F, 0, "total samples high nibble");
    assert_eq!(&si[14..18], &[0; 4], "total samples unknown");
    assert_eq!(&si[18..34], &[0; 16], "md5 unknown");
    assert!(
        blocks.iter().all(|b| b.0 != 3),
        "no seektable in streaming mode"
    );
    let d = decode(&flac);
    assert_eq!(d.samples, s);
}

#[test]
fn frames_identical_to_buffered_mode() {
    let s = signal(Signal::Sine, 24, 6, 25_000, 2);
    let w = wav(6, 48000, 24, &s);
    let buffered = encode(&w, Options::default());
    let streamed = encode_chunked(&w, streaming(), &[10_000]).unwrap();
    let (_, fb) = metadata_blocks(&buffered);
    let (_, fs) = metadata_blocks(&streamed);
    assert!(
        buffered[fb..] == streamed[fs..],
        "frame bytes differ between modes"
    );
}

#[test]
fn header_emitted_on_first_push_after_header() {
    let s = signal(Signal::Noise, 16, 1, 10, 1);
    let w = wav(1, 8000, 16, &s);
    let mut e = Encoder::new(streaming()).unwrap();
    assert!(e.push(&w[..20]).unwrap().is_empty());
    let out = e.push(&w[20..]).unwrap();
    assert_eq!(&out[..4], b"fLaC");
}

#[test]
fn internal_buffer_is_bounded() {
    // Feed ~40 MB of audio in 64 KiB pieces; the encoder must never hold more
    // than about one block plus one push.
    for mode in [OutputMode::Streaming, OutputMode::Buffered] {
        let frames = if tier() >= Tier::Full {
            10_000_000
        } else {
            1_000_000
        };
        let s = signal(Signal::Sine, 16, 2, frames, 1);
        let w = wav(2, 44100, 16, &s);
        let mut e = Encoder::new(Options {
            mode,
            ..Options::default()
        })
        .unwrap();
        let mut max = 0;
        for c in w.chunks(65536) {
            e.push(c).unwrap();
            max = max.max(e.buffered_len());
        }
        e.finish().unwrap();
        assert!(max < 128 * 1024, "{mode:?}: buffered {max} bytes");
    }
}

#[test]
fn seek_index_does_not_grow_per_frame() {
    // Tiny blocks: one frame per 16 samples. Only the chosen seek points are
    // kept, not an index entry per frame.
    let s = signal(Signal::Sine, 16, 1, 1_000_000, 1);
    let w = wav(1, 8000, 16, &s);
    let mut e = Encoder::new(Options {
        block_size: Some(16),
        seek_point_interval: 10.0,
        ..Options::default()
    })
    .unwrap();
    let mut max = 0;
    for c in w.chunks(65536) {
        e.push(c).unwrap();
        max = max.max(e.buffered_len());
    }
    e.finish().unwrap();
    assert!(max < 64 * 1024, "buffered {max} bytes");
}
