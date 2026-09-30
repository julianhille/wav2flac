// SPDX-License-Identifier: 0BSD
//! Error type shared by the whole crate.
//!
//! Every error carries a stable [`ErrorCode`] so that JavaScript callers can
//! branch on `err.code` without parsing messages.

use std::fmt;

/// Stable, machine-readable error categories.
///
/// The string form (see [`ErrorCode::as_str`]) is part of the public JS API
/// and must never change for an existing variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    /// The input is not a well-formed RIFF/WAVE file.
    InvalidWav,
    /// The input is a WAV file, but its encoding is not supported
    /// (e.g. ADPCM, A-law, RF64, or a streaming header of unknown length),
    /// or it cannot be converted as asked (float input without a target bit
    /// depth, or a resampling ratio beyond the supported range).
    UnsupportedFormat,
    /// The sample bit depth cannot be encoded as requested.
    UnsupportedBitDepth,
    /// More than 8 channels.
    TooManyChannels,
    /// The input ended before the header or the announced sample data was complete.
    Truncated,
    /// An option value is out of range or inconsistent.
    InvalidOptions,
    /// The encoder was used in the wrong order (e.g. `push` after `finish`).
    EncoderState,
    /// The input exceeds a configured limit.
    LimitExceeded,
    /// An internal invariant was violated. This is always a bug.
    Internal,
}

impl ErrorCode {
    /// Returns the stable string used in the JS API (`Wav2FlacError.code`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidWav => "INVALID_WAV",
            Self::UnsupportedFormat => "UNSUPPORTED_FORMAT",
            Self::UnsupportedBitDepth => "UNSUPPORTED_BIT_DEPTH",
            Self::TooManyChannels => "TOO_MANY_CHANNELS",
            Self::Truncated => "TRUNCATED",
            Self::InvalidOptions => "INVALID_OPTIONS",
            Self::EncoderState => "ENCODER_STATE",
            Self::LimitExceeded => "LIMIT_EXCEEDED",
            Self::Internal => "INTERNAL",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The crate's error type: a [`ErrorCode`] plus a human-readable message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    code: ErrorCode,
    message: String,
}

impl Error {
    /// Creates a new error.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Returns the error category.
    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        self.code
    }

    /// Returns the human-readable message (without the code prefix).
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, Error>;

/// Shorthand constructor used internally.
pub(crate) fn err<T>(code: ErrorCode, message: impl Into<String>) -> Result<T> {
    Err(Error::new(code, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_strings() {
        use ErrorCode::*;
        // Must match the `ErrorCode` union in ts/lib/errors.ts.
        let all = [
            (InvalidWav, "INVALID_WAV"),
            (UnsupportedFormat, "UNSUPPORTED_FORMAT"),
            (UnsupportedBitDepth, "UNSUPPORTED_BIT_DEPTH"),
            (TooManyChannels, "TOO_MANY_CHANNELS"),
            (Truncated, "TRUNCATED"),
            (InvalidOptions, "INVALID_OPTIONS"),
            (EncoderState, "ENCODER_STATE"),
            (LimitExceeded, "LIMIT_EXCEEDED"),
            (Internal, "INTERNAL"),
        ];
        for (code, s) in all {
            assert_eq!(code.as_str(), s);
            assert_eq!(code.to_string(), s);
        }
        let e = Error::new(ErrorCode::InvalidOptions, "block size");
        assert_eq!(e.to_string(), "INVALID_OPTIONS: block size");
        assert_eq!(e.code(), ErrorCode::InvalidOptions);
        assert_eq!(e.message(), "block size");
    }
}
