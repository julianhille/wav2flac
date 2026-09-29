// SPDX-License-Identifier: 0BSD
//! The push-based streaming encoder.
//!
//! ```text
//! push(bytes) ──► header detection ──► PCM decode ──► transcode ──► block ──► libFLAC frame ──► bytes
//! finish()    ──► flush last block + resampler tail, build the FLAC header
//! ```
//!
//! In [`OutputMode::Buffered`] the header is returned by [`Encoder::finish`]
//! and must be placed *before* all frame bytes. In [`OutputMode::Streaming`]
//! the header is part of the first non-empty [`Encoder::push`] output.

use crate::error::{err, Error, ErrorCode, Result};
use crate::frame;
use crate::metadata::{self, CHANNEL_MASK_TAG};
use crate::options::{Options, OutputMode, Tags};
use crate::pcm::{self, PcmLayout, PcmSpec};
use crate::riff::{self, HeaderParser, HeaderState, SampleFormat, WavHeader};
use crate::transcode::{Samples, Transcoder};
use md5::{Digest, Md5};

/// Vendor string written into the `VORBIS_COMMENT` block.
pub const VENDOR: &str = concat!(
    "wav2flac ",
    env!("CARGO_PKG_VERSION"),
    " (libflac-rs 0.143.1)"
);

/// Description of the input, available once the header was parsed.
#[derive(Debug, Clone, PartialEq)]
pub struct WavInfo {
    /// Input sample rate in Hz.
    pub sample_rate: u32,
    /// Channel count.
    pub channels: u16,
    /// Valid bits per input sample.
    pub bits_per_sample: u16,
    /// Integer or float.
    pub format: SampleFormat,
    /// Per-channel sample count announced by the header.
    pub frames: u64,
    /// Duration in seconds.
    pub duration_sec: f64,
    /// `WAVE_FORMAT_EXTENSIBLE` channel mask, if any.
    pub channel_mask: Option<u32>,
    /// Tags from `LIST/INFO` chunks before the data.
    pub tags: Vec<(String, String)>,
}

impl WavInfo {
    fn from_header(h: &WavHeader) -> Self {
        let frames = h.total_frames();
        Self {
            sample_rate: h.sample_rate,
            channels: h.channels,
            bits_per_sample: h.valid_bits,
            format: h.format,
            frames,
            duration_sec: frames as f64 / f64::from(h.sample_rate),
            channel_mask: h.channel_mask,
            tags: h.tags.clone(),
        }
    }
}

/// Progress counters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Progress {
    /// Input bytes pushed so far.
    pub bytes_in: u64,
    /// Output samples (per channel) encoded into frames so far.
    pub samples_out: u64,
    /// Fraction of the data chunk consumed (0..=1), `None` before the header is known.
    pub fraction: Option<f64>,
}

/// Output of [`Encoder::finish`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Finished {
    /// The FLAC header (`fLaC` + metadata). Empty in streaming mode, where it
    /// was already emitted.
    pub header: Vec<u8>,
    /// Remaining frame bytes, to be appended after all previous output.
    pub tail: Vec<u8>,
}

enum State {
    /// Buffering until the WAV header is complete.
    Header,
    /// Inside the data chunk.
    Data,
    /// After the data chunk (trailing chunks).
    Trailing,
    /// `finish` completed.
    Finished,
    /// An error occurred; the encoder is unusable.
    Failed,
}

