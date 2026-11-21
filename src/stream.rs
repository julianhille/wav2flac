// SPDX-License-Identifier: 0BSD
//! Stateful resampling across calls, for recordings that are cut into
//! separate files.
//!
//! [`StreamResampler`] keeps the resampler's filter history between pushes,
//! so a signal fed in any pieces gives the same output as one call, and the
//! same output as `encode()` resampling the whole signal at once.
//!
//! [`ChunkEncoder`] adds requantization and FLAC framing on top: every cut
//! is a complete FLAC file, and the decoded files joined back together are
//! the samples of one whole-signal encode, bit for bit.

use crate::encoder::Encoder;
use crate::error::{err, ErrorCode, Result};
use crate::options::{
    Dither, Options, OutputMode, ResampleQuality, MAX_SAMPLE_RATE, MIN_BLOCK_SIZE,
};
use crate::pcm::{PcmFormat, PcmSpec};
use crate::transcode::requantize::Requantizer;
use crate::transcode::resample::{Resample, CHUNK_FRAMES};
use crate::transcode::sanitize;

/// Most channels FLAC can store.
const MAX_CHANNELS: u16 = 8;

/// Input samples processed per step, so a huge push needs no huge buffers.
const PUSH_SLICE: usize = 1 << 16;

/// One [`ChunkEncoder::cut`] or [`ChunkEncoder::finish`] call stops after
/// the file that brings its output to this many bytes, leaving the rest
/// pending. Every file carries its own padding and tags (up to 32 MiB), so
/// short files could otherwise fill the 4 GiB of wasm32 memory.
const CUT_BYTES: usize = 64 << 20;

/// Lifecycle of a stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Open,
    /// A chunk encoder's `finish()` has ended the input; files are left.
    Finishing,
    Flushed,
    Failed,
}

fn check_channels(channels: u16) -> Result<()> {
    if channels == 0 {
        return err(ErrorCode::InvalidOptions, "channels must be at least 1");
    }
    if channels > MAX_CHANNELS {
        return err(
            ErrorCode::TooManyChannels,
            format!("{channels} channels (FLAC supports at most {MAX_CHANNELS})"),
        );
    }
    Ok(())
}

fn check_output_rate(rate: u32) -> Result<()> {
    if rate == 0 || rate > MAX_SAMPLE_RATE {
        return err(
            ErrorCode::InvalidOptions,
            format!("the output rate must be 1..={MAX_SAMPLE_RATE}, got {rate}"),
        );
    }
    Ok(())
}

/// A resampler that keeps its state across calls.
///
/// Input is interleaved `f32`, nominally −1.0..=1.0; output is interleaved
/// `f64` at the output rate. Pieces need not hold whole sample frames, but
/// the whole input must.
///
/// The filter runs on fixed blocks of input, the same blocks `encode()` uses,
/// so output lags the input: [`StreamResampler::push`] returns only what
/// complete blocks decide, and [`StreamResampler::flush`] returns the rest.
pub struct StreamResampler {
    /// `None` when the rates are equal: samples pass through.
    inner: Option<Resample>,
    channels: usize,
    /// Input samples per slice, so that one slice's output stays bounded.
    slice: usize,
    /// Samples of an incomplete frame carried to the next push.
    partial: Vec<f64>,
    scratch: Vec<f64>,
    /// Output of one slice of input, before it goes to the caller.
    out: Vec<f64>,
    state: State,
}

impl StreamResampler {
    /// Creates a resampler from `input_rate` to `output_rate` Hz.
    ///
    /// # Errors
    ///
    /// `InvalidOptions` for a zero rate, an output rate above 1 048 575 (the
    /// FLAC limit; the input rate has none, as in `encode()`) or zero channels,
    /// `TooManyChannels` above 8, and `UnsupportedFormat` for a ratio beyond
    /// the limits of `encode()` (256× up, 65536× down).
    pub fn new(
        input_rate: u32,
        output_rate: u32,
        channels: u16,
        quality: ResampleQuality,
    ) -> Result<Self> {
        check_output_rate(output_rate)?;
        check_channels(channels)?;
        let inner = if input_rate == output_rate {
            None
        } else {
            Some(Resample::new(
                input_rate,
                output_rate,
                usize::from(channels),
                quality,
            )?)
        };
        Ok(Self {
            inner,
            channels: usize::from(channels),
            slice: (PUSH_SLICE / output_rate.div_ceil(input_rate) as usize)
                .max(CHUNK_FRAMES * usize::from(channels)),
            partial: Vec::new(),
            scratch: Vec::new(),
            out: Vec::new(),
            state: State::Open,
        })
    }

