// SPDX-License-Identifier: 0BSD
//! WebAssembly bindings (wasm-bindgen). Thin by design: the JS layer
//! (`js/`) checks option *types* and passes plain values; all range checks
//! and all encoding happen in the Rust core.
//!
//! Errors cross the boundary as `JsError` whose message is
//! `"[CODE] message"`; the JS layer turns that into `Wav2FlacError`.

use crate::encoder::{Encoder, WavInfo};
use crate::error::{Error, ErrorCode};
use crate::options::{Dither, Options, OutputMode, ResampleQuality, Tags};
use crate::riff::SampleFormat;
use wasm_bindgen::prelude::*;

fn js_err(e: &Error) -> JsError {
    JsError::new(&format!("[{}] {}", e.code().as_str(), e.message()))
}

fn invalid(message: String) -> JsError {
    js_err(&Error::new(ErrorCode::InvalidOptions, message))
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
    /// `max_input_bytes`) for "not set". `tag_keys`/`tag_values` are parallel.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        compression_level: u8,
        block_size: u32,
        sample_rate: u32,
        resample_quality: u8,
        bits_per_sample: u32,
        dither: bool,
        dither_seed: f64,
        tags_enabled: bool,
        tag_keys: Vec<String>,
        tag_values: Vec<String>,
        seek_point_interval: f64,
        padding: u32,
        max_input_bytes: f64,
        streaming: bool,
    ) -> Result<WasmEncoder, JsError> {
        if tag_keys.len() != tag_values.len() {
            return Err(invalid(format!(
                "tag keys and values differ in length ({} vs {})",
                tag_keys.len(),
                tag_values.len()
            )));
        }
        let opts = Options {
            compression_level,
            block_size: (block_size != 0).then_some(block_size as usize),
            sample_rate: (sample_rate != 0).then_some(sample_rate),
            resample_quality: match resample_quality {
                0 => ResampleQuality::Fast,
                2 => ResampleQuality::Best,
                _ => ResampleQuality::Balanced,
            },
            bits_per_sample: (bits_per_sample != 0).then_some(bits_per_sample),
            dither: if dither { Dither::Tpdf } else { Dither::None },
            dither_seed: dither_seed as u64,
            tags: if tags_enabled {
                Tags::FromWav(tag_keys.into_iter().zip(tag_values).collect())
            } else {
                Tags::Disabled
            },
            seek_point_interval,
            padding,
            max_input_bytes: (max_input_bytes >= 0.0).then_some(max_input_bytes as u64),
            mode: if streaming {
                OutputMode::Streaming
            } else {
                OutputMode::Buffered
            },
        };
        Ok(Self {
            inner: Encoder::new(opts).map_err(|e| js_err(&e))?,
            header: Vec::new(),
        })
    }

    /// Feeds WAV bytes; returns FLAC bytes that became available (may be empty).
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
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn info_to_json(i: &WavInfo) -> String {
    let mut s = format!(
        "{{\"sampleRate\":{},\"channels\":{},\"bitsPerSample\":{},\"format\":\"{}\",\"frames\":{},\"durationSec\":{},\"channelMask\":{},\"tags\":{{",
        i.sample_rate,
        i.channels,
        i.bits_per_sample,
        match i.format {
            SampleFormat::Int => "int",
            SampleFormat::Float => "float",
        },
        i.frames,
        i.duration_sec,
        i.channel_mask.map_or_else(|| "null".to_owned(), |m| m.to_string()),
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
