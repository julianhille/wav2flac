// SPDX-License-Identifier: 0BSD
//! Any sequence of push, cut and finish on a chunk encoder.
#![no_main]
mod common;

use arbitrary::Arbitrary;
use common::{FuzzOptions, RATES};
use libfuzzer_sys::fuzz_target;
use wav2flac::{ChunkEncoder, OutputMode};

#[derive(Arbitrary, Debug)]
enum Op {
    Push(Vec<f32>),
    Cut,
    Finish,
}

#[derive(Arbitrary, Debug)]
struct Input {
    opts: FuzzOptions,
    input_rate: u8,
    channels: u8,
    chunk_frames: Option<u16>,
    ops: Vec<Op>,
}

fuzz_target!(|input: Input| {
    let mut opts = input.opts.options();
    opts.mode = OutputMode::Buffered;
    let rate = RATES[usize::from(input.input_rate) % RATES.len()];
    let chunk = input.chunk_frames.map(usize::from);
    let Ok(mut c) = ChunkEncoder::new(rate, u16::from(input.channels % 10), opts, chunk) else {
        return;
    };
    for op in input.ops.iter().take(64) {
        let r = match op {
            Op::Push(s) => c.push(s).map(|()| Vec::new()),
            Op::Cut => c.cut(),
            Op::Finish => c.finish(),
        };
        if let Ok(files) = &r {
            assert!(
                files.iter().all(|f| f.starts_with(b"fLaC")),
                "a file without a header"
            );
        }
    }
});