    fn check_open(&self) -> Result<()> {
        match self.state {
            State::Open => Ok(()),
            State::Flushed | State::Finishing => {
                err(ErrorCode::EncoderState, "resampler already flushed")
            }
            State::Failed => err(
                ErrorCode::EncoderState,
                "resampler failed earlier and cannot be reused",
            ),
        }
    }

    /// Records a failure, so later calls report it instead of going on.
    fn track<T>(&mut self, r: Result<T>) -> Result<T> {
        if r.is_err() {
            self.state = State::Failed;
        }
        r
    }

    /// Feeds input samples and passes every output sample that is ready to
    /// `out`, a slice at a time, so a huge push needs no huge buffers.
    ///
    /// # Errors
    ///
    /// `EncoderState` after [`StreamResampler::flush`] or an earlier error.
    pub fn push(&mut self, input: &[f32], mut out: impl FnMut(&[f64])) -> Result<()> {
        self.check_open()?;
        for piece in input.chunks(self.slice) {
            let r = self.push_piece(piece);
            self.track(r)?;
            out(&self.out);
            self.out.clear();
        }
        Ok(())
    }

    fn push_piece(&mut self, input: &[f32]) -> Result<()> {
        let out = &mut self.out;
        let mut buf = std::mem::take(&mut self.scratch);
        buf.clear();
        buf.append(&mut self.partial);
        buf.extend(input.iter().map(|&v| sanitize(f64::from(v))));
        let whole = buf.len() - buf.len() % self.channels;
        self.partial.extend_from_slice(&buf[whole..]);
        buf.truncate(whole);
        let r = if let Some(r) = &mut self.inner {
            r.push(&buf, out)
        } else {
            out.extend_from_slice(&buf);
            Ok(())
        };
        self.scratch = buf;
        r
    }

    /// Ends the input, treating what follows as silence, and passes the
    /// remaining output to `out`. The total output is
    /// `ceil(frames_in * out / in)` frames.
    ///
    /// # Errors
    ///
    /// `EncoderState` if already flushed or after an earlier error, and
    /// `InvalidOptions` if the input ends inside a sample frame, as in
    /// `encode()`.
    pub fn flush(&mut self, mut out: impl FnMut(&[f64])) -> Result<()> {
        self.check_open()?;
        let r = if self.partial.is_empty() {
            match &mut self.inner {
                Some(r) => r.finish(&mut self.out),
                None => Ok(()),
            }
        } else {
            err(
                ErrorCode::InvalidOptions,
                format!(
                    "the input ends inside a sample frame ({} of {} samples)",
                    self.partial.len(),
                    self.channels
                ),
            )
        };
        out(&self.out);
        self.partial = Vec::new();
        self.scratch = Vec::new();
        self.out = Vec::new();
        self.inner = None;
        self.state = State::Flushed;
        self.track(r)
    }
}

/// Encodes a continuous recording as a series of standalone FLAC files.
///
/// Resampling and requantizing (with dither, if enabled) run continuously
/// across the files; each file then encodes its samples losslessly. The
/// decoded files joined together equal the decoding of one `encode()` of
/// the whole signal with the same options.
pub struct ChunkEncoder {
    resampler: StreamResampler,
    requant: Requantizer,
    /// Options for each file: no resampling, no dither, buffered output.
    file_opts: Options,
    spec: PcmSpec,
    bits: u32,
    /// Interleaved quantized samples not yet in a file.
    pending: Vec<i32>,
    chunk_frames: Option<usize>,
    state: State,
}

