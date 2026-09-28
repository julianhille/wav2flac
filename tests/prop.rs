// SPDX-License-Identifier: 0BSD
//! Property tests: random valid WAVs round-trip bit-exactly under random
//! chunking; random bytes never panic.
mod common;
use common::*;
use proptest::prelude::*;
use wav2flac::{Encoder, ErrorCode, Options};

fn cases() -> u32 {
    let n = match std::env::var("PROPTEST_CASES") {
        Ok(v) => v
            .parse()
            .unwrap_or_else(|_| panic!("PROPTEST_CASES must be a number, not {v:?}")),
        Err(_) => match tier() {
            Tier::Quick => 64,
            Tier::Full => 2_000,
            Tier::Soak => 20_000,
        },
    };
    assert!(n >= 1, "PROPTEST_CASES must be at least 1");
    n
}

/// Fails on `Internal` errors: those mean a bug, not bad input.
fn check_err(r: wav2flac::Result<Vec<u8>>) -> Result<(), TestCaseError> {
    if let Err(e) = r {
        prop_assert!(e.code() != ErrorCode::Internal, "internal error: {e}");
    }
    Ok(())
}

prop_compose! {
    fn spec()(bits in prop::sample::select(vec![8u16, 16, 24, 32]),
              channels in 1u16..=8,
              rate in prop::sample::select(vec![8000u32, 12000, 22050, 44100, 48000, 64000, 96000,
                                                12345, 1_048_575]),
              frames in 0usize..5000,
              seed in any::<u64>(),
              level in 0u8..=8) -> (u16, u16, u32, usize, u64, u8) {
        (bits, channels, rate, frames, seed, level)
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(), ..ProptestConfig::default() })]

    #[test]
    fn roundtrip_any_chunking((bits, ch, rate, frames, seed, level) in spec(),
                              chunks in prop::collection::vec(1usize..9000, 1..6)) {
        let s = signal(Signal::Noise, u32::from(bits), ch as usize, frames, seed);
        let w = wav(ch, rate, bits, &s);
        let o = Options { compression_level: level, ..Options::default() };
        let whole = encode(&w, o.clone());
        let split = encode_chunked(&w, o, &chunks).unwrap();
        prop_assert!(whole == split, "chunking changed the output");
        let d = decode(&whole);
        prop_assert_eq!(d.samples, s);
    }

    #[test]
    fn random_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..4096),
                                chunk in 1usize..512) {
        let mut enc = Encoder::new(Options::default()).unwrap();
        for c in bytes.chunks(chunk) {
            let r = enc.push(c);
            if r.is_err() { return check_err(r); }
        }
        check_err(enc.finish().map(|f| f.tail))?;
    }

    #[test]
    fn mutated_wav_never_panics((bits, ch, rate, frames, seed, _l) in spec(),
                                flips in prop::collection::vec(
                                    (any::<prop::sample::Index>(), any::<u8>(), any::<bool>()),
                                    1..8)) {
        let s = signal(Signal::Noise, u32::from(bits), ch as usize, frames.min(500), seed);
        let mut w = wav(ch, rate, bits, &s);
        // Half of the flips hit the header, the rest anywhere in the file.
        for (i, v, header) in flips {
            let n = w.len();
            w[i.index(if header { n.min(80) } else { n })] = v;
        }
        check_err(wav2flac::encode_all(&w, Options::default()))?;
    }
}
