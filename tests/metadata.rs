// SPDX-License-Identifier: 0BSD
//! Channel masks, Vorbis comments, seek tables and padding.
mod common;
use common::*;
use wav2flac::metadata::{flac_default_mask, CHANNEL_MASK_TAG};
use wav2flac::{Options, Tags};

fn tag<'a>(d: &'a Decoded, k: &str) -> Option<&'a str> {
    d.tags
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(k))
        .map(|(_, v)| v.as_str())
}

#[test]
fn channel_mask_tag_only_when_needed() {
    for ch in 1u16..=8 {
        let s = signal(Signal::Noise, 16, usize::from(ch), 500, 1);
        let def = flac_default_mask(ch);
        let d = decode(&encode(
            &WavBuilder::pcm(ch, 48000, 16)
                .extensible(16, 16, def)
                .build(&s),
            Options::default(),
        ));
        // 5.0/5.1 are stated explicitly: ffmpeg assumes side surrounds otherwise.
        let expect = matches!(ch, 5 | 6).then(|| format!("0x{def:04X}"));
        assert_eq!(
            tag(&d, CHANNEL_MASK_TAG),
            expect.as_deref(),
            "{ch}ch default"
        );
        // Plain PCM (no mask in the WAV) never gets a tag.
        let d = decode(&encode(&wav(ch, 48000, 16, &s), Options::default()));
        assert_eq!(tag(&d, CHANNEL_MASK_TAG), None, "{ch}ch plain");
        // A different mask with the same speaker count: shift the lowest bit up.
        let odd = (def & !(def & def.wrapping_neg())) | 0x4_0000;
        let d = decode(&encode(
            &WavBuilder::pcm(ch, 48000, 16)
                .extensible(16, 16, odd)
                .build(&s),
            Options::default(),
        ));
        assert_eq!(
            tag(&d, CHANNEL_MASK_TAG),
            Some(format!("0x{odd:04X}").as_str()),
            "{ch}ch custom"
        );
    }
}

#[test]
fn channel_mask_kept_with_tags_disabled() {
    let s = signal(Signal::Noise, 16, 2, 100, 1);
    let w = WavBuilder::pcm(2, 48000, 16)
        .extensible(16, 16, 0x5)
        .build(&s);
    let d = decode(&encode(
        &w,
        Options {
            tags: Tags::Disabled,
            ..Options::default()
        },
    ));
    assert_eq!(d.tags.len(), 1);
    assert_eq!(tag(&d, CHANNEL_MASK_TAG), Some("0x0005"));
    // No mask needed + disabled -> no VORBIS_COMMENT block at all.
    let flac = encode(
        &wav(2, 48000, 16, &s),
        Options {
            tags: Tags::Disabled,
            ..Options::default()
        },
    );
    assert!(metadata_blocks(&flac).0.iter().all(|b| b.0 != 4));
}

#[test]
fn info_tags_utf8_latin1_and_overrides() {
    let s = signal(Signal::Noise, 16, 2, 100, 1);
    let mut b = WavBuilder::pcm(2, 44100, 16);
    b.chunks_before = vec![(
        *b"LIST",
        info_list(&[
            (b"INAM", "Grüße".as_bytes()),
            (b"IART", &[0x4D, 0xFC, 0x6C, 0x6C, 0]),
            (b"ICRD", b"2026"),
            (b"XXXX", b"ignored"),
        ]),
    )];
    b.chunks_after = vec![(*b"LIST", info_list(&[(b"ICMT", b"trailing comment")]))];
    let w = b.build(&s);
    let d = decode(&encode(&w, Options::default()));
    assert_eq!(tag(&d, "TITLE"), Some("Grüße"));
    assert_eq!(tag(&d, "ARTIST"), Some("Müll"));
    assert_eq!(tag(&d, "DATE"), Some("2026"));
    assert_eq!(
        tag(&d, "COMMENT"),
        Some("trailing comment"),
        "tags after data in buffered mode"
    );
    let o = Options {
        tags: Tags::FromWav(vec![
            ("title".into(), "New".into()),
            ("DATE".into(), String::new()),
            ("ALBUM".into(), "X".into()),
        ]),
        ..Options::default()
    };
    let d = decode(&encode(&w, o));
    assert_eq!(tag(&d, "TITLE"), Some("New"));
    assert_eq!(tag(&d, "DATE"), None);
    assert_eq!(tag(&d, "ALBUM"), Some("X"));
}

