// SPDX-License-Identifier: 0BSD
//! The stateful resampler and the chunk encoder (issue #37): output that does
//! not depend on how the input is split, matches one whole-signal `encode()`
//! and leaves no seams between files.
mod common;
use common::*;
use proptest::prelude::*;
use wav2flac::{
    encode_all, ChunkEncoder, Dither, ErrorCode, Options, ResampleQuality, StreamResampler,
};

const QUALITIES: [ResampleQuality; 3] = [
    ResampleQuality::Fast,
    ResampleQuality::Balanced,
    ResampleQuality::Best,
];
const RATES: [u32; 5] = [8000, 22050, 44100, 48000, 96000];

/// 16-bit quantization as `encode()` does it with `dither: none`: round to
/// nearest, saturating.
fn to_s16(x: f64) -> i32 {
    (x * 32768.0).round().clamp(-32768.0, 32767.0) as i32
}

/// Two tones plus noise at about half full scale, interleaved.
fn test_signal(rate: u32, channels: usize, frames: usize, seed: u64) -> Vec<f32> {
    let mut rng = Rng(seed);
    let mut out = Vec::with_capacity(frames * channels);
    for n in 0..frames {
        let t = n as f64 / f64::from(rate);
        let tone = 0.3 * (std::f64::consts::TAU * 440.0 * t).sin()
            + 0.15 * (std::f64::consts::TAU * 1370.0 * t).sin();
        for c in 0..channels {
            let noise = (rng.below(1 << 20) as f64 / f64::from(1 << 20) - 0.5) * 0.1;
            out.push((tone * (1.0 - 0.2 * c as f64) + noise) as f32);
        }
    }
    out
}

/// One `encode()` of the whole signal, decoded.
fn whole_encode(input: &[f32], rate: u32, channels: u16, opts: Options) -> Decoded {
    let f64s: Vec<f64> = input.iter().map(|&v| f64::from(v)).collect();
    let wav = WavBuilder::pcm(channels, rate, 32)
        .float32()
        .build_raw(&WavBuilder::pack_f32(&f64s));
    decode(&encode_all(&wav, opts).unwrap())
}

fn opts_16k(q: ResampleQuality) -> Options {
    Options {
        sample_rate: Some(16000),
        resample_quality: q,
        bits_per_sample: Some(16),
        dither: Dither::None,
        ..Options::default()
    }
}

/// Resamples `input` pushed in pieces of the given sizes (cycled).
fn resample_split(
    input: &[f32],
    from: u32,
    to: u32,
    channels: u16,
    q: ResampleQuality,
    sizes: &[usize],
) -> Vec<f64> {
    let mut r = StreamResampler::new(from, to, channels, q).unwrap();
    let mut out = Vec::new();
    let mut at = 0;
    for &n in sizes.iter().cycle() {
        if at >= input.len() {
            break;
        }
        let end = (at + n).min(input.len());
        r.push(&input[at..end], |s| out.extend_from_slice(s))
            .unwrap();
        at = end;
    }
    r.flush(|s| out.extend_from_slice(s)).unwrap();
    out
}

fn bits(v: &[f64]) -> Vec<u64> {
    v.iter().map(|x| x.to_bits()).collect()
}

// ------------------------------------------------- rule 1: split-invariant ---

#[test]
fn fixed_splits_give_identical_output() {
    let input = test_signal(48000, 1, 48000, 1);
    for q in QUALITIES {
        let one = resample_split(&input, 48000, 16000, 1, q, &[input.len()]);
        for sizes in [&[1][..], &[128], &[0, 7, 1, 1023, 1024, 1025], &[4096, 3]] {
            let got = resample_split(&input, 48000, 16000, 1, q, sizes);
            assert_eq!(bits(&got), bits(&one), "{q:?} split {sizes:?}");
        }
    }
}