impl ChunkEncoder {
    /// Creates a chunk encoder for `channels` of interleaved float input at
    /// `input_rate` Hz. `opts.sample_rate` sets the output rate (default: the
    /// input rate) and `opts.bits_per_sample` is required. With
    /// `chunk_frames`, files are cut at exactly that many sample frames.
    ///
    /// # Errors
    ///
    /// The errors of [`Options::validate`] and [`StreamResampler::new`];
    /// `UnsupportedFormat` without `bits_per_sample`; `InvalidOptions` for a
    /// `chunk_frames` below 16 (FLAC's smallest block) or a streaming output
    /// mode.
    pub fn new(
        input_rate: u32,
        channels: u16,
        opts: Options,
        chunk_frames: Option<usize>,
    ) -> Result<Self> {
        opts.validate()?;
        if opts.mode != OutputMode::Buffered {
            return err(
                ErrorCode::InvalidOptions,
                "a chunk encoder writes complete files; streaming output is not supported",
            );
        }
        if chunk_frames.is_some_and(|n| n < MIN_BLOCK_SIZE) {
            return err(
                ErrorCode::InvalidOptions,
                format!("chunkSamples must be at least {MIN_BLOCK_SIZE}"),
            );
        }
        let output_rate = opts.sample_rate.unwrap_or(input_rate);
        let resampler =
            StreamResampler::new(input_rate, output_rate, channels, opts.resample_quality)?;
        let Some(bits) = opts.bits_per_sample else {
            return err(
                ErrorCode::UnsupportedFormat,
                "float input cannot be stored losslessly in FLAC; \
                 set bitsPerSample (e.g. 16 or 24) to convert",
            );
        };
        // Each file holds samples already at `bits`, in the smallest PCM
        // container. Converting from a wider container is an exact shift,
        // so the dither off here changes nothing.
        let format = match bits {
            ..=16 => PcmFormat::S16,
            17..=24 => PcmFormat::S24,
            _ => PcmFormat::S32,
        };
        let requant = Requantizer::new(bits, opts.dither, opts.dither_seed);
        let file_opts = Options {
            sample_rate: None,
            bits_per_sample: Some(bits),
            dither: Dither::None,
            max_input_bytes: None,
            ..opts
        };
        Ok(Self {
            requant,
            file_opts,
            spec: PcmSpec {
                format,
                channels,
                sample_rate: output_rate,
            },
            bits,
            pending: Vec::new(),
            chunk_frames,
            resampler,
            state: State::Open,
        })
    }

    fn check_open(&self) -> Result<()> {
        match self.state {
            State::Open => Ok(()),
            State::Flushed | State::Finishing => {
                err(ErrorCode::EncoderState, "chunk encoder already finished")
            }
            State::Failed => err(
                ErrorCode::EncoderState,
                "chunk encoder failed earlier and cannot be reused",
            ),
        }
    }

    fn track<T>(&mut self, r: Result<T>) -> Result<T> {
        if r.is_err() {
            self.state = State::Failed;
            self.pending = Vec::new();
        }
        r
    }

    /// Feeds interleaved input samples.
    ///
    /// # Errors
    ///
    /// `EncoderState` after [`ChunkEncoder::finish`] or an earlier error.
    pub fn push(&mut self, input: &[f32]) -> Result<()> {
        self.check_open()?;
        let (requant, pending) = (&mut self.requant, &mut self.pending);
        let r = self.resampler.push(input, |s| requant.run(s, pending));
        self.track(r)
    }

    /// Cuts the files that are ready. Without `chunk_frames`: one file of
    /// every pending frame, or none if nothing is pending. With it: the
    /// complete files; the rest stays pending. A call stops after the file
    /// that brings its output to 64 MiB and leaves the rest pending too, so
    /// call it until it returns none.
    ///
    /// # Errors
    ///
    /// `EncoderState` after [`ChunkEncoder::finish`] or an earlier error,
    /// or an encoding error.
    pub fn cut(&mut self) -> Result<Vec<Vec<u8>>> {
        self.check_open()?;
        let r = self.cut_inner(false);
        self.track(r)
    }

    /// Ends the input on the first call and returns the last files: the
    /// pending complete files and then the remainder (shorter, or of any
    /// length without `chunk_frames`). Like [`ChunkEncoder::cut`], call it
    /// until it returns none; after that, every call fails.
    ///
    /// # Errors
    ///
    /// `EncoderState` once it has returned no file, or after an earlier
    /// error, `InvalidOptions` if the input ends inside a sample frame, or an
    /// encoding error.
    pub fn finish(&mut self) -> Result<Vec<Vec<u8>>> {
        if self.state != State::Finishing {
            self.check_open()?;
            let (requant, pending) = (&mut self.requant, &mut self.pending);
            let r = self.resampler.flush(|s| requant.run(s, pending));
            self.track(r)?;
            self.state = State::Finishing;
        }
        let r = self.cut_inner(true);
        let files = self.track(r)?;
        if files.is_empty() {
            self.state = State::Flushed;
            self.pending = Vec::new();
        }
        Ok(files)
    }

