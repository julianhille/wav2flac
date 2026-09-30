// SPDX-License-Identifier: 0BSD
//! Golden hashes: detects any unintended change in encoder output (e.g. from a
//! dependency bump). Regenerate with `UPDATE_GOLDEN=1 cargo test --test golden`.
mod common;
use common::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use wav2flac::{Dither, Encoder, Options, OutputMode, PcmFormat, PcmSpec};

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
    // No resampling cases: native resampled output depends on the CPU (rubato's SIMD dot
    // product) and libm, by up to 1 LSB. tests/unit/api.test.ts pins the wasm's instead.
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
    // Raw PCM input: integer passthrough and float conversion.
    let s16 = signal(Signal::Sine, 16, 2, 20_000, 1);
    let raw16: Vec<u8> = s16.iter().flat_map(|v| (*v as i16).to_le_bytes()).collect();
    let f32s = sine_f64(1000.0, 48000, 2, 20_000, 0.8);
    let rawf: Vec<u8> = f32s
        .iter()
        .flat_map(|v| (*v as f32).to_le_bytes())
        .collect();
    for (name, raw, format, o) in [
        ("pcm-s16", raw16, PcmFormat::S16, Options::default()),
        (
            "pcm-f32-dither16",
            rawf,
            PcmFormat::F32,
            Options {
                bits_per_sample: Some(16),
                dither_seed: 42,
                ..Options::default()
            },
        ),
    ] {
        let spec = PcmSpec {
            format,
            channels: 2,
            sample_rate: 48000,
        };
        let mut enc = Encoder::new_pcm(o, spec, Some(raw.len() as u64)).expect("pcm encoder");
        let mut body = enc.push(&raw).expect("push");
        let fin = enc.finish().expect("finish");
        let mut out = fin.header;
        out.append(&mut body);
        out.extend_from_slice(&fin.tail);
        v.push((name.to_string(), out));
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

/// Replaces the crate version in the vendor string with `X`, so a version bump does not change
/// every hash. Fixes the vendor length and the `VORBIS_COMMENT` block length that precede it.
fn normalize(out: &[u8]) -> Vec<u8> {
    let version = concat!("wav2flac ", env!("CARGO_PKG_VERSION"), " (").as_bytes();
    let Some(p) = out.windows(version.len()).position(|w| w == version) else {
        return out.to_vec();
    };
    let shrink = env!("CARGO_PKG_VERSION").len() - 1;
    let vendor_len = u32::from_le_bytes(out[p - 4..p].try_into().unwrap()) - shrink as u32;
    let block = &out[p - 7..p - 4];
    let block_len = u32::from_be_bytes([0, block[0], block[1], block[2]]) - shrink as u32;
    let mut v = out[..p - 7].to_vec();
    v.extend_from_slice(&block_len.to_be_bytes()[1..]);
    v.extend_from_slice(&vendor_len.to_le_bytes());
    v.extend_from_slice(b"wav2flac X (");
    v.extend_from_slice(&out[p + version.len()..]);
    v
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
        .map(|(k, out)| (k, hex(&Sha256::digest(normalize(&out)))))
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
    assert!(
        diffs.is_empty() && expected.len() == actual.len(),
        "encoder output changed for {diffs:?}; \
         if intended, rerun with UPDATE_GOLDEN=1 and note it in CHANGELOG"
    );
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