#[test]
fn stereo_split_inside_a_frame_is_carried_over() {
    let input = test_signal(44100, 2, 20000, 2);
    let one = resample_split(
        &input,
        44100,
        16000,
        2,
        ResampleQuality::Fast,
        &[input.len()],
    );
    let odd = resample_split(&input, 44100, 16000, 2, ResampleQuality::Fast, &[1, 3, 127]);
    assert_eq!(bits(&odd), bits(&one));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(match tier() {
        Tier::Quick => 24,
        Tier::Full => 256,
        Tier::Soak => 2_000,
    }))]

    #[test]
    fn random_splits_give_identical_output(
        sizes in prop::collection::vec(0usize..3000, 1..40),
        rate in prop::sample::select(RATES.to_vec()),
        q in prop::sample::select(QUALITIES.to_vec()),
        frames in 0usize..30_000,
        seed in any::<u64>(),
    ) {
        prop_assume!(sizes.iter().any(|&n| n > 0));
        let input = test_signal(rate, 1, frames, seed);
        let one = resample_split(&input, rate, 16000, 1, q, &[input.len().max(1)]);
        let got = resample_split(&input, rate, 16000, 1, q, &sizes);
        prop_assert_eq!(bits(&got), bits(&one));
    }
}

// ---------------------------------------- rules 2 and 3: same as encode() ---

#[test]
fn s16_output_matches_encode_bit_for_bit() {
    let secs = if tier() >= Tier::Full { 5 } else { 2 };
    for q in QUALITIES {
        for rate in RATES {
            let input = test_signal(rate, 1, rate as usize * secs, u64::from(rate));
            let whole = whole_encode(&input, rate, 1, opts_16k(q));
            let out = resample_split(&input, rate, 16000, 1, q, &[128]);
            let s16: Vec<i32> = out.iter().map(|&x| to_s16(x)).collect();
            assert_eq!(s16.len(), whole.samples.len(), "{q:?} {rate} Hz: length");
            assert_eq!(whole.total_samples, Some(s16.len() as u64));
            assert!(s16 == whole.samples, "{q:?} {rate} Hz: samples differ");
        }
    }
}

#[test]
fn f32_output_is_within_one_lsb_of_encode() {
    let (mut off, mut total) = (0usize, 0usize);
    for q in QUALITIES {
        for rate in RATES {
            let input = test_signal(rate, 1, rate as usize * 2, u64::from(rate) + 7);
            let whole = whole_encode(&input, rate, 1, opts_16k(q));
            let out = resample_split(&input, rate, 16000, 1, q, &[128]);
            // What a caller does with f32 output: encode it at 16 kHz.
            let rounded: Vec<f64> = out.iter().map(|&v| f64::from(v as f32)).collect();
            let s16: Vec<i32> = rounded.iter().map(|&x| to_s16(x)).collect();
            assert_eq!(s16.len(), whole.samples.len());
            for (a, b) in s16.iter().zip(&whole.samples) {
                let d = (a - b).abs();
                assert!(d <= 1, "{q:?} {rate} Hz: {d} LSB");
                off += usize::from(d > 0);
            }
            total += s16.len();
        }
    }
    eprintln!("f32 output: {off} of {total} samples differ by 1 LSB");
}

#[test]
fn length_is_exact() {
    for rate in [44100, 48000] {
        let input = test_signal(rate, 1, rate as usize * 5, 3);
        let out = resample_split(&input, rate, 16000, 1, ResampleQuality::Fast, &[128]);
        assert_eq!(out.len(), 80000, "{rate} Hz");
    }
    for (frames, from, to, want) in [
        (0, 48000, 16000, 0),
        (1, 48000, 16000, 1),
        (4, 48000, 16000, 2),
    ] {
        let input = test_signal(from, 1, frames, 4);
        let out = resample_split(&input, from, to, 1, ResampleQuality::Fast, &[1]);
        assert_eq!(out.len(), want, "{frames} frames");
    }
}

