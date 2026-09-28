// SPDX-License-Identifier: 0BSD
//! Differential tests against independent implementations: ffmpeg/ffprobe
//! (always in CI) and the reference `flac` CLI (libFLAC) when installed.
mod common;
use common::*;
use wav2flac::{Options, OutputMode};

#[test]
fn ffmpeg_decodes_to_the_source() {
    let mut cases = Vec::new();
    for bits in [8u16, 16, 24, 32] {
        for ch in 1u16..=8 {
            for sig in [Signal::Noise, Signal::Sine, Signal::Square] {
                cases.push((bits, ch, sig));
            }
        }
    }
    for (bits, ch, sig) in sample_matrix(&cases, 5) {
        let s = signal(
            sig,
            u32::from(bits),
            ch as usize,
            9_000,
            u64::from(bits) * 31 + u64::from(ch),
        );
        let flac = encode(&wav(ch, 48000, bits, &s), Options::default());
        let Some(pcm) = ffmpeg_pcm(&flac, u32::from(bits)) else {
            return;
        };
        assert!(pcm == s, "ffmpeg decode differs: {bits}b {ch}ch {sig:?}");
    }
}

#[test]
fn ffmpeg_decodes_odd_depths_and_stream_mode() {
    let s = signal(Signal::Noise, 16, 2, 7_000, 5);
    let w = wav(2, 44100, 16, &s);
    for bits in [17u32, 20, 22, 28] {
        let flac = encode(
            &w,
            Options {
                bits_per_sample: Some(bits),
                ..Options::default()
            },
        );
        let Some(pcm) = ffmpeg_pcm(&flac, bits) else {
            return;
        };
        let expect: Vec<i32> = s.iter().map(|v| v << (bits - 16)).collect();
        assert!(pcm == expect, "{bits}-bit");
    }
    let flac = encode(
        &w,
        Options {
            mode: OutputMode::Streaming,
            ..Options::default()
        },
    );
    assert_eq!(ffmpeg_pcm(&flac, 16).unwrap(), s);
}

fn ffprobe(flac: &[u8], entries: &str) -> Option<String> {
    let out = ffmpeg(
        "ffprobe",
        flac,
        "flac",
        &[
            "-v",
            "error",
            "-show_entries",
            entries,
            "-of",
            "default=nw=1",
        ],
    )?;
    Some(String::from_utf8(out).unwrap())
}

#[test]
fn ffprobe_sees_channel_layout_and_duration() {
    // (channels, mask, expected ffprobe layout)
    for (ch, mask, layout) in [
        (2u16, 0x3u32, "stereo"),
        (5, 0x37, "5.0"),
        (6, 0x3F, "5.1"),
        (2, 0x5, "2 channels (FL+FC)"),
        (6, 0x60F, "5.1(side)"),
        (8, 0x63F, "7.1"),
        (1, 0x4, "mono"),
    ] {
        let s = signal(Signal::Sine, 16, ch as usize, 4410, 1);
        let w = WavBuilder::pcm(ch, 44100, 16)
            .extensible(16, 16, mask)
            .build(&s);
        let flac = encode(&w, Options::default());
        let Some(p) = ffprobe(
            &flac,
            "stream=channel_layout,sample_rate,channels:stream=duration_ts",
        ) else {
            return;
        };
        assert!(
            p.contains(&format!("channel_layout={layout}\n")),
            "mask {mask:#x}: {p}"
        );
        assert!(p.contains("sample_rate=44100"));
        assert!(p.contains("duration_ts=4410"), "{p}");
    }
}

#[test]
fn ffprobe_sees_tags() {
    let s = signal(Signal::Sine, 16, 2, 1000, 1);
    let mut b = WavBuilder::pcm(2, 44100, 16);
    b.chunks_before = vec![(
        *b"LIST",
        info_list(&[(b"INAM", b"Song\0"), (b"IART", b"Artist\0")]),
    )];
    let w = b.build(&s);
    let flac = encode(&w, Options::default());
    let Some(p) = ffprobe(&flac, "format_tags=title,artist") else {
        return;
    };
    let p = p.to_ascii_lowercase(); // ffprobe keeps the Vorbis key case
    assert!(
        p.contains("tag:title=song") && p.contains("tag:artist=artist"),
        "{p}"
    );
}

/// Frame bytes (everything after the metadata blocks).
fn frames(flac: &[u8]) -> &[u8] {
    &flac[metadata_blocks(flac).1..]
}

#[test]
fn flac_cli_verifies_and_matches_libflac_frames() {
    if !have_tool("flac") {
        return;
    }
    let dir = std::env::temp_dir();
    for bits in [8u16, 16, 24] {
        for ch in [1u16, 2, 6] {
            let s = signal(Signal::Noise, u32::from(bits), ch as usize, 30_000, 9);
            // flac(1) needs WAVE_FORMAT_EXTENSIBLE for more than 2 channels.
            let w = if ch > 2 {
                let mask = wav2flac::metadata::flac_default_mask(ch);
                WavBuilder::pcm(ch, 44100, bits)
                    .extensible(bits, bits, mask)
                    .build(&s)
            } else {
                wav(ch, 44100, bits, &s)
            };
            let wp = dir.join(format!("w2f-diff-{}-{bits}-{ch}.wav", std::process::id()));
            std::fs::write(&wp, &w).unwrap();
            // Levels 1 and 4 use loose mid-side estimation, whose state spans
            // frames; we encode frames independently, so compare the others.
            for level in [0u8, 2, 3, 5, 6, 7, 8] {
                let ours = encode(
                    &w,
                    Options {
                        compression_level: level,
                        ..Options::default()
                    },
                );
                ffmpeg("flac", &ours, "flac", &["-t", "-s"]).unwrap();
                let fp = wp.with_extension(format!("l{level}.flac"));
                let st = std::process::Command::new("flac")
                    .args([
                        "-s",
                        "-f",
                        &format!("-{level}"),
                        "--no-padding",
                        "--no-seektable",
                        "-o",
                    ])
                    .arg(&fp)
                    .arg(&wp)
                    .output()
                    .unwrap();
                assert!(
                    st.status.success(),
                    "flac -{level} {bits}b {ch}ch: {}",
                    String::from_utf8_lossy(&st.stderr)
                );
                let reference = std::fs::read(&fp).unwrap();
                let _ = std::fs::remove_file(&fp);
                assert!(
                    frames(&ours) == frames(&reference),
                    "frames differ from flac -{level}: {bits}b {ch}ch"
                );
            }
            let _ = std::fs::remove_file(&wp);
        }
    }
}
