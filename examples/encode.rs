// SPDX-License-Identifier: 0BSD
//! Native reference CLI:
//! `encode <in.wav|-> <out.flac|-> [--level N] [--stream] [--bits N] [--rate N] [--time]`.
//!
//! Used by the JS tests (wasm output must be byte-identical) and as the native
//! baseline in the benchmark. With `--time` it prints `{"ms":…,"maxRssKb":…}`
//! to stderr.
use std::io::{Read, Write};
use std::time::Instant;
use wav2flac::{Encoder, Options, OutputMode};

fn main() {
    if let Err(e) = run() {
        eprintln!("encode: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (mut pos, mut opts, mut time) = (Vec::new(), Options::default(), false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = || it.next().ok_or_else(|| format!("{a} needs a value"));
        match a.as_str() {
            "--level" => opts.compression_level = val()?.parse()?,
            "--bits" => opts.bits_per_sample = Some(val()?.parse()?),
            "--rate" => opts.sample_rate = Some(val()?.parse()?),
            "--stream" => opts.mode = OutputMode::Streaming,
            "--time" => time = true,
            _ => pos.push(a.clone()),
        }
    }
    let [input, output] = pos.as_slice() else {
        return Err(
            "usage: encode <in.wav|-> <out.flac|-> [--level N] [--stream] \
                    [--bits N] [--rate N] [--time]"
                .into(),
        );
    };
    let mut wav = Vec::new();
    if input == "-" {
        std::io::stdin().read_to_end(&mut wav)?;
    } else {
        wav = std::fs::read(input)?;
    }
    let start = Instant::now();
    let mut enc = Encoder::new(opts)?;
    let mut frames = Vec::new();
    for chunk in wav.chunks(1 << 20) {
        frames.extend_from_slice(&enc.push(chunk)?);
    }
    let fin = enc.finish()?;
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    // Written piecewise: no concatenated copy of the (possibly large) output.
    let mut sink: Box<dyn Write> = if output == "-" {
        Box::new(std::io::stdout().lock())
    } else {
        Box::new(std::fs::File::create(output)?)
    };
    for part in [&fin.header, &frames, &fin.tail] {
        sink.write_all(part)?;
    }
    sink.flush()?;
    if time {
        let out_bytes = fin.header.len() + frames.len() + fin.tail.len();
        eprintln!(
            "{{\"ms\":{ms:.3},\"maxRssKb\":{},\"outBytes\":{out_bytes}}}",
            max_rss_kb()
        );
    }
    Ok(())
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