struct Active {
    header: WavHeader,
    layout: PcmLayout,
    transcoder: Transcoder,
    /// libFLAC-exact frame encoder (one block per call).
    flac: libflac_rs::Encoder,
    block_size: usize,
    channels: usize,
    bytes_per_out_sample: usize,
    /// Data-chunk bytes still expected (`u64::MAX` when the length is unknown).
    data_remaining: u64,
    /// Total data bytes, if known up front.
    data_total: Option<u64>,
    /// Incomplete sample frame carried over between pushes.
    partial: Vec<u8>,
    /// Interleaved output samples waiting for a full block.
    block: Vec<i32>,
    int_scratch: Vec<i32>,
    float_scratch: Vec<f64>,
    md5: Md5,
    md5_bytes: Vec<u8>,
    frame_number: usize,
    samples_out: u64,
    frame_bytes_out: u64,
    min_frame: usize,
    max_frame: usize,
    /// `(first_sample, byte_offset, samples)` per frame, for the seek table.
    frame_index: Vec<(u64, u64, u16)>,
    /// Whether `frame_index` is needed (buffered output with a seek table);
    /// otherwise it would grow by one entry per frame for nothing.
    index_frames: bool,
    /// Tag scanner for the chunks after the data (buffered output only).
    trailing: Option<riff::TrailingScanner>,
    /// First bytes after the data chunk, for the streaming-header check.
    lead: Vec<u8>,
}

/// Streaming WAV → FLAC encoder.
pub struct Encoder {
    opts: Options,
    state: State,
    buf: Vec<u8>,
    /// Resumable header parser; each chunk before `data` is inspected once.
    header_parser: HeaderParser,
    bytes_in: u64,
    active: Option<Box<Active>>,
    /// Progress frozen at a successful `finish`, after `active` is released.
    final_progress: Option<Progress>,
    /// Output produced at construction (raw PCM, streaming header), emitted
    /// with the next `push` or `finish`.
    pending: Vec<u8>,
    /// Raw PCM input (no container): bytes past the declared length are an error.
    raw_pcm: bool,
}

impl Encoder {
    /// Creates an encoder after validating `opts`.
    ///
    /// # Errors
    ///
    /// `InvalidOptions` for invalid options.
    pub fn new(opts: Options) -> Result<Self> {
        opts.validate()?;
        // The overrides alone are a lower bound of the `VORBIS_COMMENT` block:
        // fail now rather than at `finish`, after all the input was encoded.
        let overrides = vorbis_len(&comments(&opts, &[]));
        if overrides > metadata::MAX_BLOCK_LEN {
            return err(ErrorCode::InvalidOptions, metadata::TOO_LONG);
        }
        Ok(Self {
            opts,
            state: State::Header,
            buf: Vec::new(),
            header_parser: HeaderParser::new(),
            bytes_in: 0,
            active: None,
            final_progress: None,
            pending: Vec::new(),
            raw_pcm: false,
        })
    }

    /// Creates an encoder for raw, headerless PCM described by `spec`.
    ///
    /// Every pushed byte is sample data. `total_bytes` is the input length
    /// if known; it only affects progress reporting and validation. The
    /// output is byte-identical to encoding the same samples wrapped in a
    /// plain WAV file.
    ///
    /// # Errors
    ///
    /// `InvalidOptions` for invalid options, zero channels or sample rate, or
    /// a `total_bytes` that is not a whole number of sample frames;
    /// `TooManyChannels` above 8 channels; the same format errors as WAV
    /// input (e.g. `F32` without a target `bits_per_sample`).
    pub fn new_pcm(opts: Options, spec: PcmSpec, total_bytes: Option<u64>) -> Result<Self> {
        let mut enc = Self::new(opts)?;
        if spec.channels == 0 || spec.sample_rate == 0 {
            return err(
                ErrorCode::InvalidOptions,
                "pcm: channels and sampleRate must be at least 1",
            );
        }
        if spec.sample_rate > crate::options::MAX_SAMPLE_RATE && enc.opts.sample_rate.is_none() {
            return err(
                ErrorCode::InvalidOptions,
                format!(
                    "pcm: sampleRate {} Hz cannot be stored in FLAC (at most {} Hz); \
                     set a target sampleRate to resample",
                    spec.sample_rate,
                    crate::options::MAX_SAMPLE_RATE
                ),
            );
        }
        if let Some(total) = total_bytes {
            if total % spec.frame_bytes() as u64 != 0 {
                return err(
                    ErrorCode::InvalidOptions,
                    format!(
                        "pcm: {total} bytes is not a whole number of {}-byte sample frames",
                        spec.frame_bytes()
                    ),
                );
            }
        }
        let data_len = total_bytes.map_or(0, |t| u32::try_from(t).unwrap_or(u32::MAX));
        let mut out = Vec::new();
        enc.start(spec.to_header(data_len), &mut out)?;
        let a = enc.active.as_mut().expect("just started");
        a.data_total = total_bytes;
        a.data_remaining = total_bytes.unwrap_or(u64::MAX);
        if a.data_remaining == 0 {
            enc.state = State::Trailing;
        }
        enc.pending = out;
        enc.raw_pcm = true;
        Ok(enc)
    }