#[test]
fn vendor_string() {
    let flac = encode(&wav(1, 8000, 16, &[0; 10]), Options::default());
    let (blocks, _) = metadata_blocks(&flac);
    let vc = blocks.iter().find(|b| b.0 == 4).unwrap();
    let (vendor, _) = parse_vorbis(&vc.2);
    assert!(vendor.starts_with("wav2flac "), "{vendor}");
}

#[test]
fn seek_points_point_at_frames() {
    let rate = 8000;
    let s = signal(Signal::Noise, 16, 2, rate as usize * 95, 1); // 95 s
    let flac = encode(
        &wav(2, rate, 16, &s),
        Options {
            seek_point_interval: 10.0,
            ..Options::default()
        },
    );
    let pts = seek_points(&flac);
    assert_eq!(pts.len(), 10, "{pts:?}");
    let (_, first_frame) = metadata_blocks(&flac);
    for (i, (sample, offset, n)) in pts.iter().enumerate() {
        assert!(*sample <= i as u64 * 10 * u64::from(rate));
        assert!(i as u64 * 10 * u64::from(rate) - sample < 4096);
        let p = first_frame + *offset as usize;
        assert_eq!(flac[p], 0xFF, "seek point {i} not at a frame sync");
        assert_eq!(flac[p + 1] & 0xFE, 0xF8);
        assert_eq!(*n, 4096);
        // Decoding from the seek point reproduces the right samples.
        let r = libflac_rs::decode_seek(&flac, *sample).expect("seek");
        assert_eq!(
            r.interleaved[..20],
            s[*sample as usize * 2..*sample as usize * 2 + 20]
        );
    }
    let none = encode(
        &wav(2, rate, 16, &s[..20000]),
        Options {
            seek_point_interval: 0.0,
            ..Options::default()
        },
    );
    assert!(seek_points(&none).is_empty());
    // An interval below one sample still writes a point per frame.
    let tiny = encode(
        &wav(2, rate, 16, &s[..20000]),
        Options {
            seek_point_interval: 1e-9,
            block_size: Some(4096),
            ..Options::default()
        },
    );
    assert_eq!(seek_points(&tiny).len(), 10000usize.div_ceil(4096));
}

#[test]
fn seek_points_count_output_samples_when_resampling() {
    let s = signal(Signal::Noise, 16, 1, 48_000 * 25, 4); // 25 s at 48 kHz
    let flac = encode(
        &wav(1, 48_000, 16, &s),
        Options {
            sample_rate: Some(16_000),
            seek_point_interval: 5.0,
            ..Options::default()
        },
    );
    let full = decode(&flac);
    let pts = seek_points(&flac);
    assert_eq!(pts.len(), 5, "{pts:?}");
    let (_, first_frame) = metadata_blocks(&flac);
    for (i, (sample, offset, _)) in pts.iter().enumerate() {
        let target = i as u64 * 5 * 16_000;
        assert!(*sample <= target && target - sample < 4096, "{i}: {sample}");
        let p = first_frame + *offset as usize;
        assert_eq!(flac[p], 0xFF, "seek point {i} not at a frame sync");
        let r = libflac_rs::decode_seek(&flac, *sample).expect("seek");
        let at = *sample as usize;
        assert_eq!(r.interleaved[..20], full.samples[at..at + 20]);
    }
}

#[test]
fn last_block_flag_in_all_combinations() {
    let s = signal(Signal::Noise, 16, 1, 100_000, 1);
    let w = wav(1, 8000, 16, &s);
    for tags in [Tags::Disabled, Tags::default()] {
        for seek in [0.0, 1.0] {
            for padding in [0, 10] {
                let flac = encode(
                    &w,
                    Options {
                        tags: tags.clone(),
                        seek_point_interval: seek,
                        padding,
                        ..Options::default()
                    },
                );
                let (blocks, _) = metadata_blocks(&flac);
                let lasts: Vec<bool> = blocks.iter().map(|b| b.1).collect();
                assert_eq!(lasts.iter().filter(|l| **l).count(), 1);
                assert!(*lasts.last().unwrap());
                decode(&flac);
            }
        }
    }
}

fn tag_count(d: &Decoded, k: &str) -> usize {
    d.tags.iter().filter(|(key, _)| key == k).count()
}

