// SPDX-License-Identifier: 0BSD
//! Memory-leak checks. Safe Rust can still leak: a buffer in a long-lived
//! encoder that keeps growing is still referenced, so LeakSanitizer cannot
//! see it. These tests count the heap bytes each test's thread holds and
//! assert that
//!
//! - a long stream through one encoder levels off instead of growing, and
//! - every encoder, finished, abandoned or failed, gives back all it took.
//!
//! Its own binary, so the counting allocator only sees these tests. The
//! counters are per thread, so tests running in parallel do not disturb
//! each other and need no lock.
mod common;
use common::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use wav2flac::{
    encode_all, probe, ChunkEncoder, Dither, Encoder, Options, OutputMode, PcmFormat, PcmSpec,
    ResampleQuality, StreamResampler,
};

struct Counting;

thread_local! {
    /// Bytes allocated minus bytes freed on this thread.
    static LIVE: Cell<isize> = const { Cell::new(0) };
}

fn count(delta: isize) {
    // `try_with`: a thread being torn down still frees memory.
    let _ = LIVE.try_with(|l| l.set(l.get() + delta));
}

// SAFETY: forwards to the system allocator and only counts bytes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        // SAFETY: same layout contract as the caller's.
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            count(l.size() as isize);
        }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        // SAFETY: same layout contract as the caller's.
        let p = unsafe { System.alloc_zeroed(l) };
        if !p.is_null() {
            count(l.size() as isize);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        count(-(l.size() as isize));
        // SAFETY: `p` came from `alloc` with this layout.
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: `p` came from `alloc` with layout `l`.
        let q = unsafe { System.realloc(p, l, new_size) };
        if !q.is_null() {
            count(new_size as isize - l.size() as isize);
        }
        q
    }
}

#[global_allocator]
static A: Counting = Counting;

/// Heap bytes this thread holds right now.
fn live() -> isize {
    LIVE.with(Cell::get)
}

/// Pushes per measuring window, scaled by the test tier.
fn window() -> usize {
    match tier() {
        Tier::Quick => 200,
        Tier::Full => 1_000,
        Tier::Soak => 10_000,
    }
}

/// Pushes before the first window: every scratch buffer has reached its
/// working size by then.
const WARMUP: usize = 20;

/// Growth of the peak allowed from one window to the next. A leak of 8
/// bytes per push (one pointer) exceeds it within the quick tier's window.
const SLACK: isize = 1 << 10;

/// Runs `step` for the warm-up and then for two windows of [`window`]
/// pushes. Fails if the peak of this thread's live heap bytes in the second
/// window exceeds the first's by more than [`SLACK`]. Comparing peaks, not
/// single readings, ignores the sawtooth of buffers that fill up and are
/// handed out (a FLAC block, a cut file) every few pushes.
fn assert_plateau(what: &str, mut step: impl FnMut(usize)) {
    for i in 0..WARMUP {
        step(i);
    }
    let mut peaks = [isize::MIN; 2];
    for (w, peak) in peaks.iter_mut().enumerate() {
        for i in 0..window() {
            step(WARMUP + w * window() + i);
            *peak = (*peak).max(live());
        }
    }
    let grew = peaks[1] - peaks[0];
    assert!(
        grew <= SLACK,
        "{what}: the live heap peak grew by {grew} bytes from one window of {} pushes to \
         the next",
        window()
    );
}

/// Pushes [`assert_plateau`] makes in all.
fn pushes() -> usize {
    WARMUP + 2 * window()
}

/// Fails if `run` leaves heap bytes behind on this thread. Runs it once
/// beforehand, so one-time lazy initialization does not count.
fn assert_returns_all(what: &str, mut run: impl FnMut()) {
    run();
    let base = live();
    run();
    let left = live() - base;
    assert_eq!(left, 0, "{what}: {left} bytes not freed");
}

/// About 16 KiB of stereo 16-bit noise at 44.1 kHz, one push's worth.
fn pcm16_chunk() -> Vec<u8> {
    let s = signal(Signal::Noise, 16, 2, 4096, 7);
    WavBuilder::pcm(2, 44_100, 16).pack_int(&s)
}

/// A WAV header for `data_len` bytes of stereo 16-bit 44.1 kHz audio.
fn wav_header(data_len: u32) -> Vec<u8> {
    let mut h = WavBuilder::pcm(2, 44_100, 16).build_raw(&[]);
    let at = h.windows(4).position(|w| w == b"data").expect("data chunk") + 4;
    h[at..at + 4].copy_from_slice(&data_len.to_le_bytes());
    let riff = (h.len() - 8) as u32 + data_len;
    h[4..8].copy_from_slice(&riff.to_le_bytes());
    h
}

