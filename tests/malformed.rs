// SPDX-License-Identifier: 0BSD
//! Broken and unsupported inputs produce the right error code and never panic.
mod common;
use common::*;
use wav2flac::{encode_all, Encoder, ErrorCode, Options};

fn code(w: &[u8]) -> ErrorCode {
    encode_all(w, Options::default()).unwrap_err().code()
}

fn fixup_riff(mut f: Vec<u8>) -> Vec<u8> {
    let n = (f.len() - 8) as u32;
    f[4..8].copy_from_slice(&n.to_le_bytes());
    f
}

#[test]
fn wrong_containers() {
    assert_eq!(code(b""), ErrorCode::Truncated);
    assert_eq!(code(b"R"), ErrorCode::Truncated);
    assert_eq!(code(b"OggS\0\0\0\0\0\0\0\0"), ErrorCode::InvalidWav);
    assert_eq!(code(b"fLaC\0\0\0\x22"), ErrorCode::InvalidWav);
    assert_eq!(code(b"RIFX\x24\0\0\0WAVE"), ErrorCode::UnsupportedFormat);
    assert_eq!(
        code(b"RF64\xff\xff\xff\xffWAVE"),
        ErrorCode::UnsupportedFormat
    );
    assert_eq!(code(b"RIFF\x24\0\0\0AVI "), ErrorCode::InvalidWav);
}

#[test]
fn streaming_headers_unknown_length() {
    let s = signal(Signal::Noise, 16, 1, 10, 1);
    let mut b = WavBuilder::pcm(1, 8000, 16);
    b.riff_len_override = Some(u32::MAX);
    assert_eq!(code(&b.build(&s)), ErrorCode::UnsupportedFormat);
    let mut b = WavBuilder::pcm(1, 8000, 16);
    b.riff_len_override = Some(0);
    assert_eq!(code(&b.build(&s)), ErrorCode::UnsupportedFormat);
    let mut b = WavBuilder::pcm(1, 8000, 16);
    b.data_len_override = Some(u32::MAX);
    assert_eq!(code(&b.build(&s)), ErrorCode::UnsupportedFormat);
}

#[test]
fn missing_or_misordered_chunks() {
    let data_first = fixup_riff(
        b"RIFF\0\0\0\0WAVEdata\x02\0\0\0\0\0\
        fmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0"
            .to_vec(),
    );
    assert_eq!(code(&data_first), ErrorCode::InvalidWav);
    let no_data = fixup_riff(
        b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0".to_vec(),
    );
    assert_eq!(code(&no_data), ErrorCode::Truncated);
    let dup = fixup_riff(
        b"RIFF\0\0\0\0\
        WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0\
        fmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0\
        data\0\0\0\0"
            .to_vec(),
    );
    assert_eq!(code(&dup), ErrorCode::InvalidWav);
}

#[test]
fn bad_fmt_values() {
    let s = [0i32; 4];
    let mut b = WavBuilder::pcm(1, 8000, 16);
    b.channels = 0;
    assert_eq!(code(&b.build_raw(&[])), ErrorCode::InvalidWav);
    let mut b = WavBuilder::pcm(1, 8000, 16);
    b.sample_rate = 0;
    assert_eq!(code(&b.build(&s)), ErrorCode::InvalidWav);
    // Inconsistent block align / byte rate.
    let mut f = WavBuilder::pcm(1, 8000, 16).build(&s);
    f[32] = 3; // block_align
    assert_eq!(code(&f), ErrorCode::InvalidWav);
    // fmt chunk too short
    let f = fixup_riff(
        b"RIFF\0\0\0\0WAVEfmt \x0e\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0data\0\0\0\0"
            .to_vec(),
    );
    assert_eq!(code(&f), ErrorCode::InvalidWav);
    // bits not multiple of 8 in plain PCM: a width hound cannot unpack
    let mut f = WavBuilder::pcm(1, 8000, 16).build(&s);
    f[34] = 12;
    assert_eq!(code(&f), ErrorCode::UnsupportedBitDepth);
}

#[test]
fn unsupported_encodings() {
    for (tag, _name) in [
        (2u16, "adpcm"),
        (6, "alaw"),
        (7, "mulaw"),
        (0x55, "mp3"),
        (0x1234, "other"),
    ] {
        let mut b = WavBuilder::pcm(1, 8000, 8);
        b.format_tag = tag;
        assert_eq!(
            code(&b.build(&[0, 1])),
            ErrorCode::UnsupportedFormat,
            "tag {tag:#x}"
        );
    }
    // 64-bit float
    let mut f = WavBuilder::pcm(1, 8000, 16).float32().build_raw(&[0; 16]);
    f[34] = 64;
    f[32] = 8;
    f[28..32].copy_from_slice(&64000u32.to_le_bytes());
    assert_eq!(code(&f), ErrorCode::UnsupportedFormat);
}

