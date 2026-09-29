// SPDX-License-Identifier: 0BSD
//! Encoder options. Compression levels 0–8 are libFLAC's presets
//! (implemented bit-exactly by libflac-rs).

use crate::error::{err, ErrorCode, Result};

/// Smallest block size libFLAC accepts.
pub const MIN_BLOCK_SIZE: usize = 16;
/// Largest block size a FLAC frame header can express.
pub const MAX_BLOCK_SIZE: usize = 65535;
/// Bit depth range FLAC supports.
pub const MIN_BITS: u32 = 4;
/// Bit depth range FLAC supports.
pub const MAX_BITS: u32 = 32;

/// Highest supported compression level.
pub const MAX_LEVEL: u8 = 8;
/// Level used when none is given.
pub const DEFAULT_LEVEL: u8 = 5;
/// Default distance between seek points, in seconds.
pub const DEFAULT_SEEK_POINT_INTERVAL: f64 = 10.0;
/// Default size of the PADDING metadata block, in bytes.
pub const DEFAULT_PADDING: u32 = 8192;
/// Largest PADDING block we allow (FLAC metadata block length is 24 bits).
pub const MAX_PADDING: u32 = (1 << 24) - 1;

/// Whether the FLAC header is emitted first (streaming) or last (buffered).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OutputMode {
    /// The header is produced by `finish()` with exact totals, MD5 and a
    /// seek table. The caller prepends it to the frames.
    #[default]
    Buffered,
    /// The header is emitted before the first frame; total samples and MD5
    /// are left as "unknown" (zero), no seek table is written, and tags in
    /// chunks after the data chunk are dropped.
    Streaming,
}

/// Quality preset for the resampler.
///
/// The passband is measured against the lower of the two Nyquist rates
/// (22.05 kHz for 44.1 kHz ↔ 48 kHz). Downsampling lengthens the filter, so
/// all presets are flat to about 90 % of it. Upsampling uses the preset's
/// base length: `Fast` and `Balanced` are flat to about 80 % and roll off
/// above (at 20 kHz, 44.1 → 48 kHz: −4 dB and −10 dB), `Best` is flat to 90 %.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ResampleQuality {
    /// Short filter (64 taps); fastest; stop band at least 60 dB down.
    Fast,
    /// Default trade-off (128 taps); stop band at least 90 dB down.
    #[default]
    Balanced,
    /// Long filter (256 taps); flattest passband; stop band at least
    /// 110 dB down.
    Best,
}

/// Dither applied when samples are requantized: when reducing the bit depth,
/// converting float input or resampling. Lossless paths never dither.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Dither {
    /// Triangular-PDF dither (±1 LSB). The default.
    #[default]
    Tpdf,
    /// Plain rounding.
    None,
}

/// How Vorbis comments are produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tags {
    /// Copy tags from the WAV `LIST/INFO` chunk, then apply these overrides
    /// (an empty value removes a field).
    FromWav(Vec<(String, String)>),
    /// Write no tags except the channel-mask field when it is required.
    Disabled,
}

impl Default for Tags {
    fn default() -> Self {
        Self::FromWav(Vec::new())
    }
}

/// All encoder options. `Default` gives lossless level-5 encoding.
#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    /// Compression level 0 (fastest) ..= 8 (smallest).
    pub compression_level: u8,
    /// Block size override (16..=65535). `None` uses the level's block size.
    pub block_size: Option<usize>,
    /// Target sample rate. `None` keeps the input rate.
    pub sample_rate: Option<u32>,
    /// Resampler quality, used only when resampling.
    pub resample_quality: ResampleQuality,
    /// Target bits per sample (4..=32). `None` keeps the input depth.
    pub bits_per_sample: Option<u32>,
    /// Dither used when samples are requantized (see [`Dither`]).
    pub dither: Dither,
    /// Seed of the dither noise generator (deterministic output).
    pub dither_seed: u64,
    /// Vorbis comment handling.
    pub tags: Tags,
    /// Seconds between seek points (buffered mode); 0 disables the seek table.
    pub seek_point_interval: f64,
    /// Size of the PADDING block in bytes; 0 disables it.
    pub padding: u32,
    /// Maximum accepted input size in bytes.
    pub max_input_bytes: Option<u64>,
    /// Header placement.
    pub mode: OutputMode,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            compression_level: DEFAULT_LEVEL,
            block_size: None,
            sample_rate: None,
            resample_quality: ResampleQuality::default(),
            bits_per_sample: None,
            dither: Dither::default(),
            dither_seed: 0x5EED_F1AC,
            tags: Tags::default(),
            seek_point_interval: DEFAULT_SEEK_POINT_INTERVAL,
            padding: DEFAULT_PADDING,
            max_input_bytes: None,
            mode: OutputMode::default(),
        }
    }
}

