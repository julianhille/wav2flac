// SPDX-License-Identifier: 0BSD
//! Real-world WAV layouts: WAVE_FORMAT_EXTENSIBLE, fmt sizes, extra chunks,
//! odd chunk sizes, trailing data, sub-container bit depths.
mod common;
use common::*;
use wav2flac::Options;

fn check(b: &WavBuilder, samples: &[i32], bits: u32) {
    let flac = encode(&b.build(samples), Options::default());
    let d = decode(&flac);
    assert_eq!(d.bits, bits);
    // Depths libflac-rs cannot decode come back empty when ffmpeg is missing
    // (see `decode`); the MD5 check below still covers them.
    if !d.samples.is_empty() || samples.is_empty() {
        assert_eq!(d.samples, samples);
    }
    assert_eq!(d.md5, pcm_md5(samples, bits));
}

#[test]
fn extensible_default_masks() {
    for ch in 1u16..=8 {
        let mask = wav2flac::metadata::flac_default_mask(ch);
        let s = signal(Signal::Noise, 24, usize::from(ch), 3000, 1);
        let b = WavBuilder::pcm(ch, 48000, 24).extensible(24, 24, mask);
        check(&b, &s, 24);
    }
}

#[test]
fn extensible_sub_container_bits() {
    // 20-in-24 and 24-in-32 left-justified, 12-in-16.
    for (container, valid) in [
        (24u16, 20u16),
        (32, 24),
        (16, 12),
        (32, 20),
        (32, 32),
        (24, 18),
        (16, 10),
    ] {
        let s = signal(Signal::Noise, u32::from(valid), 2, 3000, 7);
        let b = WavBuilder::pcm(2, 44100, container).extensible(container, valid, 0x3);
        check(&b, &s, u32::from(valid));
    }
}

#[test]
fn extensible_nonzero_padding_bits_rejected() {
    let b = WavBuilder::pcm(1, 44100, 24).extensible(24, 20, 0x4);
    let mut data = b.pack_int(&[1, 2, 3]);
    data[0] |= 1; // corrupt a padding bit
    let e = wav2flac::encode_all(&b.build_raw(&data), Options::default()).unwrap_err();
    assert_eq!(e.code(), wav2flac::ErrorCode::InvalidWav);
}

#[test]
fn fmt_sizes_16_18_40() {
    let s = signal(Signal::Sine, 16, 2, 2000, 1);
    for size in [16u32, 18, 40] {
        let mut b = WavBuilder::pcm(2, 44100, 16);
        b.fmt_size = Some(size);
        check(&b, &s, 16);
    }
}

#[test]
fn extra_chunks_before_and_after_data() {
    let s = signal(Signal::Noise, 16, 2, 2000, 3);
    let mut b = WavBuilder::pcm(2, 44100, 16);
    b.chunks_before = vec![
        (*b"JUNK", vec![0; 28]),
        (*b"bext", vec![1; 602]),
        (*b"odd ", vec![9; 7]), // odd size -> pad byte
        (*b"fact", 2000u32.to_le_bytes().to_vec()),
    ];
    b.chunks_after = vec![(*b"cue ", vec![0; 28]), (*b"id3 ", vec![3; 11])];
    check(&b, &s, 16);
}

#[test]
fn odd_data_length_with_pad_byte() {
    // 8-bit mono, odd number of samples -> odd data chunk + pad byte.
    let s = signal(Signal::Noise, 8, 1, 1001, 5);
    let mut b = WavBuilder::pcm(1, 8000, 8);
    b.chunks_after = vec![(*b"LIST", info_list(&[(b"INAM", b"after")]))];
    check(&b, &s, 8);
}

#[test]
fn trailing_garbage_after_riff_is_ignored() {
    let s = signal(Signal::Noise, 16, 1, 500, 5);
    let mut b = WavBuilder::pcm(1, 8000, 16);
    b.trailing_garbage = vec![0xAB; 333];
    check(&b, &s, 16);
}