#[test]
fn bit_depths_needing_explicit_conversion() {
    let f = WavBuilder::pcm(1, 8000, 16)
        .float32()
        .build_raw(&WavBuilder::pack_f32(&[0.1, -0.2]));
    assert_eq!(code(&f), ErrorCode::UnsupportedFormat);
}

#[test]
fn unsupported_bit_depths() {
    // Valid bits outside FLAC's 4..=32 range, in a 4-byte container.
    for bits in [1u16, 2, 3] {
        let b = WavBuilder::pcm(1, 8000, 32).extensible(32, bits, 0x4);
        let e = encode_all(&b.build_raw(&[0; 8]), Options::default()).unwrap_err();
        assert_eq!(e.code(), ErrorCode::UnsupportedBitDepth, "{bits} bits: {e}");
        assert!(e.message().contains("4..=32"), "{e}");
    }
    // Sample containers of 0 or more than 4 bytes.
    for (container_bits, block_align) in [(40u16, 5u16), (64, 8), (0, 0)] {
        let mut f = WavBuilder::pcm(1, 8000, 16).build_raw(&[0; 40]);
        f[32..34].copy_from_slice(&block_align.to_le_bytes());
        f[34..36].copy_from_slice(&container_bits.to_le_bytes());
        f[28..32].copy_from_slice(&(8000 * u32::from(block_align)).to_le_bytes());
        let e = encode_all(&f, Options::default()).unwrap_err();
        let expected = if container_bits == 0 {
            ErrorCode::InvalidWav
        } else {
            ErrorCode::UnsupportedBitDepth
        };
        assert_eq!(e.code(), expected, "{container_bits}-bit container: {e}");
    }
}

#[test]
fn float64_extensible_is_unsupported_format() {
    let mut b = WavBuilder::pcm(1, 8000, 16).extensible(64, 64, 0x4);
    b.float = true;
    let e = encode_all(&b.build_raw(&[0; 16]), Options::default()).unwrap_err();
    assert_eq!(e.code(), ErrorCode::UnsupportedFormat);
    assert!(e.message().contains("64-bit float"), "{e}");
}

#[test]
fn too_many_channels() {
    let s = vec![0i32; 9 * 10];
    assert_eq!(code(&wav(9, 8000, 16, &s)), ErrorCode::TooManyChannels);
}

#[test]
fn data_len_not_multiple_of_frame() {
    let mut b = WavBuilder::pcm(2, 8000, 16);
    b.data_len_override = Some(6);
    assert_eq!(code(&b.build_raw(&[0; 6])), ErrorCode::InvalidWav);
}

#[test]
fn every_truncation_prefix() {
    let files = [
        wav(2, 44100, 16, &signal(Signal::Noise, 16, 2, 300, 1)),
        {
            let mut b = WavBuilder::pcm(3, 48000, 24).extensible(32, 24, 0x7);
            b.chunks_before = vec![(
                *b"LIST",
                info_list(&[(b"INAM", b"t"), (b"IART", b"artist")]),
            )];
            b.build(&signal(Signal::Sine, 24, 3, 200, 1))
        },
        wav(1, 8000, 8, &signal(Signal::Ramp, 8, 1, 101, 1)),
    ];
    for f in &files {
        let full = encode_all(f, Options::default()).unwrap();
        assert!(!full.is_empty());
        let data_end = f.len();
        for n in 0..data_end {
            let r = encode_all(&f[..n], Options::default());
            match r {
                Err(e) => assert!(
                    matches!(e.code(), ErrorCode::Truncated),
                    "prefix {n}/{data_end}: {e}"
                ),
                // Prefixes that cut only trailing chunks/pad bytes are complete.
                Ok(_) => assert!(n > f.len() - 64, "prefix {n}/{data_end} unexpectedly ok"),
            }
        }
    }
}

#[test]
fn random_garbage_never_panics() {
    let mut rng = Rng(99);
    let n = if tier() >= Tier::Full { 20_000 } else { 2_000 };
    for _ in 0..n {
        let len = rng.below(200) as usize;
        let mut v: Vec<u8> = (0..len).map(|_| rng.next_u64() as u8).collect();
        if rng.below(2) == 0 && v.len() >= 12 {
            v[..4].copy_from_slice(b"RIFF");
            v[8..12].copy_from_slice(b"WAVE");
        }
        if let Err(e) = encode_all(&v, Options::default()) {
            assert_ne!(e.code(), ErrorCode::Internal, "{e}");
        }
    }
}