#[test]
fn equal_rates_pass_through() {
    let mut input = test_signal(16000, 2, 1000, 5);
    let mut r = StreamResampler::new(16000, 16000, 2, ResampleQuality::Best).unwrap();
    let mut out = Vec::new();
    r.push(&input[..3], |s| out.extend_from_slice(s)).unwrap();
    r.push(&input[3..], |s| out.extend_from_slice(s)).unwrap();
    r.flush(|s| out.extend_from_slice(s)).unwrap();
    let want: Vec<f64> = input.iter().map(|&v| f64::from(v)).collect();
    assert_eq!(bits(&out), bits(&want));
    // Non-finite samples are cleaned up as in encode().
    input[0] = f32::NAN;
    input[1] = f32::INFINITY;
    input[2] = f32::NEG_INFINITY;
    let mut r = StreamResampler::new(16000, 16000, 1, ResampleQuality::Best).unwrap();
    let mut out = Vec::new();
    r.push(&input[..3], |s| out.extend_from_slice(s)).unwrap();
    assert_eq!(out, [0.0, 1.0, -1.0]);
}

// ----------------------------------------------------------- state, errors ---

#[test]
fn calls_after_flush_fail() {
    let mut r = StreamResampler::new(48000, 16000, 1, ResampleQuality::Fast).unwrap();
    r.flush(|_| {}).unwrap();
    let e = r.push(&[0.0], |_| {}).unwrap_err();
    assert_eq!(e.code(), ErrorCode::EncoderState);
    assert_eq!(r.flush(|_| {}).unwrap_err().code(), ErrorCode::EncoderState);
}

#[test]
fn input_ending_inside_a_frame_fails_as_in_encode() {
    for rate in [16000, 48000] {
        let mut r = StreamResampler::new(rate, 16000, 2, ResampleQuality::Fast).unwrap();
        r.push(&[0.1, 0.2, 0.3], |_| {}).unwrap();
        let e = r.flush(|_| {}).unwrap_err();
        assert_eq!(e.code(), ErrorCode::InvalidOptions, "{e}");
        assert_eq!(
            r.push(&[0.0], |_| {}).unwrap_err().code(),
            ErrorCode::EncoderState
        );
        let opts = opts_16k(ResampleQuality::Fast);
        let mut enc = ChunkEncoder::new(rate, 2, opts, None).unwrap();
        enc.push(&[0.1, 0.2, 0.3]).unwrap();
        let e = enc.finish().unwrap_err();
        assert_eq!(e.code(), ErrorCode::InvalidOptions, "{e}");
    }
}

#[test]
fn bad_settings_are_rejected() {
    let q = ResampleQuality::Fast;
    let code = |r: wav2flac::Result<StreamResampler>| r.err().map(|e| e.code());
    assert_eq!(
        code(StreamResampler::new(0, 16000, 1, q)),
        Some(ErrorCode::InvalidOptions)
    );
    assert_eq!(
        code(StreamResampler::new(48000, 0, 1, q)),
        Some(ErrorCode::InvalidOptions)
    );
    assert_eq!(
        code(StreamResampler::new(48000, 1 << 20, 1, q)),
        Some(ErrorCode::InvalidOptions)
    );
    // As in `encode()`, only the output rate is limited to what FLAC stores.
    assert!(StreamResampler::new(1 << 21, 16000, 1, q).is_ok());
    assert_eq!(
        code(StreamResampler::new(48000, 16000, 0, q)),
        Some(ErrorCode::InvalidOptions)
    );
    assert_eq!(
        code(StreamResampler::new(48000, 16000, 9, q)),
        Some(ErrorCode::TooManyChannels)
    );
    assert_eq!(
        code(StreamResampler::new(100, 25700, 1, q)),
        Some(ErrorCode::UnsupportedFormat)
    );
    assert_eq!(
        code(StreamResampler::new(1 << 17, 1, 1, q)),
        Some(ErrorCode::UnsupportedFormat)
    );
}

