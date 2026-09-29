// SPDX-License-Identifier: 0BSD
//! FLAC metadata blocks: STREAMINFO, `VORBIS_COMMENT`,
//! SEEKTABLE and PADDING.

use crate::error::{err, ErrorCode, Result};

const TYPE_STREAMINFO: u8 = 0;
const TYPE_PADDING: u8 = 1;
const TYPE_SEEKTABLE: u8 = 3;
const TYPE_VORBIS_COMMENT: u8 = 4;
/// Largest metadata block body (the length field has 24 bits).
pub(crate) const MAX_BLOCK_LEN: usize = (1 << 24) - 1;
/// Error message for a block over [`MAX_BLOCK_LEN`].
pub(crate) const TOO_LONG: &str = "metadata block exceeds 16 MiB (too many or too long tags?)";

/// Name of the Vorbis comment that libFLAC uses to store a non-default
/// WAV channel mask.
pub const CHANNEL_MASK_TAG: &str = "WAVEFORMATEXTENSIBLE_CHANNEL_MASK";

/// One seek point: first sample of a frame and its byte offset from the
/// first frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeekPoint {
    /// Sample number of the first sample in the target frame.
    pub sample: u64,
    /// Byte offset of the target frame header, relative to the first frame.
    pub offset: u64,
    /// Number of samples in the target frame.
    pub frame_samples: u16,
}

/// The channel mask FLAC assumes for `channels` channels (FLAC format spec).
#[must_use]
pub const fn flac_default_mask(channels: u16) -> u32 {
    match channels {
        1 => 0x4,
        2 => 0x3,
        3 => 0x7,
        4 => 0x33,
        5 => 0x37,
        6 => 0x3F,
        7 => 0x70F,
        8 => 0x63F,
        _ => 0,
    }
}

/// Whether decoders disagree on the implied layout of `channels` in FLAC.
///
/// For 5 and 6 channels the FLAC spec implies *back* surrounds (0x37/0x3F),
/// but ffmpeg assumes *side* surrounds, so the mask must be stated explicitly
/// (ffmpeg's own FLAC encoder does the same).
#[must_use]
pub const fn default_mask_is_ambiguous(channels: u16) -> bool {
    matches!(channels, 5 | 6)
}

/// Returns the value of the channel-mask tag if the WAV states a mask that
/// differs from the FLAC default for `channels`, or that decoders interpret
/// inconsistently (see [`default_mask_is_ambiguous`]); else `None`.
#[must_use]
pub fn channel_mask_tag(channels: u16, mask: Option<u32>) -> Option<String> {
    match mask {
        Some(m) if m != flac_default_mask(channels) || default_mask_is_ambiguous(channels) => {
            Some(format!("0x{m:04X}"))
        }
        _ => None,
    }
}

/// Contents of the STREAMINFO block.
///
/// We serialize STREAMINFO ourselves: the frame writer emits frames only,
/// and we compute totals, frame sizes and MD5 while encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StreamInfo {
    /// Minimum block size in samples (excluding the last block).
    pub min_block_size: u16,
    /// Maximum block size in samples.
    pub max_block_size: u16,
    /// Minimum frame size in bytes, 0 = unknown.
    pub min_frame_size: u32,
    /// Maximum frame size in bytes, 0 = unknown.
    pub max_frame_size: u32,
    /// Sample rate in Hz (20 bits).
    pub sample_rate: u32,
    /// Channel count (1..=8).
    pub channels: u8,
    /// Bits per sample (4..=32).
    pub bits_per_sample: u8,
    /// Total per-channel samples, 0 = unknown (36 bits).
    pub total_samples: u64,
    /// MD5 of the unencoded audio, all zero = unknown.
    pub md5: [u8; 16],
}

