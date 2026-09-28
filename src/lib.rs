// SPDX-License-Identifier: 0BSD
//! # wav2flac
//!
//! A streaming WAV → FLAC encoder with optional resampling and bit-depth
//! conversion, designed to be compiled to WebAssembly.
//!
//! * WAV parsing: [hound] (fmt validation) + our own RIFF chunk walker.
//! * FLAC encoding: [libflac_rs] (bit-exact libFLAC 1.4.3 port), one frame at a time.
//! * Resampling: [rubato].
//!
//! ```
//! use wav2flac::{encode_all, Options};
//! # fn wav() -> Vec<u8> {
//! #     let mut v = b"RIFF\x28\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0data\x04\0\0\0".to_vec();
//! #     v.extend_from_slice(&[1, 0, 2, 0]);
//! #     v
//! # }
//! let flac = encode_all(&wav(), Options::default()).unwrap();
//! assert_eq!(&flac[..4], b"fLaC");
//! ```
#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![warn(clippy::pedantic)]
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::module_name_repetitions,
    clippy::missing_panics_doc
)]

pub mod encoder;
pub mod error;
pub mod frame;
pub mod metadata;
pub mod options;
pub mod pcm;
pub mod riff;
pub mod transcode;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use encoder::{encode_all, probe, Encoder, Finished, Progress, WavInfo};
pub use error::{Error, ErrorCode, Result};
pub use options::{Dither, Options, OutputMode, ResampleQuality, Tags};
