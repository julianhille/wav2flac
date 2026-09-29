// SPDX-License-Identifier: 0BSD
//! Raw PCM input (`Encoder::new_pcm`): the output must be byte-identical to
//! encoding the same samples wrapped in a plain WAV file.
mod common;
use common::*;
use wav2flac::{Encoder, ErrorCode, Options, OutputMode, PcmFormat, PcmSpec};

const FORMATS: [PcmFormat; 5] = [
    PcmFormat::U8,
    PcmFormat::S16,
    PcmFormat::S24,
    PcmFormat::S32,
    PcmFormat::F32,
];

/// Options needed to accept `format` (float needs a target depth).
fn opts_for(format: PcmFormat) -> Options {
    match format {
        PcmFormat::F32 => Options {
            bits_per_sample: Some(24),
            ..Options::default()
        },
        _ => Options::default(),
    }
}

/// Test samples as raw PCM bytes plus the equivalent WAV file.
fn fixture(
    format: PcmFormat,
    channels: u16,
    rate: u32,
    frames: usize,
    seed: u64,
) -> (Vec<u8>, Vec<u8>) {
    let ch = usize::from(channels);
    match format {
        PcmFormat::F32 => {
            let s: Vec<f64> = signal(Signal::Noise, 24, ch, frames, seed)
                .iter()
                .map(|v| f64::from(*v) / f64::from(1 << 23))
                .collect();
            let b = WavBuilder::pcm(channels, rate, 32).float32();
            let raw = WavBuilder::pack_f32(&s);
            (raw.clone(), b.build_raw(&raw))
        }
        f => {
            let bits = (f.bytes() * 8) as u16;
            let b = WavBuilder::pcm(channels, rate, bits);
            let raw = b.pack_int(&signal(Signal::Noise, u32::from(bits), ch, frames, seed));
            (raw.clone(), b.build_raw(&raw))
        }
    }
}

/// Encodes raw PCM, pushing `chunks` sizes cyclically.
fn encode_pcm(
    raw: &[u8],
    spec: PcmSpec,
    opts: Options,
    total: Option<u64>,
    chunks: &[usize],
) -> wav2flac::Result<Vec<u8>> {
    let mode = opts.mode;
    let mut enc = Encoder::new_pcm(opts, spec, total)?;
    let mut body = Vec::new();
    let mut pos = 0;
    let mut i = 0;
    while pos < raw.len() {
        let n = chunks[i % chunks.len()].max(1).min(raw.len() - pos);
        body.extend(enc.push(&raw[pos..pos + n])?);
        pos += n;
        i += 1;
    }
    let fin = enc.finish()?;
    Ok(match mode {
        OutputMode::Buffered => {
            let mut out = fin.header;
            out.extend(body);
            out.extend(fin.tail);
            out
        }
        OutputMode::Streaming => {
            body.extend(fin.tail);
            body
        }
    })
}

fn spec(format: PcmFormat, channels: u16, sample_rate: u32) -> PcmSpec {
    PcmSpec {
        format,
        channels,
        sample_rate,
    }
}