#[test]
fn info_tags_all_ids_and_limits() {
    let s = signal(Signal::Noise, 16, 1, 100, 1);
    let with_list = |body: Vec<u8>| {
        let mut b = WavBuilder::pcm(1, 8000, 16);
        b.chunks_before = vec![(*b"LIST", body)];
        decode(&encode(&b.build(&s), Options::default()))
    };
    let ids: [(&[u8; 4], &str); 12] = [
        (b"INAM", "TITLE"),
        (b"IART", "ARTIST"),
        (b"IPRD", "ALBUM"),
        (b"ICRD", "DATE"),
        (b"IGNR", "GENRE"),
        (b"ICMT", "COMMENT"),
        (b"ITRK", "TRACKNUMBER"),
        (b"IPRT", "TRACKNUMBER"),
        (b"ICOP", "COPYRIGHT"),
        (b"ISFT", "ENCODER"),
        (b"IENG", "ENGINEER"),
        (b"ISRC", "SOURCE"),
    ];
    let entries: Vec<(&[u8; 4], &[u8])> = ids.iter().map(|(id, _)| (*id, &b"v"[..])).collect();
    let d = with_list(info_list(&entries));
    for (id, key) in ids {
        assert!(tag(&d, key).is_some(), "{}", String::from_utf8_lossy(id));
    }
    assert_eq!(tag_count(&d, "TRACKNUMBER"), 2);

    // Only INFO lists carry tags.
    let mut adtl = info_list(&[(b"INAM", b"x")]);
    adtl[..4].copy_from_slice(b"adtl");
    assert_eq!(with_list(adtl).tags.len(), 0);

    // A sub-chunk running past the list ends parsing; earlier tags stay.
    let mut cut = info_list(&[(b"INAM", b"kept"), (b"IART", b"lost")]);
    let n = cut.len();
    cut[n - 8..n - 4].copy_from_slice(&100u32.to_le_bytes());
    let d = with_list(cut);
    assert_eq!((tag(&d, "TITLE"), tag(&d, "ARTIST")), (Some("kept"), None));

    // At most 1024 tags and 1 MiB of text are kept.
    let many = vec![(b"INAM", &b"x"[..]); 1100];
    assert_eq!(tag_count(&with_list(info_list(&many)), "TITLE"), 1024);
    let big = vec![b'y'; 400 * 1024];
    let d = with_list(info_list(&[
        (b"INAM", &big),
        (b"IART", &big),
        (b"ICMT", &big),
    ]));
    assert_eq!(d.tags.len(), 2);
    assert_eq!(tag(&d, "COMMENT"), None);
}

#[test]
fn oversized_tags_fail_early() {
    use wav2flac::{encoder::VENDOR, Encoder, ErrorCode, OutputMode};
    const MAX: usize = (1 << 24) - 1;
    let with_value = |value: String| Options {
        tags: Tags::FromWav(vec![("COMMENT".into(), value)]),
        ..Options::default()
    };
    // The body is: vendor length, vendor, count, then length + "COMMENT=value".
    let fixed = 4 + VENDOR.len() + 4 + 4 + "COMMENT=".len();
    for mode in [OutputMode::Buffered, OutputMode::Streaming] {
        let o = Options {
            mode,
            ..with_value("v".repeat(MAX - fixed + 1))
        };
        let e = Encoder::new(o).err().expect("rejected before any input");
        assert_eq!(e.code(), ErrorCode::InvalidOptions, "{mode:?}");
    }
    // Removals and disabled tags do not count.
    Encoder::new(Options {
        tags: Tags::FromWav(vec![("COMMENT".into(), String::new())]),
        ..Options::default()
    })
    .unwrap();

    // Exactly at the limit is fine; WAV tags that push it over fail at finish.
    let s = signal(Signal::Noise, 16, 1, 100, 1);
    let at_limit = with_value("v".repeat(MAX - fixed));
    let flac = encode(&wav(1, 8000, 16, &s), at_limit.clone());
    let (blocks, _) = metadata_blocks(&flac);
    assert_eq!(blocks.iter().find(|b| b.0 == 4).unwrap().2.len(), MAX);
    let mut b = WavBuilder::pcm(1, 8000, 16);
    b.chunks_before = vec![(*b"LIST", info_list(&[(b"INAM", b"title")]))];
    let err = wav2flac::encode_all(&b.build(&s), at_limit).unwrap_err();
    assert_eq!(err.code(), ErrorCode::InvalidOptions);
}
