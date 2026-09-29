// SPDX-License-Identifier: 0BSD
//! Streaming sample-rate conversion on top of rubato's sinc resampler.
//!
//! Input is pushed in arbitrary amounts; it is processed in fixed internal
//! chunks so the output never depends on how the caller split the input.
//! The resampler's start-up delay is trimmed and the tail is flushed on
//! [`Resample::finish`], giving exactly `ceil(n_in * out / in)` frames.

use crate::error::{Error, ErrorCode, Result};
use crate::options::ResampleQuality;
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{
    Async, FixedAsync, Indexing, Resampler, SincInterpolationParameters, SincInterpolationType,
    WindowFunction,
};

/// Input frames per internal processing chunk.
const CHUNK_FRAMES: usize = 1024;

/// Largest supported upsampling factor. Larger ratios make rubato's sinc
/// tables and per-chunk output grow without bound (a 1 Hz header resampled
/// to 48 kHz needs over a gigabyte).
pub const MAX_UPSAMPLE_RATIO: u32 = 256;

/// Largest supported downsampling factor. Flushing the filter at the end
/// feeds silence until the first output frame appears, which takes about
/// `ratio / 1024` chunks: an unbounded ratio (a 4 GHz header resampled to
/// 1 Hz) would spin for seconds regardless of the input size.
pub const MAX_DOWNSAMPLE_RATIO: u32 = 1 << 16;

fn map_err(e: impl std::fmt::Display) -> Error {
    Error::new(ErrorCode::Internal, format!("resampler: {e}"))
}

/// Largest factor by which downsampling lengthens the sinc filter.
const MAX_DOWNSAMPLE_STRETCH: usize = 4;

/// Sinc length (taps, in input samples) of each preset at `ratio` (output
/// rate / input rate). Downsampling lowers the cutoff by `ratio`, which
/// widens the transition band by the same factor for a fixed length; the
/// filter is lengthened to keep it (up to [`MAX_DOWNSAMPLE_STRETCH`]x).
fn sinc_len(q: ResampleQuality, ratio: f64) -> usize {
    let base = match q {
        ResampleQuality::Fast => 64,
        ResampleQuality::Balanced => 128,
        ResampleQuality::Best => 256,
    };
    let stretch = if ratio < 1.0 {
        ((1.0 / ratio).ceil() as usize).clamp(1, MAX_DOWNSAMPLE_STRETCH)
    } else {
        1
    };
    base * stretch
}

/// Filter parameters for a quality preset.
fn parameters(q: ResampleQuality, ratio: f64) -> SincInterpolationParameters {
    let len = sinc_len(q, ratio);
    match q {
        ResampleQuality::Fast => SincInterpolationParameters::new(len, WindowFunction::Hann2)
            .oversampling_factor(64)
            .interpolation(SincInterpolationType::Linear),
        ResampleQuality::Balanced => {
            SincInterpolationParameters::new(len, WindowFunction::BlackmanHarris2)
                .oversampling_factor(128)
                .interpolation(SincInterpolationType::Cubic)
        }
        ResampleQuality::Best => {
            SincInterpolationParameters::new(len, WindowFunction::BlackmanHarris2)
                .oversampling_factor(256)
                .interpolation(SincInterpolationType::Cubic)
        }
    }
}

/// A streaming resampler for interleaved `f64` samples.
pub struct Resample {
    inner: Async<f64>,
    channels: usize,
    /// Input rate.
    from: u32,
    /// Output rate.
    to: u32,
    /// Interleaved input not yet processed.
    pending: Vec<f64>,
    /// Frames pushed in total.
    frames_in: u64,
    /// Frames emitted in total (after trimming the delay).
    frames_out: u64,
    /// Output frames still to drop (resampler delay).
    to_trim: usize,
}

impl Resample {
    /// Creates a resampler from `from` Hz to `to` Hz.
    ///
    /// # Errors
    ///
    /// `InvalidOptions` if a rate is zero, the output rate is more than
    /// [`MAX_UPSAMPLE_RATIO`] times (or the input rate is more than
    /// [`MAX_DOWNSAMPLE_RATIO`] times the output rate), or rubato rejects the ratio.
    pub fn new(from: u32, to: u32, channels: usize, quality: ResampleQuality) -> Result<Self> {
        if from == 0 || to == 0 {
            return Err(Error::new(
                ErrorCode::InvalidOptions,
                "sample rates must be positive",
            ));
        }
        if u64::from(to) > u64::from(from) * u64::from(MAX_UPSAMPLE_RATIO) {
            return Err(Error::new(
                ErrorCode::InvalidOptions,
                format!(
                    "cannot resample {from} Hz to {to} Hz: \
                     at most {MAX_UPSAMPLE_RATIO}x upsampling is supported"
                ),
            ));
        }
        if u64::from(from) > u64::from(to) * u64::from(MAX_DOWNSAMPLE_RATIO) {
            return Err(Error::new(
                ErrorCode::InvalidOptions,
                format!(
                    "cannot resample {from} Hz to {to} Hz: \
                     at most {MAX_DOWNSAMPLE_RATIO}x downsampling is supported"
                ),
            ));
        }
        let ratio = f64::from(to) / f64::from(from);
        let inner = Async::<f64>::new_sinc(
            ratio,
            1.0,
            &parameters(quality, ratio),
            CHUNK_FRAMES,
            channels,
            FixedAsync::Input,
        )
        .map_err(|e| Error::new(ErrorCode::InvalidOptions, format!("resampler: {e}")))?;
        // The filter's group delay in output frames. rubato's `output_delay()`
        // truncates `len * ratio / 2`, which is about one frame too late; trim
        // the true delay rounded to the nearest frame.
        let delay = sinc_len(quality, ratio) as f64 * ratio / 2.0 - 1.0;
        let to_trim = delay.round().max(0.0) as usize;
        Ok(Self {
            inner,
            channels,
            from,
            to,
            pending: Vec::new(),
            frames_in: 0,
            frames_out: 0,
            to_trim,
        })
    }

