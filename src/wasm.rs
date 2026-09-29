// SPDX-License-Identifier: 0BSD
//! WebAssembly bindings (wasm-bindgen). Thin by design: the TypeScript layer
//! (`ts/`) validates the options and passes plain numbers; this layer checks
//! again that every number is an integer in range (wasm-bindgen would wrap
//! or truncate it silently), and the Rust core checks option semantics.
//!
//! Errors cross the boundary as `JsError` whose message is
//! `"[CODE] message"`; the JS layer turns that into `Wav2FlacError`.

use crate::encoder::{Encoder, WavInfo};
use crate::error::{Error, ErrorCode};
use crate::options::{Dither, Options, OutputMode, ResampleQuality, Tags};
use crate::pcm::{PcmFormat, PcmSpec};
use crate::riff::SampleFormat;
use std::fmt::Write;
use wasm_bindgen::prelude::*;

fn invalid(message: String) -> JsError {
    js_err(&Error::new(ErrorCode::InvalidOptions, message))
}

/// Converts a JS number to an integer in `0..=max`; `NaN`, fractions and
/// out-of-range values are rejected rather than wrapped.
fn int(name: &str, v: f64, max: u64) -> Result<u64, JsError> {
    if v.fract() == 0.0 && (0.0..=max as f64).contains(&v) {
        Ok(v as u64)
    } else {
        Err(invalid(format!(
            "{name} must be an integer from 0 to {max}, got {v}"
        )))
    }
}

/// [`int`] for values that fit in `u32`.
fn int32(name: &str, v: f64) -> Result<u32, JsError> {
    int(name, v, u64::from(u32::MAX)).map(|n| n as u32)
}

/// Largest integer a JS number holds exactly.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn js_err(e: &Error) -> JsError {
    JsError::new(&format!("[{}] {}", e.code().as_str(), e.message()))
}

/// Streaming encoder handle. Must be released with `free()`.
#[wasm_bindgen]
pub struct WasmEncoder {
    inner: Encoder,
    header: Vec<u8>,
}