    /// Information about the input, once its header has been parsed.
    #[must_use]
    pub fn info(&self) -> Option<WavInfo> {
        self.active.as_ref().map(|a| {
            let mut info = WavInfo::from_header(&a.header);
            // Raw PCM may declare more than the 32-bit WAV header field holds.
            if let Some(total) = a.data_total {
                info.frames = total / a.header.block_align() as u64;
                info.duration_sec = info.frames as f64 / f64::from(a.header.sample_rate);
            }
            info
        })
    }

    /// Output sample rate and bit depth, once known.
    #[must_use]
    pub fn output_spec(&self) -> Option<crate::transcode::OutputSpec> {
        self.active.as_ref().map(|a| a.transcoder.spec)
    }

    /// Current progress counters.
    #[must_use]
    pub fn progress(&self) -> Progress {
        if let Some(p) = self.final_progress {
            return p;
        }
        let (samples_out, fraction) = match &self.active {
            Some(a) => {
                let fraction = a.data_total.map(|total| {
                    if total == 0 {
                        1.0
                    } else {
                        (total - a.data_remaining) as f64 / total as f64
                    }
                });
                (a.samples_out, fraction)
            }
            None => (0, None),
        };
        Progress {
            bytes_in: self.bytes_in,
            samples_out,
            fraction,
        }
    }

    /// Bytes currently held in internal buffers (for tests of bounded memory).
    #[must_use]
    pub fn buffered_len(&self) -> usize {
        self.buf.len()
            + self.active.as_ref().map_or(0, |a| {
                a.partial.len()
                    + a.block.len() * 4
                    + a.lead.len()
                    + a.trailing
                        .as_ref()
                        .map_or(0, riff::TrailingScanner::buffered_len)
            })
    }

    /// Feeds input bytes and returns FLAC bytes that became available.
    ///
    /// # Errors
    ///
    /// Any parsing or encoding error. After an error, every further call
    /// fails with `ENCODER_STATE`.
    pub fn push(&mut self, input: &[u8]) -> Result<Vec<u8>> {
        let result = self.push_inner(input);
        if result.is_err() {
            self.fail_if_active();
        }
        result
    }

    /// Completes the stream.
    ///
    /// # Errors
    ///
    /// `TRUNCATED` if the input ended early, or any encoding error.
    pub fn finish(&mut self) -> Result<Finished> {
        let result = self.finish_inner();
        match &result {
            Ok(_) => {
                self.state = State::Finished;
                self.final_progress = Some(self.progress());
                self.release();
            }
            Err(_) => self.fail_if_active(),
        }
        result
    }

    /// Marks the encoder as failed, unless it already finished or failed: a
    /// call after `finish` keeps reporting "already finished".
    fn fail_if_active(&mut self) {
        if !matches!(self.state, State::Finished | State::Failed) {
            self.state = State::Failed;
            self.release();
        }
    }

    fn release(&mut self) {
        self.buf = Vec::new();
        self.active = None;
    }

    fn check_usable(&self) -> Result<()> {
        match self.state {
            State::Finished => err(ErrorCode::EncoderState, "encoder already finished"),
            State::Failed => err(
                ErrorCode::EncoderState,
                "encoder failed earlier and cannot be reused",
            ),
            _ => Ok(()),
        }
    }