// The documented lag: up to 1024 input frames plus half the filter.
#[test]
fn output_lags_the_input_by_at_most_about_1300_input_frames() {
    for rate in [44100, 48000] {
        for q in QUALITIES {
            let input = test_signal(rate, 1, rate as usize * 2, 11);
            let mut r = StreamResampler::new(rate, 16000, 1, q).unwrap();
            let (mut fed, mut out) = (0, 0);
            for piece in input.chunks(128) {
                r.push(piece, |s| out += s.len()).unwrap();
                fed += piece.len();
                let lag = fed as f64 * 16000.0 / f64::from(rate) - out as f64;
                assert!(
                    lag <= 1300.0 * 16000.0 / f64::from(rate),
                    "{q:?} {rate} Hz: {lag} output frames behind after {fed}"
                );
            }
        }
    }
}

// --------------------------------------------------- chunk encoder, rule 4 ---

/// Decodes every file, checks each is standalone, and joins the samples.
fn join(files: &[Vec<u8>], rate: u32, channels: u32, bits: u32) -> Vec<i32> {
    let mut all = Vec::new();
    for f in files {
        let d = decode(f);
        assert_eq!((d.sample_rate, d.channels, d.bits), (rate, channels, bits));
        assert_eq!(
            d.total_samples,
            Some((d.samples.len() / channels as usize) as u64)
        );
        assert!(!d.samples.is_empty(), "empty file");
        assert_ne!(d.md5, [0; 16], "no MD5, so the decoders skip the check");
        all.extend(d.samples);
    }
    all
}

/// Feeds `input` in 128-frame pushes and cuts after every `cut_every` pushes.
fn chunked(
    input: &[f32],
    rate: u32,
    channels: u16,
    opts: Options,
    chunk: Option<usize>,
    cut_every: usize,
) -> Vec<Vec<u8>> {
    let mut enc = ChunkEncoder::new(rate, channels, opts, chunk).unwrap();
    let mut files = Vec::new();
    for (i, piece) in input.chunks(128 * usize::from(channels)).enumerate() {
        enc.push(piece).unwrap();
        if (i + 1) % cut_every == 0 {
            files.extend(enc.cut().unwrap());
        }
    }
    files.extend(enc.finish().unwrap());
    files
}

#[test]
fn varying_cuts_join_to_the_whole_encode() {
    for rate in [44100, 48000] {
        for q in QUALITIES {
            let input = test_signal(rate, 1, rate as usize * 12, 6);
            let whole = whole_encode(&input, rate, 1, opts_16k(q));
            // About every 5 s of input.
            let files = chunked(&input, rate, 1, opts_16k(q), None, rate as usize * 5 / 128);
            assert_eq!(files.len(), 3);
            assert!(
                join(&files, 16000, 1, 16) == whole.samples,
                "{q:?} {rate} Hz"
            );
        }
    }
}

#[test]
fn exact_cuts_have_exact_lengths_and_join_to_the_whole_encode() {
    for rate in [44100, 48000] {
        let input = test_signal(rate, 1, rate as usize * 12, 7);
        let opts = opts_16k(ResampleQuality::Fast);
        let whole = whole_encode(&input, rate, 1, opts.clone());
        let files = chunked(&input, rate, 1, opts, Some(80000), 1000);
        let lens: Vec<usize> = files.iter().map(|f| decode(f).samples.len()).collect();
        assert_eq!(lens, [80000, 80000, 32000], "{rate} Hz");
        assert!(join(&files, 16000, 1, 16) == whole.samples, "{rate} Hz");
    }
}