#[test]
fn pcm_equals_wav_across_formats_channels_rates_lengths() {
    let block = 4096;
    let lengths = sample_matrix(&[0usize, 1, block - 1, block, block + 1, 3 * block + 17], 2);
    let rates = sample_matrix(&[8000u32, 16000, 44100, 96000], 2);
    for format in FORMATS {
        for channels in 1..=8u16 {
            for &rate in &rates {
                for &frames in &lengths {
                    let (raw, wav) = fixture(
                        format,
                        channels,
                        rate,
                        frames,
                        u64::from(channels) * 31 + frames as u64,
                    );
                    let expected = encode(&wav, opts_for(format));
                    for total in [Some(raw.len() as u64), None] {
                        let got = encode_pcm(
                            &raw,
                            spec(format, channels, rate),
                            opts_for(format),
                            total,
                            &[raw.len().max(1)],
                        )
                        .unwrap();
                        assert!(
                            got == expected,
                            "{format:?} {channels}ch {rate} Hz {frames} frames total={total:?}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn chunk_splits_inside_samples_are_equivalent() {
    let mut rng = Rng(11);
    for format in FORMATS {
        let (raw, wav) = fixture(format, 3, 22050, 10_000, 5);
        let expected = encode(&wav, opts_for(format));
        for sz in [1usize, 2, 3, 5, 7, 4097] {
            let got =
                encode_pcm(&raw, spec(format, 3, 22050), opts_for(format), None, &[sz]).unwrap();
            assert!(got == expected, "{format:?} chunk {sz}");
        }
        for _ in 0..10 {
            let pattern: Vec<usize> = (0..1 + rng.below(6))
                .map(|_| 1 + rng.below(3000) as usize)
                .collect();
            let got = encode_pcm(
                &raw,
                spec(format, 3, 22050),
                opts_for(format),
                Some(raw.len() as u64),
                &pattern,
            )
            .unwrap();
            assert!(got == expected, "{format:?} pattern {pattern:?}");
        }
    }
}

#[test]
fn transcoding_matches_wav() {
    let (raw, wav) = fixture(PcmFormat::F32, 1, 48000, 30_000, 9);
    let opts = Options {
        sample_rate: Some(16000),
        bits_per_sample: Some(16),
        ..Options::default()
    };
    let expected = encode(&wav, opts.clone());
    let got = encode_pcm(&raw, spec(PcmFormat::F32, 1, 48000), opts, None, &[1000]).unwrap();
    assert!(got == expected);
}

#[test]
fn streaming_mode_emits_header_first_and_matches_wav() {
    let (raw, wav) = fixture(PcmFormat::S16, 2, 44100, 20_000, 3);
    let opts = Options {
        mode: OutputMode::Streaming,
        ..Options::default()
    };
    let expected = encode_chunked(&wav, opts.clone(), &[wav.len()]).unwrap();
    let mut enc = Encoder::new_pcm(opts.clone(), spec(PcmFormat::S16, 2, 44100), None).unwrap();
    let first = enc.push(&raw[..3]).unwrap();
    assert_eq!(&first[..4], b"fLaC", "header comes with the first push");
    let got = encode_pcm(
        &raw,
        spec(PcmFormat::S16, 2, 44100),
        opts.clone(),
        None,
        &[777],
    )
    .unwrap();
    assert!(got == expected);
    // Empty input still yields a valid header.
    let empty = encode_pcm(&[], spec(PcmFormat::S16, 2, 44100), opts, None, &[1]).unwrap();
    assert_eq!(&empty[..4], b"fLaC");
}

#[test]
fn decodes_to_the_input_samples() {
    let samples = signal(Signal::Sine, 16, 1, 80_000, 1);
    let b = WavBuilder::pcm(1, 16000, 16);
    let raw = b.pack_int(&samples);
    let flac = encode_pcm(
        &raw,
        spec(PcmFormat::S16, 1, 16000),
        Options::default(),
        None,
        &[4096],
    )
    .unwrap();
    let d = decode(&flac);
    assert_eq!((d.sample_rate, d.channels, d.bits), (16000, 1, 16));
    assert_eq!(d.total_samples, Some(80_000));
    assert_eq!(d.samples, samples);
    assert_eq!(d.md5, pcm_md5(&samples, 16));
}

#[test]
fn trailing_partial_frame_is_truncated() {
    let (raw, _) = fixture(PcmFormat::S24, 2, 48000, 100, 1);
    let e = encode_pcm(
        &raw[..raw.len() - 1],
        spec(PcmFormat::S24, 2, 48000),
        Options::default(),
        None,
        &[64],
    )
    .unwrap_err();
    assert_eq!(e.code(), ErrorCode::Truncated);
}

#[test]
fn known_length_mismatches_are_rejected() {
    let (raw, _) = fixture(PcmFormat::S16, 2, 48000, 100, 1);
    let s = spec(PcmFormat::S16, 2, 48000);
    // Not a whole number of frames.
    let e = Encoder::new_pcm(Options::default(), s, Some(3))
        .err()
        .unwrap();
    assert_eq!(e.code(), ErrorCode::InvalidOptions);
    // Fewer bytes than declared.
    let e = encode_pcm(
        &raw,
        s,
        Options::default(),
        Some(raw.len() as u64 + 4),
        &[50],
    )
    .unwrap_err();
    assert_eq!(e.code(), ErrorCode::Truncated);
    // More bytes than declared.
    let e = encode_pcm(
        &raw,
        s,
        Options::default(),
        Some(raw.len() as u64 - 4),
        &[50],
    )
    .unwrap_err();
    assert_eq!(e.code(), ErrorCode::InvalidOptions);
}

#[test]
fn invalid_specs_are_rejected() {
    let cases = [
        (spec(PcmFormat::S16, 0, 44100), ErrorCode::InvalidOptions),
        (spec(PcmFormat::S16, 2, 0), ErrorCode::InvalidOptions),
        (spec(PcmFormat::S16, 9, 44100), ErrorCode::TooManyChannels),
        (
            spec(PcmFormat::S16, 2, 1_048_576),
            ErrorCode::InvalidOptions,
        ),
    ];
    for (s, code) in cases {
        let e = Encoder::new_pcm(Options::default(), s, None).err().unwrap();
        assert_eq!(e.code(), code, "{s:?}");
    }
    // The largest rate STREAMINFO can hold.
    let s = spec(PcmFormat::S16, 2, 1_048_575);
    assert!(Encoder::new_pcm(Options::default(), s, None).is_ok());
    // A higher rate is fine when it is resampled.
    let o = Options {
        sample_rate: Some(48000),
        ..Options::default()
    };
    assert!(Encoder::new_pcm(o, spec(PcmFormat::S16, 2, 2_000_000), None).is_ok());
}

#[test]
fn float_needs_a_target_depth_like_wav() {
    let e = Encoder::new_pcm(Options::default(), spec(PcmFormat::F32, 1, 16000), None)
        .err()
        .unwrap();
    let wav_err = wav2flac::encode_all(
        &fixture(PcmFormat::F32, 1, 16000, 10, 1).1,
        Options::default(),
    )
    .unwrap_err();
    assert_eq!(e.code(), wav_err.code());
}

#[test]
fn s32_is_lossless_passthrough() {
    let (raw, wav) = fixture(PcmFormat::S32, 2, 48000, 5000, 4);
    let got = encode_pcm(
        &raw,
        spec(PcmFormat::S32, 2, 48000),
        Options::default(),
        None,
        &[999],
    )
    .unwrap();
    assert!(got == encode(&wav, Options::default()));
    assert_eq!(decode(&got).bits, 32);
}

#[test]
fn progress_fraction_depends_on_known_length() {
    let (raw, _) = fixture(PcmFormat::S16, 1, 16000, 1000, 1);
    let s = spec(PcmFormat::S16, 1, 16000);
    let mut known = Encoder::new_pcm(Options::default(), s, Some(raw.len() as u64)).unwrap();
    known.push(&raw[..raw.len() / 2]).unwrap();
    assert_eq!(known.progress().fraction, Some(0.5));
    let mut unknown = Encoder::new_pcm(Options::default(), s, None).unwrap();
    unknown.push(&raw).unwrap();
    assert_eq!(unknown.progress().fraction, None);
    assert_eq!(unknown.info().unwrap().sample_rate, 16000);
}

#[test]
fn info_reports_lengths_beyond_4_gib() {
    // Raw PCM is not limited by the 32-bit WAV data size.
    let total = 5u64 << 30; // 5 GiB of 16-bit stereo
    let enc = Encoder::new_pcm(
        Options::default(),
        spec(PcmFormat::S16, 2, 48000),
        Some(total),
    )
    .unwrap();
    let info = enc.info().unwrap();
    assert_eq!(info.frames, total / 4);
    assert_eq!(info.duration_sec, (total / 4) as f64 / 48000.0);
    let unknown =
        Encoder::new_pcm(Options::default(), spec(PcmFormat::S16, 2, 48000), None).unwrap();
    assert_eq!(unknown.info().unwrap().frames, 0);
}