    fn push_inner(&mut self, input: &[u8]) -> Result<Vec<u8>> {
        self.check_usable()?;
        self.bytes_in += input.len() as u64;
        if let Some(max) = self.opts.max_input_bytes {
            if self.bytes_in > max {
                return err(
                    ErrorCode::LimitExceeded,
                    format!("input exceeds maxInputBytes ({max})"),
                );
            }
        }
        let mut out = std::mem::take(&mut self.pending);
        match self.state {
            State::Header => {
                self.buf.extend_from_slice(input);
                if let HeaderState::Done(h) = self.header_parser.parse(&self.buf, false)? {
                    self.start(h, &mut out)?;
                    let rest = std::mem::take(&mut self.buf);
                    let data_offset = self.active.as_ref().map_or(0, |a| a.header.data_offset);
                    self.consume(&rest[data_offset..], &mut out)?;
                }
            }
            State::Data | State::Trailing => self.consume(input, &mut out)?,
            State::Finished | State::Failed => unreachable!("checked above"),
        }
        Ok(out)
    }

    fn start(&mut self, header: WavHeader, out: &mut Vec<u8>) -> Result<()> {
        let channels = usize::from(header.channels);
        if channels > 8 {
            return err(
                ErrorCode::TooManyChannels,
                format!("{channels} channels (FLAC supports at most 8)"),
            );
        }
        let transcoder = Transcoder::plan(
            header.format,
            u32::from(header.valid_bits),
            header.sample_rate,
            channels,
            &self.opts,
        )?;
        let spec = transcoder.spec;
        let block_size = self.opts.effective_block_size();
        if spec.sample_rate == 0 || spec.sample_rate > crate::options::MAX_SAMPLE_RATE {
            return err(
                ErrorCode::UnsupportedFormat,
                format!(
                    "sample rate {} Hz cannot be stored in FLAC",
                    spec.sample_rate
                ),
            );
        }
        let flac = libflac_rs::Encoder::new(
            libflac_rs::EncoderConfig::new(channels as u32, spec.bits, spec.sample_rate)
                .with_compression_level(u32::from(self.opts.compression_level))
                .with_block_size(block_size as u32)
                .with_md5(false),
        );
        let header_data_len = header.data_len;
        let active = Active {
            layout: PcmLayout::from_header(&header),
            data_remaining: u64::from(header.data_len),
            data_total: Some(u64::from(header.data_len)),
            header,
            transcoder,
            flac,
            block_size,
            channels,
            bytes_per_out_sample: (spec.bits as usize).div_ceil(8),
            partial: Vec::new(),
            block: Vec::with_capacity(block_size * channels),
            int_scratch: Vec::new(),
            float_scratch: Vec::new(),
            md5: Md5::new(),
            md5_bytes: Vec::new(),
            frame_number: 0,
            samples_out: 0,
            frame_bytes_out: 0,
            min_frame: usize::MAX,
            max_frame: 0,
            frame_index: Vec::new(),
            index_frames: self.opts.mode != OutputMode::Streaming
                && self.opts.seek_point_interval > 0.0,
            trailing: (self.opts.mode != OutputMode::Streaming)
                .then(|| riff::TrailingScanner::new(header_data_len)),
            lead: Vec::new(),
        };
        self.active = Some(Box::new(active));
        self.state = State::Data;
        if self.opts.mode == OutputMode::Streaming {
            let a = self.active.as_mut().expect("just set");
            let si = a.flac_info(false);
            let vorbis = build_vorbis(&self.opts, &a.header, &a.header.tags);
            let header = metadata::write_header(&si, vorbis.as_deref(), None, self.opts.padding)?;
            out.extend_from_slice(&header);
        }
        Ok(())
    }