impl StreamInfo {
    /// Serialized STREAMINFO body (34 bytes).
    #[must_use]
    pub fn to_bytes(&self) -> [u8; 34] {
        let mut b = [0u8; 34];
        b[0..2].copy_from_slice(&self.min_block_size.to_be_bytes());
        b[2..4].copy_from_slice(&self.max_block_size.to_be_bytes());
        b[4..7].copy_from_slice(&self.min_frame_size.min(0xFF_FFFF).to_be_bytes()[1..]);
        b[7..10].copy_from_slice(&self.max_frame_size.min(0xFF_FFFF).to_be_bytes()[1..]);
        // 20 bits rate | 3 bits channels-1 | 5 bits bps-1 | 36 bits total samples
        let packed: u64 = (u64::from(self.sample_rate & 0xF_FFFF) << 44)
            | (u64::from(self.channels.saturating_sub(1) & 0x7) << 41)
            | (u64::from(self.bits_per_sample.saturating_sub(1) & 0x1F) << 36)
            // 0 means "unknown"; a count that does not fit is not truncated.
            | if self.total_samples > 0xF_FFFF_FFFF {
                0
            } else {
                self.total_samples
            };
        b[10..18].copy_from_slice(&packed.to_be_bytes());
        b[18..34].copy_from_slice(&self.md5);
        b
    }
}

/// Serializes a `VORBIS_COMMENT` body.
#[must_use]
pub fn vorbis_comment_body(vendor: &str, comments: &[(String, String)]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    v.extend_from_slice(vendor.as_bytes());
    v.extend_from_slice(&(comments.len() as u32).to_le_bytes());
    for (k, val) in comments {
        let entry_len = k.len() + 1 + val.len();
        v.extend_from_slice(&(entry_len as u32).to_le_bytes());
        v.extend_from_slice(k.as_bytes());
        v.push(b'=');
        v.extend_from_slice(val.as_bytes());
    }
    v
}

/// Serializes a SEEKTABLE body.
#[must_use]
pub fn seektable_body(points: &[SeekPoint]) -> Vec<u8> {
    let mut v = Vec::with_capacity(points.len() * 18);
    for p in points {
        v.extend_from_slice(&p.sample.to_be_bytes());
        v.extend_from_slice(&p.offset.to_be_bytes());
        v.extend_from_slice(&p.frame_samples.to_be_bytes());
    }
    v
}

/// Chooses seek points every `interval_samples` from the frame index
/// (`(first_sample, offset, frame_samples)` per frame, in order).
#[must_use]
pub fn choose_seek_points(frames: &[(u64, u64, u16)], interval_samples: u64) -> Vec<SeekPoint> {
    let mut picker = SeekPicker::new(interval_samples);
    for &(sample, offset, n) in frames {
        picker.push(sample, offset, n);
    }
    picker.finish()
}

/// Picks seek points while frames are encoded, holding only the chosen
/// points and the latest frame instead of an index of every frame.
#[derive(Debug, Clone)]
pub struct SeekPicker {
    interval: u64,
    points: Vec<SeekPoint>,
    /// The latest frame, not yet decided: its range ends where the next starts.
    last: Option<SeekPoint>,
    first: bool,
}

impl SeekPicker {
    /// A picker for a point every `interval_samples`; 0 picks none.
    #[must_use]
    pub fn new(interval_samples: u64) -> Self {
        Self {
            interval: interval_samples,
            points: Vec::new(),
            last: None,
            first: true,
        }
    }

    /// Adds the next frame, which starts at `sample` and `offset`.
    pub fn push(&mut self, sample: u64, offset: u64, frame_samples: u16) {
        if self.interval == 0 || self.points.len() >= MAX_BLOCK_LEN / 18 {
            return;
        }
        self.decide(sample);
        self.last = Some(SeekPoint {
            sample,
            offset,
            frame_samples,
        });
    }

    /// The chosen points, once all frames have been pushed.
    #[must_use]
    pub fn finish(mut self) -> Vec<SeekPoint> {
        if let Some(p) = self.last {
            self.decide(p.sample.saturating_add(1));
        }
        self.points
    }

