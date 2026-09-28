// SPDX-License-Identifier: 0BSD
//! Native reference CLI:
//! `encode <in.wav|-> <out.flac|-> [OPTIONS]`, see [`USAGE`].
//!
//! With `--pcm` (e.g. `--pcm s16:44100:2`) the input is raw interleaved PCM
//! instead of WAV; FORMAT is `u8`, `s16`, `s24`, `s32` or `f32`.
//! Used by the JS tests (wasm output must be byte-identical) and as the native
//! baseline in the benchmark. With `--time` it prints `{"ms":…,"maxRssKb":…}`
//! to stderr. With `--stream` every frame is written as soon as it is encoded.
use std::io::{Read, Write};
use std::time::Instant;
use wav2flac::{Dither, Encoder, Options, OutputMode, PcmFormat, PcmSpec, ResampleQuality, Tags};

const USAGE: &str = "usage: encode <in.wav|-> <out.flac|-> [--level N] [--block-size N] \
    [--stream] [--bits N] [--rate N] [--quality fast|balanced|best] [--dither tpdf|none] \
    [--seed N] [--no-tags] [--seek-interval SECONDS] [--padding N] [--max-input-bytes N] \
    [--pcm FORMAT:RATE:CHANNELS] [--time]";

fn main() {
    if let Err(e) = run() {
        eprintln!("encode: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (mut pos, mut opts, mut time) = (Vec::new(), Options::default(), false);
    let mut pcm = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = || it.next().ok_or_else(|| format!("{a} needs a value"));
        match a.as_str() {
            "--level" => opts.compression_level = val()?.parse()?,
            "--block-size" => opts.block_size = Some(val()?.parse()?),
            "--bits" => opts.bits_per_sample = Some(val()?.parse()?),
            "--rate" => opts.sample_rate = Some(val()?.parse()?),
            "--quality" => {
                opts.resample_quality = match val()?.as_str() {
                    "fast" => ResampleQuality::Fast,
                    "balanced" => ResampleQuality::Balanced,
                    "best" => ResampleQuality::Best,
                    q => return Err(format!("--quality: unknown quality {q}").into()),
                }
            }
            "--dither" => {
                opts.dither = match val()?.as_str() {
                    "tpdf" => Dither::Tpdf,
                    "none" => Dither::None,
                    d => return Err(format!("--dither: unknown dither {d}").into()),
                }
            }
            "--seed" => opts.dither_seed = val()?.parse()?,
            "--no-tags" => opts.tags = Tags::Disabled,
            "--seek-interval" => opts.seek_point_interval = val()?.parse()?,
            "--padding" => opts.padding = val()?.parse()?,
            "--max-input-bytes" => opts.max_input_bytes = Some(val()?.parse()?),
            "--stream" => opts.mode = OutputMode::Streaming,
            "--pcm" => pcm = Some(parse_pcm(val()?)?),
            "--time" => time = true,
            f if f.starts_with("--") => return Err(format!("unknown option {f}\n{USAGE}").into()),
            _ => pos.push(a.clone()),
        }
    }
    let [input, output] = pos.as_slice() else {
        return Err(USAGE.into());
    };
    let streaming = opts.mode == OutputMode::Streaming;
    let mut wav = Vec::new();
    if input == "-" {
        std::io::stdin().read_to_end(&mut wav)?;
    } else {
        wav = std::fs::read(input)?;
    }
    let mut sink: Box<dyn Write> = if output == "-" {
        Box::new(std::io::stdout().lock())
    } else {
        Box::new(std::fs::File::create(output)?)
    };
    let start = Instant::now();
    let mut enc = match pcm {
        Some(spec) => Encoder::new_pcm(opts, spec, Some(wav.len() as u64))?,
        None => Encoder::new(opts)?,
    };
    // Buffered output needs the final header first, so frames are kept;
    // streaming output goes straight to the sink.
    let (mut frames, mut out_bytes) = (Vec::new(), 0);
    for chunk in wav.chunks(1 << 20) {
        let out = enc.push(chunk)?;
        if streaming {
            sink.write_all(&out)?;
            out_bytes += out.len();
        } else {
            frames.extend_from_slice(&out);
        }
    }
    let fin = enc.finish()?;
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    // Written piecewise: no concatenated copy of the (possibly large) output.
    for part in [&fin.header, &frames, &fin.tail] {
        sink.write_all(part)?;
        out_bytes += part.len();
    }
    sink.flush()?;
    if time {
        eprintln!(
            "{{\"ms\":{ms:.3},\"maxRssKb\":{},\"outBytes\":{out_bytes}}}",
            max_rss_kb()
        );
    }
    Ok(())
}

/// Parses `FORMAT:RATE:CHANNELS`, e.g. `s16:44100:2`.
fn parse_pcm(s: &str) -> Result<PcmSpec, Box<dyn std::error::Error>> {
    let parts: Vec<&str> = s.split(':').collect();
    let [format, rate, channels] = parts.as_slice() else {
        return Err(format!("--pcm {s}: expected FORMAT:RATE:CHANNELS").into());
    };
    let format = match *format {
        "u8" => PcmFormat::U8,
        "s16" => PcmFormat::S16,
        "s24" => PcmFormat::S24,
        "s32" => PcmFormat::S32,
        "f32" => PcmFormat::F32,
        f => return Err(format!("--pcm: unknown format {f}").into()),
    };
    Ok(PcmSpec {
        format,
        channels: channels.parse()?,
        sample_rate: rate.parse()?,
    })
}

/// Peak resident set size in KiB (Linux `VmHWM`; 0 elsewhere).
fn max_rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmHWM:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
        })
        .unwrap_or(0)
}
