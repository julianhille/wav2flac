// SPDX-License-Identifier: 0BSD
//! Golden hashes: detects any unintended change in encoder output (e.g. from a
//! dependency bump). Regenerate with `UPDATE_GOLDEN=1 cargo test --test golden`.
mod common;
use common::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use wav2flac::{Dither, Options, OutputMode, ResampleQuality};

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden.json");

fn cases() -> Vec<(String, Vec<u8>)> {
    let mut v = Vec::new();
    for bits in [8u16, 16, 24, 32] {
        for ch in [1u16, 2, 6] {
            for level in [0u8, 1, 4, 5, 8] {
                // A tone with a little noise: white noise alone compresses the
                // same at every level, which would hide a preset change.
                let s = mixed(u32::from(bits), ch as usize, 10_000);
                let o = Options {
                    compression_level: level,
                    ..Options::default()
                };
                v.push((
                    format!("sine-{bits}b-{ch}ch-l{level}"),
                    encode(&wav(ch, 44100, bits, &s), o),
                ));
            }
        }
    }
    let s = signal(Signal::Sine, 24, 2, 20_000, 1);
    let w = wav(2, 96000, 24, &s);
    for (name, o) in [
        (
            "stream",
            Options {
                mode: OutputMode::Streaming,
                ..Options::default()
            },
        ),
        (
            "resample-fast",
            Options {
                sample_rate: Some(44100),
                resample_quality: ResampleQuality::Fast,
                ..Options::default()
            },
        ),
        (
            "resample-best",
            Options {
                sample_rate: Some(48000),
                resample_quality: ResampleQuality::Best,
                ..Options::default()
            },
        ),
        (
            "dither16",
            Options {
                bits_per_sample: Some(16),
                dither_seed: 42,
                ..Options::default()
            },
        ),
        (
            "nodither12",
            Options {
                bits_per_sample: Some(12),
                dither: Dither::None,
                ..Options::default()
            },
        ),
        (
            "block192",
            Options {
                block_size: Some(192),
                ..Options::default()
            },
        ),
    ] {
        v.push((name.to_string(), encode(&w, o)));
    }
    v
}

/// Sine plus noise at 1/16 of full scale.
fn mixed(bits: u32, ch: usize, frames: usize) -> Vec<i32> {
    let tone = signal(Signal::Sine, bits, ch, frames, 7);
    let noise = signal(Signal::Noise, bits, ch, frames, 7);
    let max = (1i64 << (bits - 1)) - 1;
    tone.iter()
        .zip(&noise)
        .map(|(t, n)| (i64::from(*t) + i64::from(*n) / 16).clamp(-max - 1, max) as i32)
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Minimal parser for our flat `{"name": "hash", ...}` file (no serde dep).
fn load() -> BTreeMap<String, String> {
    let Ok(text) = std::fs::read_to_string(PATH) else {
        return BTreeMap::new();
    };
    text.split('"')
        .collect::<Vec<_>>()
        .chunks(4)
        .filter(|c| c.len() >= 4)
        .map(|c| (c[1].to_string(), c[3].to_string()))
        .collect()
}

#[test]
fn golden_hashes() {
    let actual: BTreeMap<String, String> = cases()
        .into_iter()
        .map(|(k, out)| (k, hex(&Sha256::digest(&out))))
        .collect();
    if std::env::var("UPDATE_GOLDEN").as_deref() == Ok("1") {
        let body: Vec<String> = actual
            .iter()
            .map(|(k, v)| format!("  \"{k}\": \"{v}\""))
            .collect();
        std::fs::write(PATH, format!("{{\n{}\n}}\n", body.join(",\n"))).unwrap();
        // Fall through: the file just written must read back as what was hashed.
    }
    let expected = load();
    assert!(
        !expected.is_empty(),
        "tests/golden.json missing; run with UPDATE_GOLDEN=1"
    );
    let mut diffs = Vec::new();
    for (k, v) in &actual {
        if expected.get(k) != Some(v) {
            diffs.push(k.clone());
        }
    }
    assert!(diffs.is_empty() && expected.len() == actual.len(),
        "encoder output changed for {diffs:?}; if intended, rerun with UPDATE_GOLDEN=1 and note it in CHANGELOG");
}

#[test]
fn levels_differ() {
    // The level sweep must be able to detect a preset change.
    let hashes: BTreeMap<String, String> = cases()
        .into_iter()
        .filter(|(k, _)| k.starts_with("sine-16b-2ch-"))
        .map(|(k, out)| (k, hex(&Sha256::digest(&out))))
        .collect();
    assert_ne!(hashes["sine-16b-2ch-l0"], hashes["sine-16b-2ch-l5"]);
    assert_ne!(hashes["sine-16b-2ch-l5"], hashes["sine-16b-2ch-l8"]);
}
