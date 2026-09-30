// SPDX-License-Identifier: 0BSD
//! Shared helpers for the integration test suites: WAV builders, signal
//! generators, FLAC decoding/inspection and test-tier scaling.
#![allow(dead_code)]

use std::io::Cursor;
use wav2flac::{Encoder, Options, OutputMode};

// ---------------------------------------------------------------- tiers ---

/// Test tier from `WAV2FLAC_TEST_TIER` (`quick` | `full` | `soak`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    Quick,
    Full,
    Soak,
}

/// Unset or empty means `quick`; any other value is a typo and fails loudly
/// instead of silently running the smallest matrices.
pub fn tier() -> Tier {
    match std::env::var("WAV2FLAC_TEST_TIER") {
        Err(std::env::VarError::NotPresent) => Tier::Quick,
        Ok(v) => match v.as_str() {
            "" | "quick" => Tier::Quick,
            "full" => Tier::Full,
            "soak" => Tier::Soak,
            _ => panic!("WAV2FLAC_TEST_TIER must be quick, full or soak, not {v:?}"),
        },
        Err(e) => panic!("WAV2FLAC_TEST_TIER: {e}"),
    }
}

/// In the quick tier, keep every `n`-th element of a matrix (deterministically).
pub fn sample_matrix<T: Clone>(all: &[T], quick_every: usize) -> Vec<T> {
    if tier() >= Tier::Full {
        all.to_vec()
    } else {
        all.iter().step_by(quick_every.max(1)).cloned().collect()
    }
}

/// Whether external tools are mandatory (CI sets this).
pub fn require_tools() -> bool {
    std::env::var("WAV2FLAC_REQUIRE_TOOLS").as_deref() == Ok("1")
}

/// Returns true if `bin` is runnable; panics when tools are required but missing.
pub fn have_tool(bin: &str) -> bool {
    let ok = std::process::Command::new(bin)
        .arg("--version")
        .output()
        .map(|o| o.status.success() || !o.stdout.is_empty() || !o.stderr.is_empty())
        .unwrap_or(false);
    if !ok && require_tools() {
        panic!("required tool `{bin}` is missing (WAV2FLAC_REQUIRE_TOOLS=1)");
    }
    if !ok {
        eprintln!("skipping: `{bin}` not installed");
    }
    ok
}

// -------------------------------------------------------------- signals ---

/// Deterministic pseudo-random generator (SplitMix64).
pub struct Rng(pub u64);

impl Rng {
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n.max(1)
    }
    pub fn range_i32(&mut self, min: i32, max: i32) -> i32 {
        let span = (i64::from(max) - i64::from(min) + 1) as u64;
        (i64::from(min) + (self.next_u64() % span) as i64) as i32
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Silence,
    DcMax,
    DcMin,
    Sine,
    Noise,
    Square,
    Impulse,
    MinMax,
    Ramp,
}

pub const ALL_SIGNALS: [Signal; 9] = [
    Signal::Silence,
    Signal::DcMax,
    Signal::DcMin,
    Signal::Sine,
    Signal::Noise,
    Signal::Square,
    Signal::Impulse,
    Signal::MinMax,
    Signal::Ramp,
];

/// Generates interleaved integer samples at `bits` precision.
pub fn signal(kind: Signal, bits: u32, channels: usize, frames: usize, seed: u64) -> Vec<i32> {
    let max = (1i64 << (bits - 1)) - 1;
    let min = -(1i64 << (bits - 1));
    let mut rng = Rng(seed);
    let mut out = Vec::with_capacity(frames * channels);
    for i in 0..frames {
        for ch in 0..channels {
            let v: i64 = match kind {
                Signal::Silence => 0,
                Signal::DcMax => max,
                Signal::DcMin => min,
                Signal::Sine => {
                    let f = 0.01 + 0.003 * ch as f64;
                    ((i as f64 * f * std::f64::consts::TAU).sin() * max as f64 * 0.9) as i64
                }
                Signal::Noise => i64::from(rng.range_i32(min as i32, max as i32)),
                Signal::Square => {
                    if (i / 50 + ch) % 2 == 0 {
                        max
                    } else {
                        min
                    }
                }
                Signal::Impulse => {
                    if i % 997 == ch {
                        max
                    } else {
                        0
                    }
                }
                Signal::MinMax => {
                    if (i + ch) % 2 == 0 {
                        max
                    } else {
                        min
                    }
                }
                Signal::Ramp => min + ((i as i64 * 7919 + ch as i64 * 31) % (max - min + 1)),
            };
            out.push(v.clamp(min, max) as i32);
        }
    }
    out
}