#[test]
fn dither_bit_depths_and_channels_carry_across_files() {
    for (bits, channels, dither) in [
        (16, 2, Dither::Tpdf),
        (24, 1, Dither::Tpdf),
        (12, 2, Dither::None),
        (20, 1, Dither::Tpdf),
        (32, 1, Dither::None),
        (8, 1, Dither::Tpdf),
    ] {
        let opts = Options {
            sample_rate: Some(16000),
            resample_quality: ResampleQuality::Balanced,
            bits_per_sample: Some(bits),
            dither,
            dither_seed: 42,
            ..Options::default()
        };
        let input = test_signal(48000, usize::from(channels), 48000 * 3, 8);
        let whole = whole_encode(&input, 48000, channels, opts.clone());
        for chunk in [None, Some(7777)] {
            let files = chunked(&input, 48000, channels, opts.clone(), chunk, 50);
            let joined = join(&files, 16000, u32::from(channels), bits);
            assert!(
                joined == whole.samples,
                "{bits} bit, {channels} ch, {chunk:?}"
            );
        }
    }
}

#[test]
fn without_resampling_cuts_still_join_exactly() {
    let opts = Options {
        bits_per_sample: Some(16),
        ..Options::default()
    };
    let input = test_signal(16000, 1, 16000 * 3, 9);
    let whole = whole_encode(&input, 16000, 1, opts.clone());
    let files = chunked(&input, 16000, 1, opts, Some(16000), 7);
    assert_eq!(files.len(), 3);
    assert!(join(&files, 16000, 1, 16) == whole.samples);
}

#[test]
fn chunk_encoder_state_and_errors() {
    let opts = opts_16k(ResampleQuality::Fast);
    let new = |o: Options, chunk| {
        ChunkEncoder::new(48000, 1, o, chunk)
            .err()
            .map(|e| e.code())
    };
    assert_eq!(new(opts.clone(), Some(0)), Some(ErrorCode::InvalidOptions));
    let no_bits = Options {
        bits_per_sample: None,
        ..opts.clone()
    };
    assert_eq!(new(no_bits, None), Some(ErrorCode::UnsupportedFormat));
    let streaming = Options {
        mode: wav2flac::OutputMode::Streaming,
        ..opts.clone()
    };
    assert_eq!(new(streaming, None), Some(ErrorCode::InvalidOptions));
    let level = Options {
        compression_level: 9,
        ..opts.clone()
    };
    assert_eq!(new(level, None), Some(ErrorCode::InvalidOptions));

    let mut enc = ChunkEncoder::new(48000, 1, opts, Some(100)).unwrap();
    // Nothing pending yet: no file in either mode.
    assert!(enc.cut().unwrap().is_empty());
    enc.push(&test_signal(48000, 1, 4800, 10)).unwrap();
    let files = enc.cut().unwrap();
    assert!(files.len() < 16, "output lags the input");
    assert!(files.iter().all(|f| decode(f).samples.len() == 100));
    let last = enc.finish().unwrap();
    assert_eq!(enc.cut().unwrap_err().code(), ErrorCode::EncoderState);
    assert_eq!(
        enc.push(&[0.0]).unwrap_err().code(),
        ErrorCode::EncoderState
    );
    assert_eq!(enc.finish().unwrap_err().code(), ErrorCode::EncoderState);
    let total: usize = files
        .iter()
        .chain(&last)
        .map(|f| decode(f).samples.len())
        .sum();
    assert_eq!(total, 1600);

    // finish() returns the pending full files, then the shorter last one.
    let mut enc = ChunkEncoder::new(48000, 1, opts_16k(ResampleQuality::Fast), Some(100)).unwrap();
    for piece in test_signal(48000, 1, 4900, 12).chunks(128) {
        enc.push(piece).unwrap();
    }
    let files = enc.finish().unwrap();
    let lens: Vec<usize> = files.iter().map(|f| decode(f).samples.len()).collect();
    let mut want = vec![100; 16];
    want.push(34);
    assert_eq!(lens, want);
    join(&files, 16000, 1, 16);

    // Finishing with nothing pushed gives no file.
    let mut enc = ChunkEncoder::new(48000, 1, opts_16k(ResampleQuality::Fast), None).unwrap();
    assert!(enc.finish().unwrap().is_empty());
}
