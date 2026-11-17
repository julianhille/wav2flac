// SPDX-License-Identifier: 0BSD
//! Misuse of the encoder state machine never panics and reports ENCODER_STATE.
mod common;
use common::*;
use wav2flac::{Encoder, ErrorCode, Options, OutputMode, PcmFormat, PcmSpec};

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

/// Pushes `input` into `new(opts)` with `maxInputBytes: max` and finishes, once
/// per split (piece sizes repeat); returns the outcome of each split.
fn split_outcomes(
    input: &[u8],
    opts: &Options,
    max: usize,
    new: impl Fn(Options) -> wav2flac::Result<Encoder>,
) -> Vec<Result<(), ErrorCode>> {
    let splits: [&[usize]; 8] = [
        &[usize::MAX],
        &[1],
        &[7],
        &[44, usize::MAX],
        &[100, usize::MAX],
        &[max - 1, usize::MAX],
        &[max, usize::MAX],
        &[max + 1, usize::MAX],
    ];
    let opts = Options {
        max_input_bytes: Some(max as u64),
        ..opts.clone()
    };
    splits
        .iter()
        .map(|sizes| {
            let mut e = new(opts.clone()).unwrap();
            let mut pos = 0;
            for &n in sizes.iter().cycle() {
                if pos == input.len() {
                    break;
                }
                let n = n.clamp(1, input.len() - pos);
                e.push(&input[pos..pos + n]).map_err(|e| e.code())?;
                pos += n;
            }
            e.finish().map(drop).map_err(|e| e.code())
        })
        .collect()
}

fn wav_outcomes(f: &[u8], max: usize) -> Vec<Result<(), ErrorCode>> {
    split_outcomes(f, &Options::default(), max, Encoder::new)
}

#[test]
fn max_input_bytes_same_result_for_every_split() {
    let w = wav(1, 8000, 16, &signal(Signal::Noise, 16, 1, 1000, 1));
    assert_eq!(w.len(), 2044);
    assert_eq!(wav_outcomes(&w, 2044), [Ok(()); 8]);
    assert_eq!(wav_outcomes(&w, 2043), [Err(ErrorCode::LimitExceeded); 8]);
    assert_eq!(wav_outcomes(&w, 100), [Err(ErrorCode::LimitExceeded); 8]);
}

#[test]
fn max_input_bytes_error_in_allowed_bytes_wins() {
    // An MP3-in-WAV header is rejected within its 44 bytes.
    let mut b = WavBuilder::pcm(1, 8000, 16);
    b.format_tag = 0x55;
    let f = b.build_raw(&[0; 200]);
    assert_eq!(f.len(), 244);
    assert_eq!(
        wav_outcomes(&f, 100),
        [Err(ErrorCode::UnsupportedFormat); 8]
    );
    assert_eq!(wav_outcomes(&f, 44), [Err(ErrorCode::UnsupportedFormat); 8]);

    // 20-in-24-bit with a padding bit set in sample 1, the file bytes 71..74.
    let b = WavBuilder::pcm(1, 8000, 24).extensible(24, 20, 0x4);
    let mut data = vec![0; 600];
    data[3] = 1;
    let f = b.build_raw(&data);
    assert_eq!(f.len(), 668);
    assert_eq!(wav_outcomes(&f, 658), [Err(ErrorCode::InvalidWav); 8]);
    assert_eq!(wav_outcomes(&f, 74), [Err(ErrorCode::InvalidWav); 8]);
    assert_eq!(wav_outcomes(&f, 73), [Err(ErrorCode::LimitExceeded); 8]);
}

#[test]
fn max_input_bytes_raw_pcm() {
    // 64 bytes of streaming raw PCM, whose header is emitted with the first
    // push, followed by 8 bytes past the declared length.
    let spec = PcmSpec {
        format: PcmFormat::S16,
        channels: 1,
        sample_rate: 8000,
    };
    let opts = Options {
        mode: OutputMode::Streaming,
        ..Options::default()
    };
    let outcomes = |input: &[u8], max| {
        split_outcomes(input, &opts, max, |o| Encoder::new_pcm(o, spec, Some(64)))
    };
    let raw = [0; 72];
    assert_eq!(outcomes(&raw[..64], 64), [Ok(()); 8]);
    assert_eq!(outcomes(&raw, 64), [Err(ErrorCode::LimitExceeded); 8]);
    assert_eq!(outcomes(&raw, 65), [Err(ErrorCode::InvalidOptions); 8]);
    assert_eq!(outcomes(&raw, 68), [Err(ErrorCode::InvalidOptions); 8]);
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