    /// Encodes the next files: the complete ones and, if `last`, a shorter
    /// remainder. Stops after the file that brings the output to `CUT_BYTES`.
    fn cut_inner(&mut self, last: bool) -> Result<Vec<Vec<u8>>> {
        let ch = usize::from(self.spec.channels);
        let frames = self.pending.len() / ch;
        // Without `chunk_frames`, one file of everything.
        let n = self.chunk_frames.unwrap_or(frames);
        let (mut files, mut at, mut bytes) = (Vec::new(), 0, 0);
        while bytes < CUT_BYTES {
            let size = n.min(frames - at);
            if size == 0 || (size < n && !last) {
                break;
            }
            let file = self.encode_file(&self.pending[at * ch..(at + size) * ch])?;
            bytes += file.len();
            files.push(file);
            at += size;
        }
        self.pending.drain(..at * ch);
        Ok(files)
    }

    /// Encodes quantized samples as one FLAC file.
    fn encode_file(&self, samples: &[i32]) -> Result<Vec<u8>> {
        let width = self.spec.format.bytes();
        let shift = (width * 8) as u32 - self.bits;
        let mut bytes = Vec::with_capacity(samples.len() * width);
        for &s in samples {
            bytes.extend_from_slice(&(s << shift).to_le_bytes()[..width]);
        }
        let mut enc =
            Encoder::new_pcm(self.file_opts.clone(), self.spec, Some(bytes.len() as u64))?;
        let frames = enc.push(&bytes)?;
        let f = enc.finish()?;
        let mut out = f.header;
        // Exact: `reserve` could double a header of up to 32 MiB of padding.
        out.reserve_exact(frames.len() + f.tail.len());
        out.extend_from_slice(&frames);
        out.extend_from_slice(&f.tail);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg_attr(miri, ignore = "seconds natively, hours under Miri")]
    fn a_huge_push_needs_no_huge_buffers() {
        let input = vec![0.25f32; 16 * PUSH_SLICE + 3];
        let q = ResampleQuality::Fast;
        // 256× up: each slice's output reaches the caller on its own.
        let mut r = StreamResampler::new(1000, 256_000, 2, q).unwrap();
        let (mut total, mut largest) = (0, 0);
        r.push(&input[..2 * PUSH_SLICE + 3], |s| {
            total += s.len();
            largest = largest.max(s.len());
        })
        .unwrap();
        assert!(total > 256 * PUSH_SLICE, "{total}");
        assert!(largest <= 8 * PUSH_SLICE, "{largest}");
        assert!(r.scratch.capacity() <= 2 * PUSH_SLICE);
        assert!(r.out.capacity() <= 16 * PUSH_SLICE, "{}", r.out.capacity());
        let opts = Options {
            sample_rate: Some(16000),
            bits_per_sample: Some(16),
            resample_quality: q,
            ..Options::default()
        };
        let mut c = ChunkEncoder::new(48000, 2, opts, None).unwrap();
        c.push(&input).unwrap();
        assert!(c.resampler.out.capacity() <= PUSH_SLICE);
        assert!(c.resampler.scratch.capacity() <= 2 * PUSH_SLICE);
    }

    #[test]
    fn a_high_ratio_push_bounds_buffer_capacity() {
        // 1 -> 256 Hz: a PUSH_SLICE of input would be ~16.7M output samples.
        let input = vec![0.25f32; PUSH_SLICE];
        let mut r = StreamResampler::new(1, 256, 1, ResampleQuality::Fast).unwrap();
        let (mut total, mut largest) = (0, 0);
        r.push(&input, |s| {
            total += s.len();
            largest = largest.max(s.len());
        })
        .unwrap();
        assert!(total > 200 * PUSH_SLICE, "{total}");
        assert!(largest <= 8 * PUSH_SLICE, "{largest}");
        assert!(r.out.capacity() <= 16 * PUSH_SLICE, "{}", r.out.capacity());
        assert!(r.scratch.capacity() <= 2 * PUSH_SLICE);
    }
}