    /// Routes bytes to the data or trailing section.
    fn consume(&mut self, mut input: &[u8], out: &mut Vec<u8>) -> Result<()> {
        let a = self.active.as_mut().expect("active after header");
        if matches!(self.state, State::Data) {
            let take = input
                .len()
                .min(usize::try_from(a.data_remaining).unwrap_or(usize::MAX));
            a.data_remaining -= take as u64;
            a.data(&input[..take], out)?;
            input = &input[take..];
            if a.data_remaining == 0 {
                self.state = State::Trailing;
            }
        }
        if matches!(self.state, State::Trailing) && !input.is_empty() {
            if self.raw_pcm {
                return err(
                    ErrorCode::InvalidOptions,
                    "pcm: more input than the declared total length",
                );
            }
            if let Some(t) = a.trailing.as_mut() {
                t.push(input);
            }
            let seen = a.lead.len();
            a.lead
                .extend_from_slice(&input[..input.len().min(4 - seen)]);
            // Streaming writers leave the data size at 0 and append the audio;
            // encoding that as an empty file would silently drop everything.
            if a.header.data_len == 0
                && seen < 4
                && a.lead.len() == 4
                && !riff::is_chunk_id(&a.lead)
            {
                return err(
                    ErrorCode::UnsupportedFormat,
                    "data chunk size is 0 but audio follows \
                     (streaming WAV header); fix the header sizes first",
                );
            }
        }
        Ok(())
    }

    fn finish_inner(&mut self) -> Result<Finished> {
        self.check_usable()?;
        if matches!(self.state, State::Header) {
            match self.header_parser.parse(&self.buf, true)? {
                HeaderState::Done(h) => {
                    let mut out = Vec::new();
                    self.start(h, &mut out)?;
                    let rest = std::mem::take(&mut self.buf);
                    let off = self.active.as_ref().map_or(0, |a| a.header.data_offset);
                    self.consume(&rest[off..], &mut out)?;
                    let mut fin = self.finish_active()?;
                    out.append(&mut fin.tail);
                    fin.tail = out;
                    return Ok(fin);
                }
                HeaderState::NeedMore => {
                    return err(ErrorCode::Internal, "header parser wants more data at EOF")
                }
            }
        }
        let mut fin = self.finish_active()?;
        if !self.pending.is_empty() {
            let mut out = std::mem::take(&mut self.pending);
            out.append(&mut fin.tail);
            fin.tail = out;
        }
        Ok(fin)
    }

    fn finish_active(&mut self) -> Result<Finished> {
        let opts = &self.opts;
        let a = self.active.as_mut().expect("active after header");
        if a.data_total.is_none() {
            if !a.partial.is_empty() {
                return err(
                    ErrorCode::Truncated,
                    format!(
                        "input ended inside a sample frame ({} of {} bytes)",
                        a.partial.len(),
                        a.header.block_align()
                    ),
                );
            }
        } else if a.data_remaining > 0 {
            return err(
                ErrorCode::Truncated,
                format!(
                    "input ended {} bytes before the end of the data chunk",
                    a.data_remaining
                ),
            );
        }
        let mut tail = Vec::new();
        let mut rest = Vec::new();
        a.transcoder.finish(&mut rest)?;
        a.block.extend_from_slice(&rest);
        a.drain_blocks(&mut tail)?;
        if !a.block.is_empty() {
            let block = std::mem::take(&mut a.block);
            a.encode_block(&block, &mut tail)?;
        }
        if opts.mode == OutputMode::Streaming {
            return Ok(Finished {
                header: Vec::new(),
                tail,
            });
        }
        let mut tags = a.header.tags.clone();
        if let Some(t) = a.trailing.take() {
            tags.extend(t.tags);
        }
        let si = a.flac_info(true);
        let vorbis = build_vorbis(opts, &a.header, &tags);
        // A tiny but non-zero interval still asks for a seek table (every
        // frame), not for none. `frame_index` is empty when it is disabled.
        let interval = ((opts.seek_point_interval * f64::from(a.transcoder.spec.sample_rate))
            .round() as u64)
            .max(1);
        let points = metadata::choose_seek_points(&a.frame_index, interval);
        let seektable = (!points.is_empty()).then(|| metadata::seektable_body(&points));
        let header =
            metadata::write_header(&si, vorbis.as_deref(), seektable.as_deref(), opts.padding)?;
        Ok(Finished { header, tail })
    }
}

