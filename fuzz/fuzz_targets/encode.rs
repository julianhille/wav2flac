// SPDX-License-Identifier: 0BSD
//! WAV bytes in arbitrary pieces with arbitrary options. Must never panic,
//! and the result must not depend on how the input is split.
#![no_main]
mod common;

use arbitrary::Arbitrary;
use common::{pieces, FuzzOptions};
use libfuzzer_sys::fuzz_target;
use wav2flac::{encode_all, probe, Encoder, OutputMode};

#[derive(Arbitrary, Debug)]
struct Input<'a> {
    opts: FuzzOptions,
    sizes: Vec<u16>,
    wav: &'a [u8],
}

/// Pushes the pieces and assembles the file as a caller would.
fn chunked(input: &Input<'_>) -> wav2flac::Result<Vec<u8>> {
    let opts = input.opts.options();
    let mode = opts.mode;
    let mut e = Encoder::new(opts)?;
    let mut body = Vec::new();
    for p in pieces(input.wav, &input.sizes) {
        body.extend(e.push(p)?);
        // Read-only calls between pushes must not disturb the state.
        let _ = (e.info(), e.progress(), e.buffered_len(), e.output_spec());
    }
    let fin = e.finish()?;
    // After `finish`, every call must fail cleanly.
    assert!(e.push(b"x").is_err());
    assert!(e.finish().is_err());
    Ok(match mode {
        OutputMode::Buffered => [fin.header, body, fin.tail].concat(),
        OutputMode::Streaming => [body, fin.tail].concat(),
    })
}

fuzz_target!(|input: Input<'_>| {
    let _ = probe(input.wav);
    let split = chunked(&input);
    let opts = input.opts.options();
    if opts.mode == OutputMode::Buffered && opts.max_input_bytes.is_none() {
        let whole = encode_all(input.wav, opts);
        match (&split, &whole) {
            (Ok(a), Ok(b)) => assert!(a == b, "the output depends on how the input is split"),
            (Err(a), Err(b)) => assert_eq!(a.code(), b.code(), "{a} / {b}"),
            _ => panic!("split: {split:?}\nwhole: {whole:?}"),
        }
    }
});