/// Sine wave as normalized f64 (interleaved, same on all channels).
pub fn sine_f64(freq: f64, rate: u32, channels: usize, frames: usize, amp: f64) -> Vec<f64> {
    let mut v = Vec::with_capacity(frames * channels);
    for i in 0..frames {
        let s = (i as f64 * freq / f64::from(rate) * std::f64::consts::TAU).sin() * amp;
        for _ in 0..channels {
            v.push(s);
        }
    }
    v
}

// ---------------------------------------------------------- WAV builder ---

/// Flexible WAV file builder that can also produce broken files.
#[derive(Debug, Clone)]
pub struct WavBuilder {
    pub format_tag: u16,
    pub channels: u16,
    pub sample_rate: u32,
    /// Bits stored per sample (container, multiple of 8).
    pub container_bits: u16,
    /// Valid bits (extensible only).
    pub valid_bits: u16,
    pub channel_mask: u32,
    pub extensible: bool,
    pub float: bool,
    pub fmt_size: Option<u32>,
    pub chunks_before: Vec<([u8; 4], Vec<u8>)>,
    pub chunks_after: Vec<([u8; 4], Vec<u8>)>,
    pub data_len_override: Option<u32>,
    pub riff_len_override: Option<u32>,
    pub trailing_garbage: Vec<u8>,
}

impl WavBuilder {
    pub fn pcm(channels: u16, sample_rate: u32, bits: u16) -> Self {
        Self {
            format_tag: 1,
            channels,
            sample_rate,
            container_bits: bits.div_ceil(8) * 8,
            valid_bits: bits,
            channel_mask: 0,
            extensible: false,
            float: false,
            fmt_size: None,
            chunks_before: vec![],
            chunks_after: vec![],
            data_len_override: None,
            riff_len_override: None,
            trailing_garbage: vec![],
        }
    }

    pub fn extensible(mut self, container_bits: u16, valid_bits: u16, mask: u32) -> Self {
        self.extensible = true;
        self.format_tag = 0xFFFE;
        self.container_bits = container_bits;
        self.valid_bits = valid_bits;
        self.channel_mask = mask;
        self
    }

    pub fn float32(mut self) -> Self {
        self.float = true;
        self.format_tag = 3;
        self.container_bits = 32;
        self.valid_bits = 32;
        self
    }

    pub fn block_align(&self) -> usize {
        usize::from(self.channels) * usize::from(self.container_bits / 8)
    }

    fn fmt_chunk(&self) -> Vec<u8> {
        let ba = self.block_align() as u16;
        let mut v = Vec::new();
        v.extend_from_slice(&self.format_tag.to_le_bytes());
        v.extend_from_slice(&self.channels.to_le_bytes());
        v.extend_from_slice(&self.sample_rate.to_le_bytes());
        v.extend_from_slice(&(self.sample_rate * u32::from(ba)).to_le_bytes());
        v.extend_from_slice(&ba.to_le_bytes());
        v.extend_from_slice(&self.container_bits.to_le_bytes());
        if self.extensible {
            v.extend_from_slice(&22u16.to_le_bytes());
            v.extend_from_slice(&self.valid_bits.to_le_bytes());
            v.extend_from_slice(&self.channel_mask.to_le_bytes());
            let mut guid = [
                0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38,
                0x9B, 0x71,
            ];
            if self.float {
                guid[0] = 0x03;
            }
            v.extend_from_slice(&guid);
            if let Some(sz) = self.fmt_size.filter(|&sz| sz > 40) {
                // cbSize announces the extra bytes after the 22 standard ones.
                v[16..18].copy_from_slice(&((sz - 18) as u16).to_le_bytes());
                v.resize(sz as usize, 0);
            }
        } else if let Some(sz) = self.fmt_size {
            if sz >= 18 {
                v.extend_from_slice(&0u16.to_le_bytes());
            }
            v.resize(sz as usize, 0);
        }
        v
    }

