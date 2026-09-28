# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every version headline links to the diff against the previous release; the
links are collected at the bottom of this file.

## [Unreleased]

### Added

- Streaming WAV → FLAC encoder core in Rust, built on libflac-rs (a
  bit-exact port of libFLAC 1.4.3). Output modes: *buffered* (exact
  STREAMINFO with total samples and MD5, plus a SEEKTABLE) and *streaming*
  (header first, bounded memory). Output is identical however the input is
  chunked.
- Input: integer PCM with 8, 16, 24 or 32 bits (8-bit unsigned included),
  or 4–32 valid bits in a WAVE_FORMAT_EXTENSIBLE container (plain 12- or
  20-bit PCM is rejected), 32-bit float, 1–8 channels, sample rates up to
  1 048 575 Hz. Real-world quirks are tolerated: a missing or non-zero pad
  byte after an odd-sized chunk, 24/32-bit PCM declared with an 18 or
  40-byte `fmt` chunk, a wrong byte rate, and a channel mask whose speaker
  count does not match the channels (the mask is then ignored). 64-bit float is rejected as `UNSUPPORTED_FORMAT`.
  The header is parsed incrementally, so many small chunks before `data`
  cost no more when the input arrives in small pieces.
- Compression levels 0–8 (libFLAC presets) and custom block sizes (16–65535).
- Metadata: LIST/INFO tags → Vorbis comments (UTF-8 with Latin-1 fallback;
  tags after the audio data are found behind chunks of any size, in buffered
  mode),
  a custom `tags` option, a PADDING block, and the channel-mask tag
  `WAVEFORMATEXTENSIBLE_CHANNEL_MASK`. The tag is written for non-default
  masks and for explicit 5.0/5.1 back-surround masks, so ffmpeg reads the
  layout correctly.
- Transcoding: resampling (rubato sinc, `fast`/`balanced`/`best`) and
  bit-depth conversion with seeded TPDF dither; depth increases are lossless.
- Limits and stable error codes (`INVALID_WAV`, `UNSUPPORTED_FORMAT`, …).
  Resampling is limited to 256x up and 65536x down (`INVALID_OPTIONS`).
- Test suites: roundtrip, lengths, options, WAV variants, malformed input,
  chunking, streaming, state, metadata, transcode quality, property-based,
  golden hashes, and differential tests against ffmpeg and `flac`.
- Project scaffolding: 0BSD license, third-party license handling, CI skeleton.

[Unreleased]: https://github.com/julianhille/wav2flac/commits/main