    fn emit(&mut self, data: &[f64], out: &mut Vec<f64>) {
        let frames = data.len() / self.channels;
        let skip = self.to_trim.min(frames);
        self.to_trim -= skip;
        out.extend_from_slice(&data[skip * self.channels..]);
        self.frames_out += (frames - skip) as u64;
    }

    fn run(&mut self, input: &[f64], partial: Option<usize>, out: &mut Vec<f64>) -> Result<()> {
        let need = self.inner.input_frames_next();
        let frames = input.len() / self.channels;
        let adapter = InterleavedSlice::new(input, self.channels, frames).map_err(map_err)?;
        let indexing = Indexing {
            partial_len: partial,
            ..Indexing::default()
        };
        debug_assert!(partial.is_some() || frames >= need);
        let buf = self
            .inner
            .process(&adapter, Some(&indexing))
            .map_err(map_err)?;
        let data = buf.take_data();
        self.emit(&data, out);
        Ok(())
    }

    /// Pushes interleaved input and appends all output that is ready.
    ///
    /// # Errors
    ///
    /// `Internal` if rubato fails (not expected).
    pub fn push(&mut self, input: &[f64], out: &mut Vec<f64>) -> Result<()> {
        self.frames_in += (input.len() / self.channels) as u64;
        self.pending.extend_from_slice(input);
        let mut consumed = 0usize;
        loop {
            let need = self.inner.input_frames_next() * self.channels;
            if self.pending.len() - consumed < need {
                break;
            }
            let chunk = std::mem::take(&mut self.pending);
            let r = self.run(&chunk[consumed..consumed + need], None, out);
            self.pending = chunk;
            r?;
            consumed += need;
        }
        self.pending.drain(..consumed);
        Ok(())
    }

    /// Number of output frames the whole stream will have.
    #[must_use]
    pub fn expected_output_frames(&self) -> u64 {
        // Exact integer ceil(frames_in * to / from); floats round up spuriously.
        let (n, to, from) = (
            u128::from(self.frames_in),
            u128::from(self.to),
            u128::from(self.from),
        );
        u64::try_from((n * to).div_ceil(from)).unwrap_or(u64::MAX)
    }

    /// Flushes the remaining input and the filter tail.
    ///
    /// # Errors
    ///
    /// `Internal` if rubato fails (not expected).
    pub fn finish(&mut self, out: &mut Vec<f64>) -> Result<()> {
        let expected = self.expected_output_frames();
        let start = out.len();
        let before = self.frames_out;
        let need = self.inner.input_frames_next();
        let pending = std::mem::take(&mut self.pending);
        let frames = pending.len() / self.channels;
        if frames > 0 {
            let mut padded = pending;
            padded.resize(need * self.channels, 0.0);
            self.run(&padded, Some(frames), out)?;
        }
        let silence = vec![0.0; self.inner.input_frames_max() * self.channels];
        // Every silent chunk moves the input on, so the output catches up
        // (a chunk can yield no frames at a very low output rate).
        while self.frames_out < expected {
            let n = self.inner.input_frames_next();
            self.run(&silence[..n * self.channels], Some(0), out)?;
        }
        // Drop what exceeds the exact expected length.
        let produced = self.frames_out - before;
        let keep = expected.saturating_sub(before).min(produced) as usize;
        out.truncate(start + keep * self.channels);
        self.frames_out = before + keep as u64;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn impulse_stays_on_time() {
        let qualities = [
            ResampleQuality::Fast,
            ResampleQuality::Balanced,
            ResampleQuality::Best,
        ];
        let rates = [
            (44100u32, 48000u32),
            (48000, 44100),
            (48000, 16000),
            (16000, 48000),
            (44100, 22050),
            (8000, 8001),
        ];
        for q in qualities {
            for (from, to) in rates {
                let k = 5000usize;
                let mut x = vec![0.0; 20000];
                x[k] = 1.0;
                let mut r = Resample::new(from, to, 1, q).unwrap();
                let mut out = Vec::new();
                r.push(&x, &mut out).unwrap();
                r.finish(&mut out).unwrap();
                // Energy centroid of the response around its peak.
                let peak = (0..out.len())
                    .max_by(|&a, &b| out[a].abs().total_cmp(&out[b].abs()))
                    .unwrap();
                let (mut sum, mut weight) = (0.0, 0.0);
                for (i, v) in out.iter().enumerate().take(peak + 40).skip(peak - 40) {
                    sum += v * v * i as f64;
                    weight += v * v;
                }
                let want = k as f64 * f64::from(to) / f64::from(from);
                let off = sum / weight - want;
                assert!(off.abs() <= 0.5, "{q:?} {from}->{to}: {off:+.3} frames");
            }
        }
    }
}