/// The WAV tags with the overrides applied, without the channel-mask field.
fn comments(opts: &Options, wav_tags: &[(String, String)]) -> Vec<(String, String)> {
    let mut comments: Vec<(String, String)> = match &opts.tags {
        Tags::Disabled => Vec::new(),
        Tags::FromWav(overrides) => {
            let mut c = wav_tags.to_vec();
            for (k, v) in overrides {
                c.retain(|(ek, _)| !ek.eq_ignore_ascii_case(k));
                if !v.is_empty() {
                    c.push((k.clone(), v.clone()));
                }
            }
            c
        }
    };
    comments.retain(|(k, _)| !k.eq_ignore_ascii_case(CHANNEL_MASK_TAG));
    comments
}

/// Size of the `VORBIS_COMMENT` body for `comments`.
fn vorbis_len(comments: &[(String, String)]) -> usize {
    let entries: usize = comments
        .iter()
        .map(|(k, v)| 4 + k.len() + 1 + v.len())
        .sum();
    4 + VENDOR.len() + 4 + entries
}

/// Builds the VORBIS_COMMENT body, or `None` when no block should be written.
fn build_vorbis(
    opts: &Options,
    header: &WavHeader,
    wav_tags: &[(String, String)],
) -> Option<Vec<u8>> {
    let mut comments = comments(opts, wav_tags);
    if let Some(mask) = metadata::channel_mask_tag(header.channels, header.channel_mask) {
        comments.push((CHANNEL_MASK_TAG.to_owned(), mask));
    }
    if matches!(opts.tags, Tags::Disabled) && comments.is_empty() {
        return None;
    }
    Some(metadata::vorbis_comment_body(VENDOR, &comments))
}

impl Active {
    /// STREAMINFO contents; `complete` adds totals, frame sizes and MD5.
    fn flac_info(&self, complete: bool) -> metadata::StreamInfo {
        let spec = self.transcoder.spec;
        let mut si = metadata::StreamInfo {
            min_block_size: self.block_size as u16,
            max_block_size: self.block_size as u16,
            sample_rate: spec.sample_rate,
            channels: self.channels as u8,
            bits_per_sample: spec.bits as u8,
            ..metadata::StreamInfo::default()
        };
        if complete {
            si.total_samples = self.samples_out;
            si.md5 = self.md5.clone().finalize().into();
            if self.frame_number > 0 {
                si.min_frame_size = self.min_frame as u32;
                si.max_frame_size = self.max_frame as u32;
            }
        }
        si
    }

    /// Handles raw data-chunk bytes.
    fn data(&mut self, bytes: &[u8], out: &mut Vec<u8>) -> Result<()> {
        let align = self.header.block_align();
        let mut bytes = bytes;
        // Complete a sample frame split across pushes.
        if !self.partial.is_empty() {
            let need = align - self.partial.len();
            let take = need.min(bytes.len());
            self.partial.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.partial.len() < align {
                return Ok(());
            }
            let p = std::mem::take(&mut self.partial);
            self.decode(&p)?;
        }
        let whole = bytes.len() / align * align;
        if whole > 0 {
            self.decode(&bytes[..whole])?;
        }
        self.partial.extend_from_slice(&bytes[whole..]);
        self.drain_blocks(out)
    }

    fn decode(&mut self, bytes: &[u8]) -> Result<()> {
        match self.layout.format {
            SampleFormat::Int => {
                self.int_scratch.clear();
                pcm::decode_int(&self.layout, bytes, &mut self.int_scratch)?;
                self.transcoder
                    .process(Samples::Int(&self.int_scratch), &mut self.block)
            }
            SampleFormat::Float => {
                self.float_scratch.clear();
                pcm::decode_f32(bytes, &mut self.float_scratch);
                self.transcoder
                    .process(Samples::Float(&self.float_scratch), &mut self.block)
            }
        }
    }

