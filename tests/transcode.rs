// SPDX-License-Identifier: 0BSD
//! Resampling and bit-depth conversion: measured quality instead of bit-exactness.
mod common;
use common::*;
use wav2flac::{encode_all, Dither, ErrorCode, Options, ResampleQuality};

/// Amplitude of `freq` in `x` (single-bin DFT / Goertzel), relative to full scale.
fn tone_amplitude(x: &[f64], freq: f64, rate: f64) -> f64 {
    let w = std::f64::consts::TAU * freq / rate;
    let (mut re, mut im) = (0.0, 0.0);
    for (n, v) in x.iter().enumerate() {
        re += v * (w * n as f64).cos();
        im -= v * (w * n as f64).sin();
    }
    2.0 * (re * re + im * im).sqrt() / x.len() as f64
}

/// SNR (dB) of `x` against an ideal sine of `freq` fitted by least squares.
fn sine_snr(x: &[f64], freq: f64, rate: f64) -> f64 {
    let w = std::f64::consts::TAU * freq / rate;
    let (mut sc, mut ss, mut cc, mut xs, mut xc) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (n, v) in x.iter().enumerate() {
        let (s, c) = (w * n as f64).sin_cos();
        ss += s * s;
        cc += c * c;
        sc += s * c;
        xs += v * s;
        xc += v * c;
    }
    let det = ss * cc - sc * sc;
    let a = (xs * cc - xc * sc) / det;
    let b = (xc * ss - xs * sc) / det;
    let (mut sig, mut err) = (0.0, 0.0);
    for (n, v) in x.iter().enumerate() {
        let (s, c) = (w * n as f64).sin_cos();
        let fit = a * s + b * c;
        sig += fit * fit;
        err += (v - fit) * (v - fit);
    }
    10.0 * (sig / err.max(1e-300)).log10()
}

fn float_wav(samples: &[f64], channels: u16, rate: u32) -> Vec<u8> {
    WavBuilder::pcm(channels, rate, 32)
        .float32()
        .build_raw(&WavBuilder::pack_f32(samples))
}

/// Decoded channel 0 as normalized floats.
fn channel0(d: &Decoded) -> Vec<f64> {
    let scale = f64::from(1u32 << (d.bits - 1));
    d.samples
        .iter()
        .step_by(d.channels as usize)
        .map(|v| f64::from(*v) / scale)
        .collect()
}

#[test]
fn output_length_is_exact() {
    for (from, to) in [
        (48000u32, 44100u32),
        (44100, 48000),
        (96000, 48000),
        (8000, 22050),
        (192000, 44100),
        (22050, 8000),
    ] {
        // 44100 frames at 44.1k -> 48k is exactly 48000; float math gave 48001.
        for frames in [0usize, 1, 999, 44100, 48000] {
            let s = signal(Signal::Sine, 16, 2, frames, 1);
            let d = decode(&encode(
                &wav(2, from, 16, &s),
                Options {
                    sample_rate: Some(to),
                    ..Options::default()
                },
            ));
            let expected = (frames as u64 * u64::from(to)).div_ceil(u64::from(from));
            assert_eq!(d.sample_rate, to);
            assert_eq!(
                d.total_samples.unwrap_or(0),
                expected,
                "{from}->{to} {frames}"
            );
            assert_eq!(d.samples.len() as u64, expected * 2);
        }
    }
}

#[test]
fn sine_is_preserved_with_high_snr() {
    let pairs = [
        (48000u32, 44100u32),
        (44100, 48000),
        (96000, 44100),
        (44100, 96000),
        (88200, 48000),
        (22050, 44100),
    ];
    for (from, to) in sample_matrix(&pairs, 2) {
        let x = sine_f64(997.0, from, 1, from as usize, 0.5);
        for (bits, min_snr) in [(24u32, 110.0), (16, 85.0)] {
            // 16-bit TPDF ceiling at -6 dBFS: 87.3 dB
            let o = Options {
                sample_rate: Some(to),
                bits_per_sample: Some(bits),
                ..Options::default()
            };
            let d = decode(&encode(&float_wav(&x, 1, from), o));
            let y = channel0(&d);
            let mid = &y[y.len() / 4..3 * y.len() / 4]; // ignore filter edges
            let snr = sine_snr(mid, 997.0, f64::from(to));
            assert!(
                snr >= min_snr,
                "{from}->{to} @{bits}bit: SNR {snr:.1} dB < {min_snr}"
            );
            let amp = tone_amplitude(mid, 997.0, f64::from(to));
            assert!((amp - 0.5).abs() < 0.001, "amplitude {amp}");
        }
    }
}

