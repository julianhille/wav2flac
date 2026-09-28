// SPDX-License-Identifier: 0BSD
//! Misuse of the encoder state machine never panics and reports ENCODER_STATE.
mod common;
use common::*;
use wav2flac::{Encoder, ErrorCode, Options};

#[test]
fn push_after_finish() {
    let mut e = Encoder::new(Options::default()).unwrap();
    e.push(&wav(1, 8000, 16, &[1, 2, 3])).unwrap();
    e.finish().unwrap();
    assert_eq!(e.push(&[0]).unwrap_err().code(), ErrorCode::EncoderState);
    // A misuse after a successful finish keeps saying "finished", it does not
    // turn the encoder into one that "failed earlier".
    for _ in 0..2 {
        let err = e.finish().unwrap_err();
        assert_eq!(err.code(), ErrorCode::EncoderState);
        assert!(err.message().contains("already finished"), "{err}");
    }
}

#[test]
fn finish_before_header_is_truncated_then_unusable() {
    let mut e = Encoder::new(Options::default()).unwrap();
    e.push(b"RIFF").unwrap();
    assert_eq!(e.finish().unwrap_err().code(), ErrorCode::Truncated);
    assert_eq!(e.push(&[0]).unwrap_err().code(), ErrorCode::EncoderState);
}

#[test]
fn finish_without_any_input() {
    let mut e = Encoder::new(Options::default()).unwrap();
    assert_eq!(e.finish().unwrap_err().code(), ErrorCode::Truncated);
}

#[test]
fn error_poisons_encoder() {
    let mut e = Encoder::new(Options::default()).unwrap();
    assert_eq!(
        e.push(b"OggS....").unwrap_err().code(),
        ErrorCode::InvalidWav
    );
    assert_eq!(
        e.push(&wav(1, 8000, 16, &[1])).unwrap_err().code(),
        ErrorCode::EncoderState
    );
    assert_eq!(e.finish().unwrap_err().code(), ErrorCode::EncoderState);
}

#[test]
fn memory_released_after_finish_and_error() {
    let mut e = Encoder::new(Options::default()).unwrap();
    e.push(&wav(2, 8000, 16, &signal(Signal::Noise, 16, 2, 1000, 1)))
        .unwrap();
    e.finish().unwrap();
    assert_eq!(e.buffered_len(), 0);
    let mut e = Encoder::new(Options::default()).unwrap();
    e.push(b"RIFF\x10\0\0\0WAVEjunk").unwrap();
    let _ = e.finish();
    assert_eq!(e.buffered_len(), 0);
}

#[test]
fn max_input_bytes_limit() {
    let w = wav(1, 8000, 16, &signal(Signal::Noise, 16, 1, 1000, 1));
    let mut e = Encoder::new(Options {
        max_input_bytes: Some(100),
        ..Options::default()
    })
    .unwrap();
    assert_eq!(e.push(&w).unwrap_err().code(), ErrorCode::LimitExceeded);
    let mut e = Encoder::new(Options {
        max_input_bytes: Some(w.len() as u64),
        ..Options::default()
    })
    .unwrap();
    e.push(&w).unwrap();
    e.finish().unwrap();
}

#[test]
fn progress_reports_fraction() {
    let s = signal(Signal::Noise, 16, 2, 10_000, 1);
    let w = wav(2, 8000, 16, &s);
    let mut e = Encoder::new(Options::default()).unwrap();
    assert_eq!(e.progress().fraction, None);
    let half = 44 + (w.len() - 44) / 2;
    e.push(&w[..half]).unwrap();
    let p = e.progress();
    let f = p.fraction.unwrap();
    assert!((f - 0.5).abs() < 0.01, "{f}");
    assert_eq!(p.bytes_in, half as u64);
    e.push(&w[half..]).unwrap();
    assert_eq!(e.progress().fraction, Some(1.0));
    let info = e.info().unwrap();
    assert_eq!(info.frames, 10_000);
    assert_eq!(info.channels, 2);
    e.finish().unwrap();
    let p = e.progress();
    assert_eq!(p.fraction, Some(1.0));
    assert_eq!(p.samples_out, 10_000);
    assert_eq!(p.bytes_in, w.len() as u64);
}

#[test]
fn probe_and_output_spec() {
    let s = signal(Signal::Noise, 16, 2, 1000, 1);
    let w = wav(2, 8000, 16, &s);
    let info = wav2flac::probe(&w[..44]).unwrap();
    assert_eq!(
        (info.sample_rate, info.channels, info.frames),
        (8000, 2, 1000)
    );
    assert_eq!(
        wav2flac::probe(&w[..43]).unwrap_err().code(),
        ErrorCode::Truncated
    );
    assert_eq!(
        wav2flac::probe(b"RIFX\x24\0\0\0WAVE").unwrap_err().code(),
        ErrorCode::UnsupportedFormat
    );
    let mut e = Encoder::new(Options {
        sample_rate: Some(16000),
        bits_per_sample: Some(24),
        ..Options::default()
    })
    .unwrap();
    assert_eq!(e.output_spec(), None);
    e.push(&w[..44]).unwrap();
    let spec = e.output_spec().unwrap();
    assert_eq!((spec.sample_rate, spec.bits), (16000, 24));
    e.push(&w[44..]).unwrap();
    e.finish().unwrap();
    assert_eq!(e.output_spec(), None, "released after finish");
}
