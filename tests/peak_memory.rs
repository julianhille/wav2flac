// SPDX-License-Identifier: 0BSD
//! Peak heap use of one huge push: the encoder must not copy or decode the
//! whole input at once. Its own binary, so the counting allocator only sees
//! this test.
mod common;
use common::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use wav2flac::{Encoder, Options, OutputMode};

struct Counting;
static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
/// The counters are global: tests take turns.
static SERIAL: Mutex<()> = Mutex::new(());

// SAFETY: forwards to the system allocator and only counts bytes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let now = CURRENT.fetch_add(l.size(), Ordering::Relaxed) + l.size();
        PEAK.fetch_max(now, Ordering::Relaxed);
        // SAFETY: same layout contract as the caller's.
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        CURRENT.fetch_sub(l.size(), Ordering::Relaxed);
        // SAFETY: `p` came from `alloc` with this layout.
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static A: Counting = Counting;

#[test]
fn one_huge_push_stays_bounded() {
    let _turn = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // 32 MiB of silence: the FLAC output is tiny, so any large peak is a copy
    // of the input or a decode of all of it.
    let s = signal(Signal::Silence, 16, 2, 8 << 20, 1);
    let w = wav(2, 44100, 16, &s);
    drop(s);
    for mode in [OutputMode::Streaming, OutputMode::Buffered] {
        let base = CURRENT.load(Ordering::Relaxed);
        PEAK.store(base, Ordering::Relaxed);
        let mut e = Encoder::new(Options {
            mode,
            ..Options::default()
        })
        .unwrap();
        let out = e.push(&w).unwrap();
        e.finish().unwrap();
        drop(out);
        let grew = PEAK.load(Ordering::Relaxed) - base;
        assert!(grew < 8 << 20, "{mode:?}: peak grew by {grew} bytes");
    }
}

#[test]
fn heavy_upsampling_stays_bounded() {
    let _turn = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // 8 kHz → 192 kHz multiplies the samples by 24; the decoded and resampled
    // scratch must not scale with the push size times that factor.
    let s = signal(Signal::Silence, 16, 1, 1 << 20, 1);
    let w = wav(1, 8000, 16, &s);
    drop(s);
    let base = CURRENT.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let mut e = Encoder::new(Options {
        mode: OutputMode::Streaming,
        sample_rate: Some(192_000),
        bits_per_sample: Some(16),
        ..Options::default()
    })
    .unwrap();
    let out = e.push(&w).unwrap();
    e.finish().unwrap();
    let kept = out.len();
    drop(out);
    let grew = PEAK.load(Ordering::Relaxed) - base - kept;
    assert!(
        grew < 32 << 20,
        "peak grew by {grew} bytes beyond the output"
    );
}