    /// Encodes integer samples into the container format.
    pub fn pack_int(&self, samples: &[i32]) -> Vec<u8> {
        let cb = usize::from(self.container_bits / 8);
        let shift = if self.extensible {
            u32::from(self.container_bits - self.valid_bits)
        } else {
            0
        };
        let mut out = Vec::with_capacity(samples.len() * cb);
        for &s in samples {
            if cb == 1 {
                out.push((s + 128) as u8);
            } else {
                let v = (s << shift).to_le_bytes();
                out.extend_from_slice(&v[..cb]);
            }
        }
        out
    }

    pub fn pack_f32(samples: &[f64]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|s| (*s as f32).to_le_bytes())
            .collect()
    }

    /// Assembles the file around raw data bytes.
    pub fn build_raw(&self, data: &[u8]) -> Vec<u8> {
        let mut body = b"WAVE".to_vec();
        let push_chunk = |body: &mut Vec<u8>, id: &[u8; 4], c: &[u8]| {
            body.extend_from_slice(id);
            body.extend_from_slice(&(c.len() as u32).to_le_bytes());
            body.extend_from_slice(c);
            if c.len() % 2 == 1 {
                body.push(0);
            }
        };
        for (id, c) in &self.chunks_before {
            push_chunk(&mut body, id, c);
        }
        push_chunk(&mut body, b"fmt ", &self.fmt_chunk());
        body.extend_from_slice(b"data");
        body.extend_from_slice(
            &self
                .data_len_override
                .unwrap_or(data.len() as u32)
                .to_le_bytes(),
        );
        body.extend_from_slice(data);
        if data.len() % 2 == 1 {
            body.push(0);
        }
        for (id, c) in &self.chunks_after {
            push_chunk(&mut body, id, c);
        }
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(
            &self
                .riff_len_override
                .unwrap_or(body.len() as u32)
                .to_le_bytes(),
        );
        out.extend_from_slice(&body);
        out.extend_from_slice(&self.trailing_garbage);
        out
    }

    pub fn build(&self, samples: &[i32]) -> Vec<u8> {
        self.build_raw(&self.pack_int(samples))
    }
}

/// Builds a `LIST/INFO` chunk body.
pub fn info_list(entries: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
    let mut v = b"INFO".to_vec();
    for (id, text) in entries {
        v.extend_from_slice(*id);
        v.extend_from_slice(&(text.len() as u32).to_le_bytes());
        v.extend_from_slice(text);
        if text.len() % 2 == 1 {
            v.push(0);
        }
    }
    v
}

/// Convenience: plain PCM WAV from samples.
pub fn wav(channels: u16, rate: u32, bits: u16, samples: &[i32]) -> Vec<u8> {
    WavBuilder::pcm(channels, rate, bits).build(samples)
}

// ------------------------------------------------------------- encoding ---

pub fn encode(wav: &[u8], opts: Options) -> Vec<u8> {
    wav2flac::encode_all(wav, opts).expect("encode")
}