#[test]
fn tones_above_new_nyquist_are_removed() {
    // 30 kHz tone at 96 kHz resampled to 44.1 kHz must vanish (alias would be at 14.1 kHz).
    let x = sine_f64(30_000.0, 96000, 1, 96000, 0.9);
    for (q, min_db) in [
        (ResampleQuality::Fast, 60.0),
        (ResampleQuality::Balanced, 90.0),
        (ResampleQuality::Best, 110.0),
    ] {
        let o = Options {
            sample_rate: Some(44100),
            bits_per_sample: Some(24),
            resample_quality: q,
            dither: Dither::None,
            ..Options::default()
        };
        let y = channel0(&decode(&encode(&float_wav(&x, 1, 96000), o)));
        let mid = &y[y.len() / 4..3 * y.len() / 4];
        let alias = tone_amplitude(mid, 44100.0 - 30_000.0, 44100.0);
        let db = -20.0 * (alias / 0.9).max(1e-12).log10();
        assert!(db >= min_db, "{q:?}: alias only {db:.1} dB down");
    }
}

#[test]
fn full_scale_does_not_wrap_and_dc_is_kept() {
    let x: Vec<f64> = (0..48000)
        .map(|i| if (i / 100) % 2 == 0 { 1.0 } else { -1.0 })
        .collect();
    let o = Options {
        sample_rate: Some(44100),
        bits_per_sample: Some(16),
        ..Options::default()
    };
    let y = decode(&encode(&float_wav(&x, 1, 48000), o)).samples;
    // Overshoot (Gibbs) must saturate, never wrap around to the opposite sign:
    // away from the edges every plateau sample has the plateau's sign.
    for (j, v) in y.iter().enumerate() {
        let t = j as f64 * 48000.0 / 44100.0;
        let edge = (t / 100.0).round() * 100.0;
        if (t - edge).abs() > 10.0 && t < 47_900.0 {
            let positive = (t as usize / 100).is_multiple_of(2);
            assert_eq!(*v > 0, positive, "wraparound at output sample {j}: {v}");
        }
    }
    assert_eq!(y.iter().max(), Some(&32767), "overshoot should saturate");
    let dc = vec![0.25f64; 48000];
    let o = Options {
        sample_rate: Some(32000),
        bits_per_sample: Some(24),
        dither: Dither::None,
        ..Options::default()
    };
    let y = channel0(&decode(&encode(&float_wav(&dc, 1, 48000), o)));
    let mid = &y[1000..y.len() - 1000];
    assert!(
        mid.iter().all(|v| (v - 0.25).abs() < 1e-5),
        "DC not preserved"
    );
}

#[test]
fn float_over_range_saturates() {
    let x = vec![3.0, -3.0, f64::from(f32::INFINITY), 0.5];
    let d = decode(&encode(
        &float_wav(&x, 1, 8000),
        Options {
            bits_per_sample: Some(16),
            dither: Dither::None,
            ..Options::default()
        },
    ));
    assert_eq!(d.samples, vec![32767, -32768, 32767, 16384]);
}

#[test]
fn non_finite_floats_stay_local_when_resampling() {
    // One NaN and one infinity must not turn the whole filtered signal into
    // NaN (silence) or full-scale noise.
    let mut x = sine_f64(1000.0, 48000, 1, 48000, 0.5);
    x[10_000] = f64::from(f32::NAN);
    x[30_000] = f64::from(f32::NEG_INFINITY);
    let o = Options {
        bits_per_sample: Some(16),
        sample_rate: Some(44100),
        dither: Dither::None,
        ..Options::default()
    };
    let y = channel0(&decode(&encode(&float_wav(&x, 1, 48000), o)));
    // A NaN inside the filter would zero every output it touches (a gap of
    // the filter's length) and an infinity would clip as many.
    let zeros = y.windows(4).filter(|w| w.iter().all(|&v| v == 0.0)).count();
    let loud = y.iter().filter(|v| v.abs() > 0.99).count();
    assert!(
        zeros == 0 && loud < 8,
        "{zeros} silent runs, {loud} clipped samples"
    );
}

#[test]
fn bit_depth_reduction_and_dither() {
    let s = signal(Signal::Sine, 24, 2, 20000, 1);
    let w = wav(2, 44100, 24, &s);
    // No dither: exact rounding of v / 256.
    let d = decode(&encode(
        &w,
        Options {
            bits_per_sample: Some(16),
            dither: Dither::None,
            ..Options::default()
        },
    ));
    let expect: Vec<i32> = s
        .iter()
        .map(|v| ((f64::from(*v) / 256.0).round() as i32).clamp(-32768, 32767))
        .collect();
    assert_eq!(d.samples, expect);
    // TPDF: deterministic per seed, different across seeds, error bounded by ~1.5 LSB.
    let run = |seed| {
        decode(&encode(
            &w,
            Options {
                bits_per_sample: Some(16),
                dither_seed: seed,
                ..Options::default()
            },
        ))
        .samples
    };
    let (a, b, c) = (run(1), run(1), run(2));
    assert_eq!(a, b);
    assert_ne!(a, c);
    for (q, v) in a.iter().zip(&s) {
        assert!((f64::from(*q) - f64::from(*v) / 256.0).abs() <= 1.5);
    }
    // Dither noise floor: error variance ~ 1/12 (rounding) + 1/6 (TPDF) = 0.25 LSB².
    let var: f64 = a
        .iter()
        .zip(&s)
        .map(|(q, v)| (f64::from(*q) - f64::from(*v) / 256.0).powi(2))
        .sum::<f64>()
        / a.len() as f64;
    assert!((0.18..0.32).contains(&var), "dither error variance {var}");
}