#[wasm_bindgen]
impl WasmEncoder {
    /// Creates an encoder. Optional numbers use 0 (or a negative value for
    /// `max_input_bytes` and `pcm_total_bytes`) for "not set"; every number
    /// must be an integer except `seek_point_interval`. `tag_keys`/`tag_values` are parallel.
    /// `pcm_format` 0 means WAV input; 1–5 select raw PCM (u8, s16, s24, s32,
    /// f32) with `pcm_channels`/`pcm_rate`, and `pcm_total_bytes` < 0 for an
    /// unknown length.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        compression_level: f64,
        block_size: f64,
        sample_rate: f64,
        resample_quality: u8,
        bits_per_sample: f64,
        dither: bool,
        dither_seed: f64,
        tags_enabled: bool,
        tag_keys: Vec<String>,
        tag_values: Vec<String>,
        seek_point_interval: f64,
        padding: f64,
        max_input_bytes: f64,
        streaming: bool,
        pcm_format: u8,
        pcm_channels: f64,
        pcm_rate: f64,
        pcm_total_bytes: f64,
    ) -> Result<WasmEncoder, JsError> {
        if tag_keys.len() != tag_values.len() {
            return Err(invalid(format!(
                "tag keys and values differ in length ({} vs {})",
                tag_keys.len(),
                tag_values.len()
            )));
        }
        let block_size = int32("blockSize", block_size)?;
        let sample_rate = int32("sampleRate", sample_rate)?;
        let bits_per_sample = int32("bitsPerSample", bits_per_sample)?;
        let unset_or = |name, v: f64| {
            if v < 0.0 {
                Ok(None)
            } else {
                int(name, v, MAX_SAFE_INTEGER).map(Some)
            }
        };
        let opts = Options {
            compression_level: int("compressionLevel", compression_level, 255)? as u8,
            block_size: (block_size != 0).then_some(block_size as usize),
            sample_rate: (sample_rate != 0).then_some(sample_rate),
            resample_quality: match resample_quality {
                0 => ResampleQuality::Fast,
                2 => ResampleQuality::Best,
                _ => ResampleQuality::Balanced,
            },
            bits_per_sample: (bits_per_sample != 0).then_some(bits_per_sample),
            dither: if dither { Dither::Tpdf } else { Dither::None },
            dither_seed: int("ditherSeed", dither_seed, MAX_SAFE_INTEGER)?,
            tags: if tags_enabled {
                Tags::FromWav(tag_keys.into_iter().zip(tag_values).collect())
            } else {
                Tags::Disabled
            },
            seek_point_interval,
            padding: int32("padding", padding)?,
            max_input_bytes: unset_or("maxInputBytes", max_input_bytes)?,
            mode: if streaming {
                OutputMode::Streaming
            } else {
                OutputMode::Buffered
            },
        };
        let format = match pcm_format {
            0 => None,
            1 => Some(PcmFormat::U8),
            2 => Some(PcmFormat::S16),
            3 => Some(PcmFormat::S24),
            4 => Some(PcmFormat::S32),
            5 => Some(PcmFormat::F32),
            n => return Err(invalid(format!("unknown pcm format code {n}"))),
        };
        let inner = match format {
            None => Encoder::new(opts),
            Some(format) => {
                let spec = PcmSpec {
                    format,
                    channels: int("pcm.channels", pcm_channels, u64::from(u16::MAX))? as u16,
                    sample_rate: int32("pcm.sampleRate", pcm_rate)?,
                };
                let total = unset_or("pcm total length", pcm_total_bytes)?;
                Encoder::new_pcm(opts, spec, total)
            }
        };
        Ok(Self {
            inner: inner.map_err(|e| js_err(&e))?,
            header: Vec::new(),
        })
    }

    /// Feeds input bytes; returns FLAC bytes that became available (may be empty).
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.push(bytes).map_err(|e| js_err(&e))
    }

    /// Ends the input. Returns the remaining frame bytes; in buffered mode the
    /// header is then available from `takeHeader()`.
    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        let f = self.inner.finish().map_err(|e| js_err(&e))?;
        self.header = f.header;
        Ok(f.tail)
    }

    /// The final header (buffered mode), after `finish()`. Empty otherwise.
    #[wasm_bindgen(js_name = takeHeader)]
    pub fn take_header(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.header)
    }

    /// Input bytes pushed so far.
    #[wasm_bindgen(js_name = bytesIn)]
    pub fn bytes_in(&self) -> f64 {
        self.inner.progress().bytes_in as f64
    }

    /// Output samples per channel encoded so far.
    #[wasm_bindgen(js_name = samplesOut)]
    pub fn samples_out(&self) -> f64 {
        self.inner.progress().samples_out as f64
    }

    /// Fraction of the data chunk consumed, or NaN before the header is known.
    pub fn fraction(&self) -> f64 {
        self.inner.progress().fraction.unwrap_or(f64::NAN)
    }

    /// Input description as JSON once the header is parsed, else empty string.
    #[wasm_bindgen(js_name = infoJson)]
    pub fn info_json(&self) -> String {
        self.inner
            .info()
            .map_or_else(String::new, |i| info_to_json(&i))
    }
}

/// Parses a WAV header and returns its description as JSON.
#[wasm_bindgen(js_name = probeJson)]
pub fn probe_json(bytes: &[u8]) -> Result<String, JsError> {
    crate::encoder::probe(bytes)
        .map(|i| info_to_json(&i))
        .map_err(|e| js_err(&e))
}

/// Crate version and encoder backend.
#[wasm_bindgen]
pub fn vendor() -> String {
    crate::encoder::VENDOR.to_owned()
}

fn json_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            // Writing to a String cannot fail.
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn info_to_json(i: &WavInfo) -> String {
    let mut s = format!(
        "{{\"sampleRate\":{},\"channels\":{},\"bitsPerSample\":{},\"format\":\"{}\",\
         \"frames\":{},\"durationSec\":{},\"channelMask\":{},\"tags\":{{",
        i.sample_rate,
        i.channels,
        i.bits_per_sample,
        match i.format {
            SampleFormat::Int => "int",
            SampleFormat::Float => "float",
        },
        i.frames,
        i.duration_sec,
        i.channel_mask
            .map_or_else(|| "null".to_owned(), |m| m.to_string()),
    );
    for (n, (k, v)) in i.tags.iter().enumerate() {
        if n > 0 {
            s.push(',');
        }
        json_str(k, &mut s);
        s.push(':');
        json_str(v, &mut s);
    }
    s.push_str("}}");
    s
}
