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
use crate::stream::{ChunkEncoder, StreamResampler};
use crate::transcode::requantize::Requantizer;
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

/// [`int`] up to [`MAX_SAFE_INTEGER`], with a negative value for "not set".
fn unset_or(name: &str, v: f64) -> Result<Option<u64>, JsError> {
    if v < 0.0 {
        Ok(None)
    } else {
        int(name, v, MAX_SAFE_INTEGER).map(Some)
    }
}

fn js_err(e: &Error) -> JsError {
    JsError::new(&format!("[{}] {}", e.code().as_str(), e.message()))
}

/// Builds [`Options`] from the numbers the JS layer passes; see
/// [`WasmEncoder::new`] for their encoding.
#[allow(clippy::too_many_arguments)]
fn options(
    compression_level: f64,
    block_size: f64,
    sample_rate: f64,
    resample_quality: f64,
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
) -> Result<Options, JsError> {
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
    Ok(Options {
        compression_level: int("compressionLevel", compression_level, 255)? as u8,
        block_size: (block_size != 0).then_some(block_size as usize),
        sample_rate: (sample_rate != 0).then_some(sample_rate),
        resample_quality: quality("resampleQuality", resample_quality)?,
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
    })
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
        resample_quality: f64,
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
        pcm_format: f64,
        pcm_channels: f64,
        pcm_rate: f64,
        pcm_total_bytes: f64,
    ) -> Result<WasmEncoder, JsError> {
        let opts = options(
            compression_level,
            block_size,
            sample_rate,
            resample_quality,
            bits_per_sample,
            dither,
            dither_seed,
            tags_enabled,
            tag_keys,
            tag_values,
            seek_point_interval,
            padding,
            max_input_bytes,
            streaming,
        )?;
        let format = match int("pcm format code", pcm_format, 5)? {
            0 => None,
            1 => Some(PcmFormat::U8),
            2 => Some(PcmFormat::S16),
            3 => Some(PcmFormat::S24),
            4 => Some(PcmFormat::S32),
            _ => Some(PcmFormat::F32),
        };
        let inner = match format {
            None => Encoder::new(opts),
            Some(format) => {
                let channels = channel_count("pcm.channels", pcm_channels)?;
                let spec = PcmSpec {
                    format,
                    channels,
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

    /// Fraction of the data chunk consumed, or NaN before the header is known
    /// and for raw PCM of unknown length.
    pub fn fraction(&self) -> f64 {
        self.inner.progress().fraction.unwrap_or(f64::NAN)
    }

    /// Input description as JSON once the header is parsed, else empty string.
    /// Empty again after `finish()` or a failed call, which release the input state.
    #[wasm_bindgen(js_name = infoJson)]
    pub fn info_json(&self) -> String {
        self.inner
            .info()
            .map_or_else(String::new, |i| info_to_json(&i))
    }
}

/// Converts a JS channel count; past 8 (and past `u16`) it is too many.
fn channel_count(name: &str, v: f64) -> Result<u16, JsError> {
    let n = int(name, v, MAX_SAFE_INTEGER)?;
    u16::try_from(n).map_err(|_| {
        js_err(&Error::new(
            ErrorCode::TooManyChannels,
            format!("{n} channels (FLAC supports at most 8)"),
        ))
    })
}

/// Converts a quality number: 0 fast, 1 balanced, 2 best.
fn quality(name: &str, v: f64) -> Result<ResampleQuality, JsError> {
    Ok(match int(name, v, 2)? {
        0 => ResampleQuality::Fast,
        1 => ResampleQuality::Balanced,
        _ => ResampleQuality::Best,
    })
}

/// Resampler output, converted a slice at a time so that no `f64` copy of
/// all of it builds up.
enum Output {
    F32(Vec<f32>),
    /// As `encode()` quantizes to 16 bits with `dither: none`.
    S16(Vec<i16>, Requantizer),
}

impl Output {
    /// Room for `len` samples up front: growing a huge vector by doubling
    /// would need about three times its size.
    fn new(f32: bool, len: usize) -> Self {
        if f32 {
            Self::F32(Vec::with_capacity(len))
        } else {
            let q = Requantizer::new(16, Dither::None, 0);
            Self::S16(Vec::with_capacity(len), q)
        }
    }

    fn add(&mut self, s: &[f64]) {
        match self {
            Self::F32(v) => v.extend(s.iter().map(|&x| x as f32)),
            // A 16-bit quantizer only returns values in i16 range.
            Self::S16(v, q) => v.extend(s.iter().map(|&x| q.quantize(x) as i16)),
        }
    }

    fn into_js(self) -> JsValue {
        match self {
            Self::F32(v) => v.into(),
            Self::S16(v, _) => v.into(),
        }
    }
}

/// Stateful resampler handle. Must be released with `free()`.
#[wasm_bindgen]
pub struct WasmResampler {
    inner: StreamResampler,
    f32: bool,
    /// Output rate / input rate.
    ratio: f64,
}

#[wasm_bindgen]
impl WasmResampler {
    /// Creates a resampler; `quality` is 0 fast, 1 balanced, 2 best. The
    /// output is a `Float32Array` with `f32`, else an `Int16Array`.
    #[wasm_bindgen(constructor)]
    pub fn new(
        input_rate: f64,
        output_rate: f64,
        channels: f64,
        quality: f64,
        f32: bool,
    ) -> Result<WasmResampler, JsError> {
        let (from, to) = (
            int32("inputRate", input_rate)?,
            int32("outputRate", output_rate)?,
        );
        let inner = StreamResampler::new(
            from,
            to,
            channel_count("channels", channels)?,
            self::quality("quality", quality)?,
        )
        .map_err(|e| js_err(&e))?;
        Ok(Self {
            inner,
            f32,
            ratio: f64::from(to) / f64::from(from),
        })
    }

    /// Feeds samples; returns the output that is ready.
    pub fn push(&mut self, input: &[f32]) -> Result<JsValue, JsError> {
        // The expected output, plus an eighth for what the filter held back.
        let len = input.len() as f64 * self.ratio * 1.125;
        let mut out = Output::new(self.f32, len as usize);
        self.inner
            .push(input, |s| out.add(s))
            .map_err(|e| js_err(&e))?;
        Ok(out.into_js())
    }

    /// Ends the input; returns the remaining output.
    pub fn flush(&mut self) -> Result<JsValue, JsError> {
        let mut out = Output::new(self.f32, 0);
        self.inner.flush(|s| out.add(s)).map_err(|e| js_err(&e))?;
        Ok(out.into_js())
    }
}

/// Files as a JS array of `Uint8Array`.
fn files(r: crate::error::Result<Vec<Vec<u8>>>) -> Result<Vec<JsValue>, JsError> {
    let files = r.map_err(|e| js_err(&e))?;
    Ok(files.into_iter().map(JsValue::from).collect())
}

/// Chunk encoder handle. Must be released with `free()`.
#[wasm_bindgen]
pub struct WasmChunkEncoder {
    inner: ChunkEncoder,
}

#[wasm_bindgen]
impl WasmChunkEncoder {
    /// Creates a chunk encoder. The options are those of
    /// [`WasmEncoder::new`] (without the PCM description and output mode);
    /// `chunk_frames` < 0 means "cut where the caller asks".
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        compression_level: f64,
        block_size: f64,
        sample_rate: f64,
        resample_quality: f64,
        bits_per_sample: f64,
        dither: bool,
        dither_seed: f64,
        tags_enabled: bool,
        tag_keys: Vec<String>,
        tag_values: Vec<String>,
        seek_point_interval: f64,
        padding: f64,
        input_rate: f64,
        channels: f64,
        chunk_frames: f64,
    ) -> Result<WasmChunkEncoder, JsError> {
        let opts = options(
            compression_level,
            block_size,
            sample_rate,
            resample_quality,
            bits_per_sample,
            dither,
            dither_seed,
            tags_enabled,
            tag_keys,
            tag_values,
            seek_point_interval,
            padding,
            -1.0,
            false,
        )?;
        let chunk = match unset_or("chunkSamples", chunk_frames)? {
            None => None,
            Some(n) => Some(usize::try_from(n).map_err(|_| {
                invalid(format!(
                    "chunkSamples must be at most {}, got {n}",
                    usize::MAX
                ))
            })?),
        };
        let inner = ChunkEncoder::new(
            int32("inputRate", input_rate)?,
            channel_count("channels", channels)?,
            opts,
            chunk,
        )
        .map_err(|e| js_err(&e))?;
        Ok(Self { inner })
    }

    /// Feeds interleaved samples.
    pub fn push(&mut self, input: &[f32]) -> Result<(), JsError> {
        self.inner.push(input).map_err(|e| js_err(&e))
    }

    /// Cuts the files that are ready and returns them.
    pub fn cut(&mut self) -> Result<Vec<JsValue>, JsError> {
        files(self.inner.cut())
    }

    /// Ends the input and returns the last files.
    pub fn finish(&mut self) -> Result<Vec<JsValue>, JsError> {
        files(self.inner.finish())
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