/// A small complete WAV file.
fn small_wav() -> Vec<u8> {
    let s = signal(Signal::Sine, 16, 2, 20_000, 3);
    wav(2, 44_100, 16, &s)
}

/// Streaming-output configurations: copy, resample, requantize with
/// dither, and both at once.
fn streaming_opts() -> Vec<(&'static str, Options)> {
    let base = Options {
        mode: OutputMode::Streaming,
        ..Options::default()
    };
    vec![
        ("copy", base.clone()),
        (
            "resample",
            Options {
                sample_rate: Some(48_000),
                resample_quality: ResampleQuality::Fast,
                ..base.clone()
            },
        ),
        (
            "requantize",
            Options {
                bits_per_sample: Some(12),
                dither: Dither::Tpdf,
                ..base.clone()
            },
        ),
        (
            "resample+requantize",
            Options {
                sample_rate: Some(22_050),
                bits_per_sample: Some(8),
                compression_level: 8,
                ..base
            },
        ),
    ]
}

#[test]
fn streaming_wav_plateaus() {
    let chunk = pcm16_chunk();
    let total = chunk.len() * pushes();
    for (name, opts) in streaming_opts() {
        let mut e = Encoder::new(opts).unwrap();
        drop(e.push(&wav_header(total as u32)).unwrap());
        assert_plateau(name, |_| drop(e.push(&chunk).unwrap()));
        e.finish().unwrap();
    }
}

#[test]
fn streaming_wav_plateaus_with_odd_pushes() {
    // Pushes that split sample frames and blocks at every offset.
    let chunk = pcm16_chunk();
    let sizes = [1, 3, 4099, 777, 16_383, 5];
    // Declares at least what is pushed; the stream is never finished.
    let total: usize = (0..pushes()).map(|i| sizes[i % sizes.len()]).sum();
    let total = total.next_multiple_of(4);
    let mut e = Encoder::new(Options {
        mode: OutputMode::Streaming,
        ..Options::default()
    })
    .unwrap();
    drop(e.push(&wav_header(total as u32)).unwrap());
    assert_plateau("odd pushes", |i| {
        drop(e.push(&chunk[..sizes[i % sizes.len()]]).unwrap());
    });
}

#[test]
fn raw_pcm_of_unknown_length_plateaus() {
    let chunk = pcm16_chunk();
    for (name, opts) in streaming_opts() {
        let spec = PcmSpec {
            format: PcmFormat::S16,
            channels: 2,
            sample_rate: 44_100,
        };
        let mut e = Encoder::new_pcm(opts, spec, None).unwrap();
        assert_plateau(name, |_| drop(e.push(&chunk).unwrap()));
        e.finish().unwrap();
    }
}

#[test]
fn stream_resampler_plateaus() {
    let input: Vec<f32> = (0..4096 * 2)
        .map(|i| (i as f32 * 0.01).sin() * 0.5)
        .collect();
    for (from, to) in [(44_100, 48_000), (48_000, 16_000), (8_000, 8_000)] {
        let mut r = StreamResampler::new(from, to, 2, ResampleQuality::Balanced).unwrap();
        let mut n = 0;
        assert_plateau(&format!("{from} -> {to}"), |i| {
            // Odd sizes, but whole frames over every two pushes.
            let len = if i % 2 == 0 { 1001 } else { 2 * 4096 - 1001 };
            r.push(&input[..len], |s| n += s.len()).unwrap();
        });
        r.flush(|s| n += s.len()).unwrap();
        assert!(n > 0);
    }
}

#[test]
fn chunk_encoder_plateaus_while_cutting() {
    let input: Vec<f32> = (0..4096 * 2)
        .map(|i| (i as f32 * 0.01).sin() * 0.5)
        .collect();
    for (rate, frames) in [(44_100, Some(4096)), (44_100, None), (48_000, Some(1000))] {
        let opts = Options {
            sample_rate: Some(rate),
            bits_per_sample: Some(16),
            ..Options::default()
        };
        let mut c = ChunkEncoder::new(44_100, 2, opts, frames).unwrap();
        assert_plateau(&format!("{rate} Hz, {frames:?}"), |_| {
            c.push(&input).unwrap();
            drop(c.cut().unwrap());
        });
        drop(c.finish().unwrap());
    }
}