    /// Encodes every complete block in `self.block`.
    fn drain_blocks(&mut self, out: &mut Vec<u8>) -> Result<()> {
        let n = self.block_size * self.channels;
        if self.block.len() < n {
            return Ok(());
        }
        let block = std::mem::take(&mut self.block);
        let mut chunks = block.chunks_exact(n);
        for c in &mut chunks {
            self.encode_block(c, out)?;
        }
        self.block = chunks.remainder().to_vec();
        self.block.reserve(n);
        Ok(())
    }

    /// Encodes one (possibly short, final) block of interleaved samples.
    fn encode_block(&mut self, interleaved: &[i32], out: &mut Vec<u8>) -> Result<()> {
        let samples = interleaved.len() / self.channels;
        // MD5 over the output samples as little-endian signed integers.
        self.md5_bytes.clear();
        let w = self.bytes_per_out_sample;
        for v in interleaved {
            self.md5_bytes.extend_from_slice(&v.to_le_bytes()[..w]);
        }
        self.md5.update(&self.md5_bytes);
        let raw = self.flac.encode_frames(interleaved);
        let number = u32::try_from(self.frame_number)
            .ok()
            .filter(|n| *n < 1 << 31)
            .ok_or_else(|| Error::new(ErrorCode::LimitExceeded, "more than 2^31 frames"))?;
        let len = frame::renumber(&raw, number, out)?;
        if self.index_frames {
            self.frame_index.push((
                self.samples_out,
                self.frame_bytes_out,
                u16::try_from(samples).unwrap_or(u16::MAX),
            ));
        }
        self.min_frame = self.min_frame.min(len);
        self.max_frame = self.max_frame.max(len);
        self.frame_bytes_out += len as u64;
        self.samples_out += samples as u64;
        self.frame_number += 1;
        Ok(())
    }
}

/// Encodes a complete in-memory WAV file (buffered mode) in one call.
///
/// # Errors
///
/// Any error of [`Encoder::push`] / [`Encoder::finish`].
pub fn encode_all(wav: &[u8], opts: Options) -> Result<Vec<u8>> {
    let mut opts = opts;
    opts.mode = OutputMode::Buffered;
    let mut enc = Encoder::new(opts)?;
    let body = enc.push(wav)?;
    let fin = enc.finish()?;
    let mut out = fin.header;
    out.reserve(body.len() + fin.tail.len());
    out.extend_from_slice(&body);
    out.extend_from_slice(&fin.tail);
    Ok(out)
}

/// Parses only the header of a WAV file.
///
/// # Errors
///
/// Header errors, or `TRUNCATED` if `wav` does not contain the full header.
pub fn probe(wav: &[u8]) -> Result<WavInfo> {
    match riff::parse_header(wav, true)? {
        HeaderState::Done(h) => Ok(WavInfo::from_header(&h)),
        HeaderState::NeedMore => err(ErrorCode::Truncated, "incomplete header"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pcm::{PcmFormat, PcmSpec};

    #[test]
    fn frame_numbers_stop_below_2_pow_31() {
        let spec = PcmSpec {
            format: PcmFormat::S16,
            channels: 1,
            sample_rate: 8000,
        };
        let opts = Options {
            block_size: Some(16),
            ..Options::default()
        };
        let mut enc = Encoder::new_pcm(opts, spec, None).unwrap();
        let block = [0u8; 32]; // 16 samples: one frame per push
        assert!(!enc.push(&block).unwrap().is_empty());
        // Skip ahead instead of encoding 2^31 frames.
        enc.active.as_mut().unwrap().frame_number = (1 << 31) - 1;
        assert!(!enc.push(&block).unwrap().is_empty(), "last valid number");
        let e = enc.push(&block).unwrap_err();
        assert_eq!(e.code(), ErrorCode::LimitExceeded);
    }
}