/// Encodes by pushing `chunks` sizes cyclically; returns the assembled file.
pub fn encode_chunked(wav: &[u8], opts: Options, chunks: &[usize]) -> wav2flac::Result<Vec<u8>> {
    let mode = opts.mode;
    let mut enc = Encoder::new(opts)?;
    let mut body = Vec::new();
    let mut pos = 0;
    let mut i = 0;
    while pos < wav.len() {
        let n = chunks[i % chunks.len()].max(1).min(wav.len() - pos);
        body.extend(enc.push(&wav[pos..pos + n])?);
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

// ------------------------------------------------------------- decoding ---

#[derive(Debug)]
pub struct Decoded {
    pub sample_rate: u32,
    pub channels: u32,
    pub bits: u32,
    pub total_samples: Option<u64>,
    pub md5: [u8; 16],
    pub min_block: u16,
    pub max_block: u16,
    pub samples: Vec<i32>,
    pub tags: Vec<(String, String)>,
}

/// Decodes with libflac-rs (primary oracle, MD5-verified) and cross-checks
/// with claxon when claxon supports the stream's features.
pub fn decode(flac: &[u8]) -> Decoded {
    let (blocks, _) = metadata_blocks(flac);
    let si = &blocks[0].2;
    assert_eq!(blocks[0].0, 0, "first block must be STREAMINFO");
    let min_block = u16::from_be_bytes([si[0], si[1]]);
    let max_block = u16::from_be_bytes([si[2], si[3]]);
    let packed = u64::from_be_bytes(si[10..18].try_into().unwrap());
    let si_bits = ((packed >> 36) & 0x1F) as u32 + 1;
    let d = match libflac_rs::decode(flac) {
        Some(d) => d,
        // libflac-rs 0.143.1's *decoder* cannot read bit depths that are only
        // stored in STREAMINFO (not 8/12/16/20/24/32); ffmpeg can.
        None if ![8, 12, 16, 20, 24, 32].contains(&si_bits) => {
            return decode_ffmpeg(flac, &blocks, min_block, max_block, si_bits)
        }
        None => panic!("libflac-rs: decode failed (CRC or format error)"),
    };
    assert!(d.md5_ok, "libflac-rs: MD5 mismatch");
    let tags = blocks
        .iter()
        .find(|b| b.0 == 4)
        .map(|b| parse_vorbis(&b.2).1)
        .unwrap_or_default();
    // Secondary oracle: claxon (pre-RFC 9639: no 32-bit, no escaped partitions).
    if d.bits_per_sample == 32 {
        // claxon treats the 32-bit sample-size code as reserved.
    } else if let Ok(mut r) = claxon::FlacReader::new(Cursor::new(flac)) {
        let c: Result<Vec<i32>, _> = r.samples().collect();
        match c {
            Ok(c) => assert!(c == d.interleaved, "claxon and libflac-rs disagree"),
            Err(claxon::Error::Unsupported(_)) => {}
            Err(e) => panic!("claxon: {e}"),
        }
    }
    Decoded {
        sample_rate: d.sample_rate,
        channels: d.channels,
        bits: d.bits_per_sample,
        total_samples: (d.total_samples != 0).then_some(d.total_samples),
        md5: d.md5,
        min_block,
        max_block,
        samples: d.interleaved,
        tags,
    }
}

/// Decodes via the `ffmpeg` CLI (third, independent decoder).
fn decode_ffmpeg(
    flac: &[u8],
    blocks: &[(u8, bool, Vec<u8>)],
    min_block: u16,
    max_block: u16,
    bits: u32,
) -> Decoded {
    let si = &blocks[0].2;
    let packed = u64::from_be_bytes(si[10..18].try_into().unwrap());
    let sample_rate = (packed >> 44) as u32;
    let channels = ((packed >> 41) & 7) as u32 + 1;
    let total = packed & 0xF_FFFF_FFFF;
    let md5: [u8; 16] = si[18..34].try_into().unwrap();
    let tags = blocks
        .iter()
        .find(|b| b.0 == 4)
        .map(|b| parse_vorbis(&b.2).1)
        .unwrap_or_default();
    let samples = if let Some(s) = ffmpeg_pcm(flac, bits) {
        if md5 != [0; 16] {
            assert_eq!(
                pcm_md5(&s, bits),
                md5,
                "ffmpeg-decoded audio does not match STREAMINFO MD5"
            );
        }
        s
    } else {
        eprintln!("warning: {bits}-bit stream not sample-verified (no ffmpeg)");
        Vec::new()
    };
    Decoded {
        sample_rate,
        channels,
        bits,
        total_samples: (total != 0).then_some(total),
        md5,
        min_block,
        max_block,
        samples,
        tags,
    }
}

/// Runs ffmpeg with `args` on `input` (written to a temp file) and returns stdout.
/// `None` if ffmpeg is not installed. Panics if ffmpeg fails.
pub fn ffmpeg(bin: &str, input: &[u8], ext: &str, args: &[&str]) -> Option<Vec<u8>> {
    if !have_tool(bin) {
        return None;
    }
    // Unique per call: parallel tests may decode identical inputs.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = format!("{}-{n}", std::process::id());
    let inp = std::env::temp_dir().join(format!("w2f-{id}.{ext}"));
    std::fs::write(&inp, input).unwrap();
    let mut cmd = std::process::Command::new(bin);
    if bin == "ffmpeg" {
        cmd.args(["-v", "error", "-i"])
            .arg(&inp)
            .args(args)
            .arg("-");
    } else {
        cmd.args(args).arg(&inp);
    }
    let out = cmd.output().unwrap();
    let _ = std::fs::remove_file(&inp);
    assert!(
        out.status.success(),
        "{bin} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Some(out.stdout)
}

/// Decodes FLAC with ffmpeg to interleaved samples at `bits`.
pub fn ffmpeg_pcm(flac: &[u8], bits: u32) -> Option<Vec<i32>> {
    let raw = ffmpeg(
        "ffmpeg",
        flac,
        "flac",
        &["-f", "s32le", "-acodec", "pcm_s32le"],
    )?;
    Some(
        raw.chunks_exact(4)
            .map(|c| i32::from_le_bytes(c.try_into().unwrap()) >> (32 - bits))
            .collect(),
    )
}

/// Parses a VORBIS_COMMENT body into (vendor, [(key, value)]).
pub fn parse_vorbis(b: &[u8]) -> (String, Vec<(String, String)>) {
    let rd = |p: usize| u32::from_le_bytes(b[p..p + 4].try_into().unwrap()) as usize;
    let vl = rd(0);
    let vendor = String::from_utf8(b[4..4 + vl].to_vec()).unwrap();
    let mut p = 4 + vl;
    let n = rd(p);
    p += 4;
    let mut out = vec![];
    for _ in 0..n {
        let l = rd(p);
        let e = std::str::from_utf8(&b[p + 4..p + 4 + l]).unwrap();
        let (k, v) = e.split_once('=').unwrap();
        out.push((k.to_owned(), v.to_owned()));
        p += 4 + l;
    }
    assert_eq!(p, b.len(), "trailing bytes in VORBIS_COMMENT");
    (vendor, out)
}

/// MD5 of samples as FLAC defines it (LE signed, ceil(bits/8) bytes).
pub fn pcm_md5(samples: &[i32], bits: u32) -> [u8; 16] {
    use md5::{Digest, Md5};
    let w = bits.div_ceil(8) as usize;
    let mut h = Md5::new();
    for s in samples {
        h.update(&s.to_le_bytes()[..w]);
    }
    h.finalize().into()
}

/// Metadata block list: `(type, is_last, body)`, plus the offset of the first frame.
pub fn metadata_blocks(flac: &[u8]) -> (Vec<(u8, bool, Vec<u8>)>, usize) {
    assert_eq!(&flac[..4], b"fLaC");
    let mut p = 4;
    let mut blocks = vec![];
    loop {
        let hdr = flac[p];
        let len = u32::from_be_bytes([0, flac[p + 1], flac[p + 2], flac[p + 3]]) as usize;
        let body = flac[p + 4..p + 4 + len].to_vec();
        blocks.push((hdr & 0x7F, hdr & 0x80 != 0, body));
        p += 4 + len;
        if hdr & 0x80 != 0 {
            break;
        }
    }
    (blocks, p)
}

/// Parsed SEEKTABLE entries `(sample, offset, frame_samples)`.
pub fn seek_points(flac: &[u8]) -> Vec<(u64, u64, u16)> {
    let (blocks, _) = metadata_blocks(flac);
    blocks
        .iter()
        .filter(|b| b.0 == 3)
        .flat_map(|b| {
            b.2.chunks_exact(18)
                .map(|c| {
                    (
                        u64::from_be_bytes(c[0..8].try_into().unwrap()),
                        u64::from_be_bytes(c[8..16].try_into().unwrap()),
                        u16::from_be_bytes(c[16..18].try_into().unwrap()),
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Asserts a lossless round trip including STREAMINFO checks.
pub fn assert_roundtrip(
    samples: &[i32],
    channels: u16,
    rate: u32,
    bits: u16,
    opts: Options,
) -> Vec<u8> {
    let w = wav(channels, rate, bits, samples);
    let flac = encode(&w, opts);
    let d = decode(&flac);
    assert_eq!(d.sample_rate, rate);
    assert_eq!(d.channels, u32::from(channels));
    assert_eq!(d.bits, u32::from(bits));
    let frames = samples.len() / usize::from(channels);
    assert_eq!(d.total_samples.unwrap_or(0), frames as u64);
    assert_eq!(d.md5, pcm_md5(samples, u32::from(bits)), "md5 mismatch");
    assert!(
        d.samples == samples,
        "sample mismatch ({channels}ch {rate}Hz {bits}bit)"
    );
    flac
}