#[test]
fn finished_encoders_free_everything() {
    let w = small_wav();
    for mode in [OutputMode::Buffered, OutputMode::Streaming] {
        let mut all = streaming_opts();
        all.push((
            "seek table",
            Options {
                seek_point_interval: 0.01,
                ..Options::default()
            },
        ));
        for (name, opts) in all {
            let opts = Options { mode, ..opts };
            assert_returns_all(&format!("{mode:?} {name}"), || {
                let mut e = Encoder::new(opts.clone()).unwrap();
                for piece in w.chunks(5000) {
                    drop(e.push(piece).unwrap());
                }
                drop(e.finish().unwrap());
            });
        }
    }
}

#[test]
fn abandoned_encoders_free_everything() {
    let w = small_wav();
    for mode in [OutputMode::Buffered, OutputMode::Streaming] {
        for cut in [10, 100, w.len() / 2, w.len()] {
            assert_returns_all(&format!("{mode:?}, dropped after {cut} bytes"), || {
                let mut e = Encoder::new(Options {
                    mode,
                    sample_rate: Some(32_000),
                    ..Options::default()
                })
                .unwrap();
                drop(e.push(&w[..cut]).unwrap());
            });
        }
    }
}

#[test]
fn failed_encoders_free_everything() {
    let w = small_wav();
    let mut bad_fmt = w.clone();
    let at = bad_fmt.windows(4).position(|x| x == b"fmt ").unwrap() + 8;
    bad_fmt[at] = 0x55; // unknown format tag
    assert_returns_all("bad header", || {
        let mut e = Encoder::new(Options::default()).unwrap();
        drop(e.push(&bad_fmt).unwrap_err());
        // Every later call fails too.
        drop(e.push(&w).unwrap_err());
        drop(e.finish().unwrap_err());
    });
    assert_returns_all("truncated", || {
        let mut e = Encoder::new(Options::default()).unwrap();
        drop(e.push(&w[..w.len() / 2]).unwrap());
        drop(e.finish().unwrap_err());
    });
    assert_returns_all("too long raw PCM", || {
        let spec = PcmSpec {
            format: PcmFormat::S16,
            channels: 2,
            sample_rate: 44_100,
        };
        let mut e = Encoder::new_pcm(Options::default(), spec, Some(4000)).unwrap();
        drop(e.push(&[0; 4004]).unwrap_err());
    });
    assert_returns_all("input too large", || {
        let mut e = Encoder::new(Options {
            max_input_bytes: Some(1000),
            ..Options::default()
        })
        .unwrap();
        drop(e.push(&w).unwrap_err());
    });
    assert_returns_all("invalid options", || {
        let opts = Options {
            compression_level: 99,
            ..Options::default()
        };
        drop(Encoder::new(opts).err().unwrap());
    });
}

#[test]
fn stream_types_free_everything() {
    let input: Vec<f32> = (0..3001).map(|i| (i as f32 * 0.02).sin()).collect();
    let opts = Options {
        sample_rate: Some(48_000),
        bits_per_sample: Some(16),
        ..Options::default()
    };
    assert_returns_all("chunk encoder, finished", || {
        let mut c = ChunkEncoder::new(44_100, 1, opts.clone(), Some(500)).unwrap();
        c.push(&input).unwrap();
        drop(c.cut().unwrap());
        drop(c.finish().unwrap());
    });
    assert_returns_all("chunk encoder, abandoned", || {
        let mut c = ChunkEncoder::new(44_100, 1, opts.clone(), None).unwrap();
        c.push(&input).unwrap();
    });
    assert_returns_all("chunk encoder, failed", || {
        // 3001 samples in stereo end inside a sample frame.
        let mut c = ChunkEncoder::new(44_100, 2, opts.clone(), None).unwrap();
        c.push(&input).unwrap();
        drop(c.finish().unwrap_err());
        drop(c.push(&input).unwrap_err());
    });
    assert_returns_all("resampler, flushed and abandoned", || {
        let mut r = StreamResampler::new(44_100, 48_000, 1, ResampleQuality::Best).unwrap();
        r.push(&input, |_| {}).unwrap();
        r.flush(|_| {}).unwrap();
        let mut r = StreamResampler::new(44_100, 48_000, 1, ResampleQuality::Best).unwrap();
        r.push(&input, |_| {}).unwrap();
    });
}

#[test]
fn one_shot_calls_free_everything() {
    let w = small_wav();
    assert_returns_all("encode_all", || {
        drop(encode_all(&w, Options::default()).unwrap())
    });
    assert_returns_all("encode_all, failing", || {
        drop(encode_all(&w[..w.len() / 3], Options::default()).unwrap_err());
    });
    assert_returns_all("probe", || drop(probe(&w).unwrap()));
    assert_returns_all("probe, failing", || drop(probe(b"RIFF").unwrap_err()));
}