#[test]
fn missing_pad_byte_is_tolerated() {
    // A writer that forgot the pad byte after an odd chunk.
    let s = signal(Signal::Noise, 16, 1, 100, 5);
    let good = WavBuilder::pcm(1, 8000, 16);
    let data = good.pack_int(&s);
    let mut f = b"RIFF\0\0\0\0WAVE".to_vec();
    f.extend_from_slice(b"odd \x03\0\0\0abc"); // no pad byte
    f.extend_from_slice(b"fmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0");
    f.extend_from_slice(b"data");
    f.extend_from_slice(&(data.len() as u32).to_le_bytes());
    f.extend_from_slice(&data);
    let n = (f.len() - 8) as u32;
    f[4..8].copy_from_slice(&n.to_le_bytes());
    let d = decode(&encode(&f, Options::default()));
    assert_eq!(d.samples, s);
}

#[test]
fn garbage_pad_byte_is_skipped() {
    // Writers that filled the pad byte after an odd chunk with a non-zero
    // value, also a printable one, so pad plus the next three bytes look like
    // a chunk id (" fmt", "Xdat"). The next chunk may be unknown too.
    let s = signal(Signal::Noise, 16, 1, 100, 6);
    let data = WavBuilder::pcm(1, 8000, 16).pack_int(&s);
    for pad in [0xFF, b' ', b'X', b'a', b'0'] {
        for next in [&b"fmt "[..], b"data", b"zzzz"] {
            let mut f = b"RIFF\0\0\0\0WAVE".to_vec();
            f.extend_from_slice(b"odd \x03\0\0\0abc");
            f.push(pad);
            if next == b"zzzz" {
                f.extend_from_slice(b"zzzz\x01\0\0\0!\0");
            }
            f.extend_from_slice(b"fmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0");
            if next == b"data" {
                // An odd chunk right before the data chunk.
                f.extend_from_slice(b"odd2\x01\0\0\0!");
                f.push(pad);
            }
            f.extend_from_slice(b"data");
            f.extend_from_slice(&(data.len() as u32).to_le_bytes());
            f.extend_from_slice(&data);
            let n = (f.len() - 8) as u32;
            f[4..8].copy_from_slice(&n.to_le_bytes());
            let what = format!("pad {pad:#x} before {}", String::from_utf8_lossy(next));
            for chunks in [&[usize::MAX][..], &[1][..]] {
                let flac = encode_chunked(&f, Options::default(), chunks).expect(&what);
                assert_eq!(decode(&flac).samples, s, "{what}");
            }
        }
    }
}

#[test]
fn printable_pad_after_odd_data_keeps_trailing_tags() {
    // 8-bit mono with an odd sample count: the data chunk is padded with a
    // space, and a LIST follows.
    let s = signal(Signal::Noise, 8, 1, 1001, 5);
    let b = WavBuilder::pcm(1, 8000, 8);
    let mut f = b.build(&s);
    let list = info_list(&[(b"INAM", b"after")]);
    *f.last_mut().unwrap() = b' '; // the builder's zero pad
    f.extend_from_slice(b"LIST");
    f.extend_from_slice(&(list.len() as u32).to_le_bytes());
    f.extend_from_slice(&list);
    let n = (f.len() - 8) as u32;
    f[4..8].copy_from_slice(&n.to_le_bytes());
    for chunks in [&[usize::MAX][..], &[1][..], &[7][..]] {
        let flac = encode_chunked(&f, Options::default(), chunks).unwrap();
        let (blocks, _) = metadata_blocks(&flac);
        let vc = blocks.iter().find(|b| b.0 == 4).expect("vorbis comment");
        let (_, tags) = parse_vorbis(&vc.2);
        assert!(
            tags.contains(&("TITLE".into(), "after".into())),
            "{chunks:?}: {tags:?}"
        );
        assert_eq!(decode(&flac).samples, s);
    }
}