/// Highest sample rate FLAC can store in STREAMINFO (20 bits).
pub const MAX_SAMPLE_RATE: u32 = (1 << 20) - 1;

impl Options {
    /// Checks every option for range and consistency.
    ///
    /// # Errors
    ///
    /// `InvalidOptions` describing the first offending option.
    pub fn validate(&self) -> Result<()> {
        if self.compression_level > MAX_LEVEL {
            return err(
                ErrorCode::InvalidOptions,
                format!("compressionLevel must be 0..={MAX_LEVEL}"),
            );
        }
        if let Some(bs) = self.block_size {
            if !(MIN_BLOCK_SIZE..=MAX_BLOCK_SIZE).contains(&bs) {
                return err(
                    ErrorCode::InvalidOptions,
                    format!("blockSize must be {MIN_BLOCK_SIZE}..={MAX_BLOCK_SIZE}"),
                );
            }
        }
        if let Some(sr) = self.sample_rate {
            if sr == 0 || sr > MAX_SAMPLE_RATE {
                return err(
                    ErrorCode::InvalidOptions,
                    format!("sampleRate must be 1..={MAX_SAMPLE_RATE}"),
                );
            }
        }
        if let Some(b) = self.bits_per_sample {
            if !(MIN_BITS..=MAX_BITS).contains(&b) {
                return err(
                    ErrorCode::InvalidOptions,
                    format!("bitsPerSample must be {MIN_BITS}..={MAX_BITS}"),
                );
            }
        }
        if !self.seek_point_interval.is_finite() || self.seek_point_interval < 0.0 {
            return err(
                ErrorCode::InvalidOptions,
                "seekPointInterval must be a finite number >= 0",
            );
        }
        if self.padding > MAX_PADDING {
            return err(
                ErrorCode::InvalidOptions,
                format!("padding must be 0..={MAX_PADDING}"),
            );
        }
        if let Tags::FromWav(overrides) = &self.tags {
            for (k, _) in overrides {
                validate_tag_key(k)?;
            }
        }
        Ok(())
    }

    /// Block size in effect (override or the level's default).
    #[must_use]
    pub fn effective_block_size(&self) -> usize {
        self.block_size.unwrap_or(if self.compression_level <= 2 {
            1152
        } else {
            4096
        })
    }
}

/// Vorbis field names: printable ASCII 0x20..=0x7D except '='.
///
/// # Errors
///
/// `InvalidOptions` for an empty or illegal key.
pub fn validate_tag_key(k: &str) -> Result<()> {
    if k.is_empty() || !k.bytes().all(|b| (0x20..=0x7D).contains(&b) && b != b'=') {
        return err(
            ErrorCode::InvalidOptions,
            format!("invalid tag name {k:?} (ASCII 0x20-0x7D, no '=')"),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_levels_verify() {
        for level in 0..=MAX_LEVEL {
            let o = Options {
                compression_level: level,
                ..Options::default()
            };
            o.validate().unwrap();
        }
    }

    #[test]
    fn rejects_bad_values() {
        let bad = [
            Options {
                compression_level: 9,
                ..Options::default()
            },
            Options {
                block_size: Some(15),
                ..Options::default()
            },
            Options {
                block_size: Some(65536),
                ..Options::default()
            },
            Options {
                sample_rate: Some(0),
                ..Options::default()
            },
            Options {
                bits_per_sample: Some(33),
                ..Options::default()
            },
            Options {
                bits_per_sample: Some(3),
                ..Options::default()
            },
            Options {
                seek_point_interval: f64::NAN,
                ..Options::default()
            },
            Options {
                tags: Tags::FromWav(vec![("A=B".into(), "x".into())]),
                ..Options::default()
            },
        ];
        for o in bad {
            assert_eq!(
                o.validate().unwrap_err().code(),
                ErrorCode::InvalidOptions,
                "{o:?}"
            );
        }
    }
}