    /// Number of points held so far.
    #[must_use]
    pub fn len(&self) -> usize {
        self.points.len()
    }

    /// Whether no point has been chosen yet.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// Frame `last` holds the point for every multiple of the interval in
    /// `[its start, end)`; the first frame's range starts at 0.
    fn decide(&mut self, end: u64) {
        let Some(p) = self.last.take() else {
            return;
        };
        let start = if self.first { 0 } else { p.sample };
        self.first = false;
        let hit = start
            .div_ceil(self.interval)
            .checked_mul(self.interval)
            .is_some_and(|t| t < end);
        if hit && self.points.len() < MAX_BLOCK_LEN / 18 {
            self.points.push(p);
        }
    }
}

/// Assembles `fLaC` plus all metadata blocks, setting the last-block flag
/// on the final one.
///
/// # Errors
///
/// `InvalidOptions` if a block exceeds the 16 MiB metadata block limit.
pub fn write_header(
    stream_info: &StreamInfo,
    vorbis: Option<&[u8]>,
    seektable: Option<&[u8]>,
    padding: u32,
) -> Result<Vec<u8>> {
    let si = stream_info.to_bytes();
    let mut blocks: Vec<(u8, &[u8])> = vec![(TYPE_STREAMINFO, &si)];
    if let Some(v) = vorbis {
        blocks.push((TYPE_VORBIS_COMMENT, v));
    }
    if let Some(s) = seektable {
        if !s.is_empty() {
            blocks.push((TYPE_SEEKTABLE, s));
        }
    }
    let pad = vec![0u8; padding as usize];
    if padding > 0 {
        blocks.push((TYPE_PADDING, &pad));
    }
    let total: usize = 4 + blocks.iter().map(|(_, b)| 4 + b.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"fLaC");
    let n = blocks.len();
    for (i, (ty, body)) in blocks.into_iter().enumerate() {
        if body.len() > MAX_BLOCK_LEN {
            return err(ErrorCode::InvalidOptions, TOO_LONG);
        }
        let last = if i + 1 == n { 0x80 } else { 0 };
        out.push(ty | last);
        let len = body.len() as u32;
        out.extend_from_slice(&len.to_be_bytes()[1..]);
        out.extend_from_slice(body);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_masks_need_no_tag() {
        for ch in 1..=8 {
            let expect =
                default_mask_is_ambiguous(ch).then(|| format!("0x{:04X}", flac_default_mask(ch)));
            assert_eq!(channel_mask_tag(ch, Some(flac_default_mask(ch))), expect);
            assert_eq!(channel_mask_tag(ch, None), None);
        }
        assert_eq!(channel_mask_tag(2, Some(0x5)), Some("0x0005".into()));
        assert_eq!(channel_mask_tag(6, Some(0x60F)), Some("0x060F".into()));
    }

    #[test]
    fn vorbis_comment_layout() {
        let b = vorbis_comment_body("v", &[("A".into(), "b".into())]);
        assert_eq!(
            b,
            vec![1, 0, 0, 0, b'v', 1, 0, 0, 0, 3, 0, 0, 0, b'A', b'=', b'b']
        );
    }

    #[test]
    fn seek_points_pick_frame_at_or_before_target() {
        let frames: Vec<(u64, u64, u16)> = (0..10).map(|i| (i * 100, i * 1000, 100)).collect();
        let pts = choose_seek_points(&frames, 250);
        let samples: Vec<u64> = pts.iter().map(|p| p.sample).collect();
        assert_eq!(samples, vec![0, 200, 500, 700]);
        assert!(choose_seek_points(&frames, 0).is_empty());
    }

    #[test]
    fn streaminfo_packing() {
        let si = StreamInfo {
            min_block_size: 4096,
            max_block_size: 4096,
            min_frame_size: 14,
            max_frame_size: 0x12_3456,
            sample_rate: 384_000,
            channels: 8,
            bits_per_sample: 24,
            total_samples: 0xF_0000_0001,
            md5: [7; 16],
        };
        let b = si.to_bytes();
        assert_eq!(&b[0..4], &[0x10, 0, 0x10, 0]);
        assert_eq!(&b[4..10], &[0, 0, 14, 0x12, 0x34, 0x56]);
        // 384000 = 0x5DC00 -> 20 bits; channels 7 -> 3 bits; bps 23 -> 5 bits
        assert_eq!(&b[10..14], &[0x5D, 0xC0, 0x0F, 0x7F]);
        assert_eq!(&b[14..18], &[0, 0, 0, 1]);
        assert_eq!(&b[18..], &[7; 16]);
    }

    #[test]
    fn header_last_flag_and_lengths() {
        let si = StreamInfo {
            sample_rate: 44100,
            channels: 2,
            bits_per_sample: 16,
            ..StreamInfo::default()
        };
        let h = write_header(&si, Some(&[0; 8]), None, 4).unwrap();
        assert_eq!(&h[0..4], b"fLaC");
        assert_eq!(h[4], 0); // STREAMINFO, not last
        assert_eq!(&h[5..8], &[0, 0, 34]);
        let vc = 4 + 4 + 34;
        assert_eq!(h[vc], 4);
        let pad = vc + 4 + 8;
        assert_eq!(h[pad], 0x80 | 1);
        assert_eq!(h.len(), pad + 4 + 4);
    }

    /// The previous per-target selection, kept as the reference.
    fn seek_points_per_target(frames: &[(u64, u64, u16)], interval: u64) -> Vec<SeekPoint> {
        let mut out: Vec<SeekPoint> = Vec::new();
        let (mut target, mut i) = (0u64, 0usize);
        let last_sample = frames.last().map_or(0, |f| f.0);
        while target <= last_sample && out.len() < MAX_BLOCK_LEN / 18 {
            while i + 1 < frames.len() && frames[i + 1].0 <= target {
                i += 1;
            }
            let (sample, offset, n) = frames[i];
            if out.last().is_none_or(|p| p.sample != sample) {
                out.push(SeekPoint {
                    sample,
                    offset,
                    frame_samples: n,
                });
            }
            let Some(t) = target.checked_add(interval) else {
                break;
            };
            target = t;
        }
        out
    }

    #[test]
    fn seek_points_match_per_target_selection() {
        let mut x = 0x2545_F491_4F6C_DD1Du64;
        let mut rnd = |n: u64| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x % n
        };
        for _ in 0..500 {
            let mut frames = Vec::new();
            let (mut sample, mut offset) = (0u64, 0u64);
            for _ in 0..=rnd(300) {
                let n = rnd(5000) as u16 + 1;
                frames.push((sample, offset, n));
                sample += u64::from(n);
                offset += rnd(9000) + 10;
            }
            for interval in [1, 7, rnd(20_000) + 1, 44_100, u64::MAX] {
                let want = seek_points_per_target(&frames, interval);
                assert_eq!(choose_seek_points(&frames, interval), want, "{interval}");
            }
        }
        // A one-sample interval is one point per frame, not per sample.
        let many: Vec<_> = (0..10_000u64).map(|i| (i * 4096, i * 100, 4096)).collect();
        assert_eq!(choose_seek_points(&many, 1).len(), many.len());
    }

    #[test]
    fn oversized_total_samples_are_written_as_unknown() {
        let mut si = StreamInfo {
            total_samples: 1 << 36,
            ..StreamInfo::default()
        };
        assert_eq!(si.to_bytes()[13] & 0x0F, 0);
        assert_eq!(si.to_bytes()[14..18], [0; 4]);
        si.total_samples = (1 << 36) - 1;
        assert_eq!(si.to_bytes()[14..18], [0xFF; 4]);
    }
}