#[test]
fn fmt_sizes_18_and_40_with_32_bit_pcm() {
    // WAVEFORMATEX nominally allows only 8/16 bits for plain PCM, but 24 and
    // 32-bit files with an 18 or 40-byte fmt chunk exist and are unambiguous.
    let s = signal(Signal::Noise, 32, 2, 500, 7);
    for size in [18u32, 40] {
        let mut b = WavBuilder::pcm(2, 48000, 32);
        b.fmt_size = Some(size);
        let flac = encode(
            &b.build(&s),
            Options {
                bits_per_sample: Some(32),
                ..Options::default()
            },
        );
        let d = decode(&flac);
        assert_eq!(d.samples, s, "fmt size {size}");
    }
}

#[test]
fn many_small_chunks_pushed_one_at_a_time() {
    // Each chunk before `data` is parsed once, however the input is split.
    let s = signal(Signal::Sine, 16, 1, 300, 8);
    let mut b = WavBuilder::pcm(1, 8000, 16);
    b.chunks_before = (0..20_000).map(|i| (*b"JUNK", vec![i as u8; 3])).collect();
    let file = b.build(&s);
    let reference = encode(&file, Options::default());
    let mut e = wav2flac::Encoder::new(Options::default()).unwrap();
    let mut out = Vec::new();
    for piece in file.chunks(12) {
        out.extend_from_slice(&e.push(piece).unwrap());
    }
    let fin = e.finish().unwrap();
    let mut got = fin.header;
    got.extend_from_slice(&out);
    got.extend_from_slice(&fin.tail);
    assert_eq!(got, reference);
}

#[test]
fn right_justified_24_in_32_plain_pcm() {
    // Plain PCM (not extensible) with 24 bits in 4-byte containers: hound's convention.
    let s = signal(Signal::Noise, 24, 2, 1000, 5);
    let mut data = Vec::new();
    for v in &s {
        data.extend_from_slice(&v.to_le_bytes());
    }
    let mut f = b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x02\0\x44\xac\0\0".to_vec();
    f.extend_from_slice(&(44100u32 * 8).to_le_bytes());
    f.extend_from_slice(&8u16.to_le_bytes());
    f.extend_from_slice(&24u16.to_le_bytes());
    f.extend_from_slice(b"data");
    f.extend_from_slice(&(data.len() as u32).to_le_bytes());
    f.extend_from_slice(&data);
    let n = (f.len() - 8) as u32;
    f[4..8].copy_from_slice(&n.to_le_bytes());
    let d = decode(&encode(&f, Options::default()));
    assert_eq!(d.bits, 24);
    assert_eq!(d.samples, s);
}

#[test]
fn channel_mask_with_wrong_speaker_count_is_ignored() {
    let s = signal(Signal::Noise, 16, 2, 3000, 1);
    let b = WavBuilder::pcm(2, 8000, 16).extensible(16, 16, 0x7); // 3 speakers, 2 channels
    check(&b, &s, 16);
    let flac = encode(&b.build(&s), Options::default());
    let tag = wav2flac::metadata::CHANNEL_MASK_TAG.as_bytes();
    assert!(!flac.windows(tag.len()).any(|w| w == tag));
}

#[test]
fn wrong_byte_rate_is_tolerated() {
    for fmt in [
        WavBuilder::pcm(2, 44100, 16),
        WavBuilder::pcm(2, 44100, 16).float32(),
    ] {
        let float = fmt.float;
        let s = signal(Signal::Noise, 16, 2, 3000, 1);
        let mut wav = if float {
            fmt.build_raw(&WavBuilder::pack_f32(
                &s.iter()
                    .map(|&v| f64::from(v) / 32768.0)
                    .collect::<Vec<_>>(),
            ))
        } else {
            fmt.build(&s)
        };
        let mut want = None;
        for byte_rate in [0u32, 1, u32::MAX] {
            wav[28..32].copy_from_slice(&byte_rate.to_le_bytes());
            let opts = Options {
                bits_per_sample: float.then_some(16),
                ..Options::default()
            };
            let flac = encode(&wav, opts);
            assert_eq!(*want.get_or_insert_with(|| flac.clone()), flac);
            if !float {
                assert_eq!(decode(&flac).samples, s);
            }
        }
    }
}