#[test]
fn zero_data_size_followed_by_audio() {
    let s = signal(Signal::Noise, 16, 2, 100, 3);
    let mut b = WavBuilder::pcm(2, 44100, 16);
    b.data_len_override = Some(0);
    b.riff_len_override = Some(36);
    assert_eq!(code(&b.build(&s)), ErrorCode::UnsupportedFormat);
    // Audio that starts like a chunk id ("abcd") is still audio: the length
    // that would follow doesn't fit in the RIFF size, patched or not.
    let mut printable = vec![0x6261, 0x6463, 0x1234, 0x0567];
    printable.extend_from_slice(&s);
    for riff in [None, Some(36)] {
        let mut b = WavBuilder::pcm(2, 44100, 16);
        b.data_len_override = Some(0);
        b.riff_len_override = riff;
        let f = b.build(&printable);
        assert_eq!(&f[44..48], b"abcd");
        assert_eq!(code(&f), ErrorCode::UnsupportedFormat, "{riff:?}");
        let e = encode_chunked(&f, Options::default(), &[1]).unwrap_err();
        assert_eq!(e.code(), ErrorCode::UnsupportedFormat, "{riff:?}");
    }
    // Fewer bytes than a chunk header after an empty data chunk are audio too.
    for n in 1..8 {
        let mut b = WavBuilder::pcm(1, 44100, 16);
        b.data_len_override = Some(0);
        b.riff_len_override = Some(36);
        let mut f = b.build(&[]);
        f.extend(std::iter::repeat_n(7u8, n));
        assert_eq!(code(&f), ErrorCode::UnsupportedFormat, "{n}");
    }
    // An empty data chunk followed by a real chunk is fine.
    let mut b = WavBuilder::pcm(2, 44100, 16);
    b.chunks_after = vec![(*b"LIST", info_list(&[(b"INAM", b"empty")]))];
    assert!(encode_all(&b.build(&[]), Options::default()).is_ok());
}

#[test]
fn one_valid_bit_in_a_32_bit_container() {
    let b = WavBuilder::pcm(1, 8000, 32).extensible(32, 1, 0x4);
    let run = |data: &[u8]| {
        encode_all(
            &b.build_raw(data),
            Options {
                bits_per_sample: Some(16),
                ..Options::default()
            },
        )
    };
    let r = run(&[0, 0, 0, 0x80, 0, 0, 0, 0]);
    assert!(r.is_ok(), "{r:?}");
    let e = run(&[1, 0, 0, 0]).unwrap_err();
    assert_eq!(e.code(), ErrorCode::InvalidWav);
}

#[test]
fn sample_rate_limit() {
    // 1 048 575 Hz is the largest rate STREAMINFO can hold.
    let s = signal(Signal::Sine, 16, 1, 100, 1);
    let b = WavBuilder::pcm(1, 1_048_575, 16);
    assert!(encode_all(&b.build(&s), Options::default()).is_ok());
    let b = WavBuilder::pcm(1, 1_048_576, 16);
    assert_eq!(code(&b.build(&s)), ErrorCode::UnsupportedFormat);
}

#[test]
fn chunks_before_data_are_limited_to_64_mib() {
    const LIMIT: usize = 64 << 20;
    // A chunk that declares more than the limit fails before any of it
    // arrives, so the encoder never buffers it.
    let mut f = b"RIFF\0\0\0\x08WAVEJUNK".to_vec();
    f.extend_from_slice(&(LIMIT as u32).to_le_bytes());
    let mut enc = Encoder::new(Options::default()).unwrap();
    assert_eq!(enc.push(&f).unwrap_err().code(), ErrorCode::LimitExceeded);
    // Exactly 64 MiB of chunks before `data` is fine; one byte more is not.
    let s = signal(Signal::Sine, 16, 1, 100, 1);
    let fmt_end = WavBuilder::pcm(1, 8000, 16).build(&[]).len() - 8; // RIFF + fmt
    for (extra, ok) in [(0usize, true), (2, false)] {
        let mut b = WavBuilder::pcm(1, 8000, 16);
        b.chunks_before = vec![(*b"JUNK", vec![0; LIMIT - fmt_end - 8 + extra])];
        let r = encode_all(&b.build(&s), Options::default());
        match r {
            Ok(_) => assert!(ok),
            Err(e) => {
                assert!(!ok, "{e}");
                assert_eq!(e.code(), ErrorCode::LimitExceeded);
            }
        }
    }
}