#[test]
fn bit_depth_increase_is_exact_shift() {
    let s = signal(Signal::Noise, 16, 2, 5000, 1);
    let d = decode(&encode(
        &wav(2, 44100, 16, &s),
        Options {
            bits_per_sample: Some(24),
            ..Options::default()
        },
    ));
    assert_eq!(d.bits, 24);
    let expect: Vec<i32> = s.iter().map(|v| v << 8).collect();
    assert_eq!(d.samples, expect);
}

#[test]
fn thirty_two_bit_and_float_inputs() {
    // 32-bit int is lossless by default now (FLAC supports 32-bit).
    let s = signal(Signal::Noise, 32, 1, 3000, 1);
    let d = decode(&encode(&wav(1, 48000, 32, &s), Options::default()));
    assert_eq!(d.samples, s);
    // Float needs an explicit target depth.
    let f = float_wav(&[0.0, 0.5], 1, 8000);
    assert_eq!(
        encode_all(&f, Options::default()).unwrap_err().code(),
        ErrorCode::UnsupportedFormat
    );
    assert!(encode_all(
        &f,
        Options {
            bits_per_sample: Some(24),
            ..Options::default()
        }
    )
    .is_ok());
}

#[test]
fn resample_chunk_invariance() {
    let s = signal(Signal::Noise, 16, 2, 50_000, 3);
    let w = wav(2, 48000, 16, &s);
    let o = Options {
        sample_rate: Some(44100),
        ..Options::default()
    };
    let reference = encode(&w, o.clone());
    for sz in [1usize, 17, 4096, 100_000] {
        assert!(
            encode_chunked(&w, o.clone(), &[sz]).unwrap() == reference,
            "chunk {sz}"
        );
    }
}

#[test]
fn all_rate_pairs() {
    let rates = [8000u32, 22050, 44100, 48000, 88200, 96000, 192000];
    for &from in &rates {
        for to in sample_matrix(&rates, 3) {
            let s = signal(Signal::Sine, 16, 1, 4000, 1);
            let d = decode(&encode(
                &wav(1, from, 16, &s),
                Options {
                    sample_rate: Some(to),
                    ..Options::default()
                },
            ));
            assert_eq!(d.sample_rate, to);
        }
    }
}

#[test]
fn extreme_upsampling_is_rejected() {
    let s = signal(Signal::Sine, 16, 1, 16, 1);
    let opts = |rate| Options {
        sample_rate: Some(rate),
        ..Options::default()
    };
    let e = encode_all(&wav(1, 1, 16, &s), opts(48000)).unwrap_err();
    assert_eq!(e.code(), ErrorCode::InvalidOptions);
    assert!(encode_all(&wav(1, 1000, 16, &s), opts(256_000)).is_ok());
    let e = encode_all(&wav(1, 1000, 16, &s), opts(256_001)).unwrap_err();
    assert_eq!(e.code(), ErrorCode::InvalidOptions);
    // Downsampling is allowed up to 65536x.
    assert!(encode_all(&wav(1, 384_000, 16, &s), opts(6)).is_ok());
    let e = encode_all(&wav(1, 384_000, 16, &s), opts(5)).unwrap_err();
    assert_eq!(e.code(), ErrorCode::InvalidOptions);
    let e = encode_all(&wav(1, 1_048_575, 16, &s), opts(1)).unwrap_err();
    assert_eq!(e.code(), ErrorCode::InvalidOptions);
}

#[test]
fn large_downsampling_ratio_keeps_stop_band() {
    // 192 kHz → 16 kHz: a 12 kHz tone would alias to 4 kHz. The filter is
    // lengthened for large ratios, so the stop band holds like at 2:1.
    let x = sine_f64(12_000.0, 192_000, 1, 192_000, 0.9);
    for (q, min_db) in [
        (ResampleQuality::Fast, 60.0),
        (ResampleQuality::Balanced, 90.0),
        (ResampleQuality::Best, 110.0),
    ] {
        let o = Options {
            sample_rate: Some(16000),
            bits_per_sample: Some(24),
            resample_quality: q,
            dither: Dither::None,
            ..Options::default()
        };
        let y = channel0(&decode(&encode(&float_wav(&x, 1, 192_000), o)));
        let mid = &y[y.len() / 4..3 * y.len() / 4];
        let alias = tone_amplitude(mid, 4000.0, 16000.0);
        let db = -20.0 * (alias / 0.9).max(1e-12).log10();
        assert!(db >= min_db, "{q:?}: alias only {db:.1} dB down");
    }
}
