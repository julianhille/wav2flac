// SPDX-License-Identifier: 0BSD
//! Incremental RIFF/WAVE header parsing.
//!
//! We walk the RIFF chunk list ourselves because we need information hound
//! does not expose (the `WAVE_FORMAT_EXTENSIBLE` channel mask, `LIST/INFO`
//! tags) and because we have to honour the RIFF pad byte after odd-sized
//! chunks. The `fmt ` chunk itself is validated by hound: we hand it a
//! normalized minimal header and use its [`hound::WavReader`] spec as
//! the source of truth for the sample format.

use crate::error::{err, ErrorCode, Result};
use std::io::Cursor;

/// Upper bound for everything that precedes the `data` chunk.
///
/// Guards against unbounded buffering on hostile or broken input.
pub const MAX_HEADER_BYTES: usize = 64 * 1024 * 1024;

/// Sample encoding stored in the `data` chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleFormat {
    /// Integer PCM.
    Int,
    /// IEEE 754 float PCM (32-bit).
    Float,
}

/// How samples are aligned when fewer bits are valid than the container holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Justify {
    /// Valid bits are the most significant bits (`WAVE_FORMAT_EXTENSIBLE`, per spec).
    Left,
    /// Valid bits are the least significant bits (plain PCM, hound's interpretation).
    Right,
}

/// Everything we learned from the header up to the start of the sample data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WavHeader {
    /// Integer or float samples.
    pub format: SampleFormat,
    /// Channel count (1..=65535 as stored; validated later).
    pub channels: u16,
    /// Sample rate in Hz.
    pub sample_rate: u32,
    /// Number of meaningful bits per sample.
    pub valid_bits: u16,
    /// Bytes used to store one sample of one channel.
    pub container_bytes: u16,
    /// Alignment of valid bits inside the container.
    pub justify: Justify,
    /// `dwChannelMask` of `WAVE_FORMAT_EXTENSIBLE`, if present and non-zero.
    pub channel_mask: Option<u32>,
    /// Byte offset of the first sample byte in the input.
    pub data_offset: usize,
    /// Length of the `data` chunk in bytes.
    pub data_len: u32,
    /// Offset just past the RIFF chunk (8 + the RIFF size); `u64::MAX` for
    /// raw PCM.
    pub riff_end: u64,
    /// Tags found in `LIST/INFO` chunks before the data, mapped to Vorbis names.
    pub tags: Vec<(String, String)>,
}

impl WavHeader {
    /// Bytes per interleaved frame (all channels of one sample instant).
    #[must_use]
    pub fn block_align(&self) -> usize {
        usize::from(self.container_bytes) * usize::from(self.channels)
    }

    /// Number of per-channel samples announced by the `data` chunk (0 for a
    /// header without channels or sample bytes).
    #[must_use]
    pub fn total_frames(&self) -> u64 {
        u64::from(self.data_len)
            .checked_div(self.block_align() as u64)
            .unwrap_or(0)
    }
}

/// Result of an attempt to parse the header from a buffered prefix.
#[derive(Debug)]
pub enum HeaderState {
    /// More bytes are needed.
    NeedMore,
    /// The header is complete.
    Done(WavHeader),
}

fn le_u16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn le_u32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

/// Returns `NeedMore`, or `Truncated` if the input already ended.
fn need_more(eof: bool, what: &str) -> Result<HeaderState> {
    if eof {
        err(
            ErrorCode::Truncated,
            format!("input ended inside the {what}"),
        )
    } else {
        Ok(HeaderState::NeedMore)
    }
}

/// Tries to parse the WAV header from `buf`, which holds the input prefix.
///
/// `eof` tells whether `buf` is the complete input. For incremental input use
/// a [`HeaderParser`], which resumes where the previous attempt stopped.
///
/// # Errors
///
/// Returns an error for malformed or unsupported headers, or `Truncated` if
/// `eof` is set and the header is incomplete.
pub fn parse_header(buf: &[u8], eof: bool) -> Result<HeaderState> {
    HeaderParser::new().parse(buf, eof)
}

/// Resumable header parser for input that arrives in pieces.
///
/// Every chunk before `data` is inspected once: the parser remembers the
/// chunk cursor and what it learned, so `parse` with a longer prefix continues
/// where the previous call stopped instead of starting over.
#[derive(Debug, Default)]
pub struct HeaderParser {
    /// Chunk cursor, valid once `riff_ok` is set.
    pos: usize,
    /// The RIFF/WAVE preamble has been checked.
    riff_ok: bool,
    /// Buffer length below which `parse` cannot make progress.
    need: usize,
    fmt: Option<FmtInfo>,
    tags: Vec<(String, String)>,
}

impl HeaderParser {
    /// Creates a parser at the start of the input.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Continues parsing `buf`, which holds the input prefix seen so far.
    ///
    /// `eof` tells whether `buf` is the complete input.
    ///
    /// # Errors
    ///
    /// Returns an error for malformed or unsupported headers, or `Truncated`
    /// if `eof` is set and the header is incomplete. After an error the parser
    /// must not be used again.
    pub fn parse(&mut self, buf: &[u8], eof: bool) -> Result<HeaderState> {
        if buf.len() < self.need && !eof {
            return Ok(HeaderState::NeedMore);
        }
        let r = self.parse_inner(buf, eof);
        if let Ok(HeaderState::NeedMore) = r {
            // `need_more` was returned for a position past the buffer end.
            self.need = self.need.max(buf.len() + 1);
        }
        r
    }

    /// Records that `buf` must hold at least `len` bytes before the next step.
    fn need_more(&mut self, len: usize, eof: bool, what: &str) -> Result<HeaderState> {
        self.need = len;
        need_more(eof, what)
    }

    fn parse_inner(&mut self, buf: &[u8], eof: bool) -> Result<HeaderState> {
        if !self.riff_ok {
            if let Some(state) = check_riff(buf, eof)? {
                return Ok(state);
            }
            self.riff_ok = true;
            self.pos = 12;
        }
        loop {
            let pos = self.pos;
            if pos > MAX_HEADER_BYTES {
                return err(
                    ErrorCode::LimitExceeded,
                    "more than 64 MiB of chunks before the data chunk",
                );
            }
            if buf.len() < pos + 8 {
                return self.need_more(pos + 8, eof, "chunk list before the data chunk");
            }
            let id: [u8; 4] = [buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]];
            let len = le_u32(buf, pos + 4);
            let body = pos + 8;
            if &id == b"data" {
                let Some(info) = self.fmt.take() else {
                    return err(ErrorCode::InvalidWav, "data chunk before fmt chunk");
                };
                if len == u32::MAX {
                    return err(
                        ErrorCode::UnsupportedFormat,
                        "streaming WAV header with unknown data length (0xFFFFFFFF) is not \
                         supported",
                    );
                }
                let tags = std::mem::take(&mut self.tags);
                let riff_end = u64::from(le_u32(buf, 4)) + 8;
                let header = finalize(&info, body, len, riff_end, tags)?;
                return Ok(HeaderState::Done(header));
            }
            let len_usize = len as usize;
            let Some(end) = body.checked_add(len_usize) else {
                return err(ErrorCode::InvalidWav, "chunk length overflows");
            };
            if end > MAX_HEADER_BYTES {
                return err(
                    ErrorCode::LimitExceeded,
                    "more than 64 MiB of chunks before the data chunk",
                );
            }
            if buf.len() < end {
                return self.need_more(end, eof, "chunk before the data chunk");
            }
            // Find where the next chunk starts before acting on this one: the
            // pad lookahead may need more input, and parsing then resumes at
            // this chunk, which must not be processed twice.
            let mut next = end;
            if len % 2 == 1 {
                if buf.len() < end + 5 {
                    return self.need_more(end + 5, eof, "chunk padding");
                }
                next = after_pad(buf, end);
            }
            match &id {
                b"fmt " => {
                    if self.fmt.is_some() {
                        return err(ErrorCode::InvalidWav, "duplicate fmt chunk");
                    }
                    self.fmt = Some(parse_fmt(&buf[body..end])?);
                }
                b"LIST" => parse_list(&buf[body..end], &mut self.tags),
                _ => {}
            }
            self.pos = next;
        }
    }
}

/// Checks the 12-byte RIFF/WAVE preamble.
///
/// Returns `Some(NeedMore)` while it is incomplete and `None` once it passed.
fn check_riff(buf: &[u8], eof: bool) -> Result<Option<HeaderState>> {
    if buf.len() < 12 {
        // Reject obviously wrong magic early, even before 12 bytes arrived.
        let n = buf.len().min(4);
        if !b"RIFF"[..n].eq(&buf[..n]) && !b"RF64"[..n].eq(&buf[..n]) && !b"RIFX"[..n].eq(&buf[..n])
        {
            return err(
                ErrorCode::InvalidWav,
                "not a RIFF/WAVE file (missing RIFF tag)",
            );
        }
        if eof && buf.is_empty() {
            return err(ErrorCode::Truncated, "input is empty");
        }
        return need_more(eof, "RIFF header").map(Some);
    }
    match &buf[0..4] {
        b"RIFF" => {}
        b"RF64" => {
            return err(
                ErrorCode::UnsupportedFormat,
                "RF64 (64-bit WAV) is not supported",
            )
        }
        b"RIFX" => {
            return err(
                ErrorCode::UnsupportedFormat,
                "RIFX (big-endian WAV) is not supported",
            )
        }
        _ => {
            return err(
                ErrorCode::InvalidWav,
                "not a RIFF/WAVE file (missing RIFF tag)",
            )
        }
    }
    if &buf[8..12] != b"WAVE" {
        return err(ErrorCode::InvalidWav, "RIFF file is not of form type WAVE");
    }
    let riff_size = le_u32(buf, 4);
    if riff_size == 0 || riff_size == u32::MAX {
        return err(
            ErrorCode::UnsupportedFormat,
            "streaming WAV header with unknown length (RIFF size 0 or 0xFFFFFFFF) is not supported",
        );
    }
    Ok(None)
}

/// Parsed `fmt ` data, validated by hound.
#[derive(Debug, Clone)]
struct FmtInfo {
    format: SampleFormat,
    channels: u16,
    sample_rate: u32,
    valid_bits: u16,
    container_bytes: u16,
    extensible: bool,
    channel_mask: Option<u32>,
}

fn map_hound(e: hound::Error) -> crate::error::Error {
    match e {
        hound::Error::Unsupported => crate::error::Error::new(
            ErrorCode::UnsupportedFormat,
            "unsupported WAV encoding (only integer and 32-bit float PCM are supported)",
        ),
        // A sample width hound cannot unpack is a depth problem, not a broken file.
        hound::Error::FormatError(msg) if msg.starts_with("bits per sample is not") => {
            crate::error::Error::new(
                ErrorCode::UnsupportedBitDepth,
                format!("unsupported sample width: {msg}"),
            )
        }
        hound::Error::FormatError(msg) => {
            crate::error::Error::new(ErrorCode::InvalidWav, format!("invalid fmt chunk: {msg}"))
        }
        other => {
            crate::error::Error::new(ErrorCode::InvalidWav, format!("invalid fmt chunk: {other}"))
        }
    }
}

/// Validates the fmt chunk body using hound and extracts what we need.
fn parse_fmt(raw: &[u8]) -> Result<FmtInfo> {
    if raw.len() < 16 {
        return err(ErrorCode::InvalidWav, "fmt chunk is shorter than 16 bytes");
    }
    let tag = le_u16(raw, 0);
    // Give a precise message for common non-PCM encodings before hound's generic one.
    match tag {
        0x0002 | 0x0011 => return err(ErrorCode::UnsupportedFormat, "ADPCM WAV is not supported"),
        0x0006 => return err(ErrorCode::UnsupportedFormat, "A-law WAV is not supported"),
        0x0007 => return err(ErrorCode::UnsupportedFormat, "µ-law WAV is not supported"),
        0x0055 => return err(ErrorCode::UnsupportedFormat, "MP3-in-WAV is not supported"),
        _ => {}
    }
    let container_field = le_u16(raw, 14);
    let extensible_float = tag == 0xFFFE && raw.len() >= 26 && le_u16(raw, 24) == 0x0003;
    if (tag == 0x0003 || extensible_float) && container_field == 64 {
        return err(
            ErrorCode::UnsupportedFormat,
            "64-bit float WAV is not supported (only 32-bit float)",
        );
    }

    // Normalized minimal file: RIFF/WAVE + fmt + empty data chunk. Plain PCM
    // and float chunks are cut to the 16 bytes that carry information: a
    // `WAVEFORMATEX` (18 bytes) or longer chunk adds nothing for these tags,
    // and hound would reject some of them (e.g. 32-bit PCM in 18 bytes).
    // Extensible chunks are cut to the 40 bytes of `WAVEFORMATEXTENSIBLE`:
    // hound reads exactly that much and would parse the rest as the next
    // chunk header.
    let fmt_len = match tag {
        0x0001 | 0x0003 => 16,
        0xFFFE => raw.len().min(40),
        _ => raw.len(),
    };
    let mut mini = Vec::with_capacity(fmt_len + 28);
    mini.extend_from_slice(b"RIFF");
    mini.extend_from_slice(&((fmt_len + 20) as u32).to_le_bytes());
    mini.extend_from_slice(b"WAVE");
    mini.extend_from_slice(b"fmt ");
    mini.extend_from_slice(&(fmt_len as u32).to_le_bytes());
    mini.extend_from_slice(&raw[..fmt_len]);
    mini.extend_from_slice(b"data");
    mini.extend_from_slice(&0u32.to_le_bytes());
    // hound accepts only a `cbSize` of exactly 22; a larger one just announces
    // extra bytes we dropped above.
    if fmt_len == 40 && le_u16(raw, 16) > 22 {
        mini[36..38].copy_from_slice(&22u16.to_le_bytes());
    }
    // The byte rate is redundant and often wrong in the wild; hound rejects a
    // mismatch, so write the value it expects.
    if let Some(rate) = u32::from(le_u16(raw, 12)).checked_mul(le_u32(raw, 4)) {
        mini[28..32].copy_from_slice(&rate.to_le_bytes());
    }
    let reader = hound::WavReader::new(Cursor::new(&mini[..])).map_err(map_hound)?;
    let spec = reader.spec();
    let channels = le_u16(raw, 2);
    let block_align = le_u16(raw, 12);
    let bytes_per_sample = block_align.checked_div(channels).unwrap_or(0);

    let extensible = tag == 0xFFFE;
    let channel_mask = if extensible && raw.len() >= 24 {
        Some(le_u32(raw, 20)).filter(|m| *m != 0)
    } else {
        None
    };
    let format = match spec.sample_format {
        hound::SampleFormat::Int => SampleFormat::Int,
        hound::SampleFormat::Float => SampleFormat::Float,
    };
    if bytes_per_sample == 0 || bytes_per_sample > 4 {
        return err(
            ErrorCode::UnsupportedBitDepth,
            format!("sample container of {bytes_per_sample} bytes is not supported"),
        );
    }
    if spec.bits_per_sample == 0
        || u32::from(spec.bits_per_sample) > u32::from(bytes_per_sample) * 8
    {
        return err(
            ErrorCode::InvalidWav,
            "valid bits exceed the sample container",
        );
    }
    if format == SampleFormat::Float && (bytes_per_sample != 4 || spec.bits_per_sample != 32) {
        return err(
            ErrorCode::UnsupportedFormat,
            "only 32-bit float WAV is supported",
        );
    }
    if spec.sample_rate == 0 {
        return err(ErrorCode::InvalidWav, "sample rate is 0");
    }
    Ok(FmtInfo {
        format,
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        valid_bits: spec.bits_per_sample,
        container_bytes: bytes_per_sample,
        extensible,
        channel_mask,
    })
}

fn finalize(
    f: &FmtInfo,
    data_offset: usize,
    data_len: u32,
    riff_end: u64,
    tags: Vec<(String, String)>,
) -> Result<WavHeader> {
    let mut header = WavHeader {
        format: f.format,
        channels: f.channels,
        sample_rate: f.sample_rate,
        valid_bits: f.valid_bits,
        container_bytes: f.container_bytes,
        justify: if f.extensible {
            Justify::Left
        } else {
            Justify::Right
        },
        channel_mask: f.channel_mask,
        data_offset,
        data_len,
        riff_end,
        tags,
    };
    if header.channels == 0 {
        return err(ErrorCode::InvalidWav, "zero channels");
    }
    if u64::from(data_len) % header.block_align() as u64 != 0 {
        return err(
            ErrorCode::InvalidWav,
            "data chunk length is not a multiple of the frame size",
        );
    }
    // A mask that does not name one speaker per channel says nothing usable;
    // fall back to the default order instead of rejecting the audio.
    if header
        .channel_mask
        .is_some_and(|m| m.count_ones() != u32::from(header.channels))
    {
        header.channel_mask = None;
    }
    Ok(header)
}

/// Maps a RIFF INFO id to a Vorbis comment field name.
fn info_to_vorbis(id: [u8; 4]) -> Option<&'static str> {
    Some(match &id {
        b"INAM" => "TITLE",
        b"IART" => "ARTIST",
        b"IPRD" => "ALBUM",
        b"ICRD" => "DATE",
        b"IGNR" => "GENRE",
        b"ICMT" => "COMMENT",
        b"ITRK" | b"IPRT" => "TRACKNUMBER",
        b"ICOP" => "COPYRIGHT",
        b"ISFT" => "ENCODER",
        b"IENG" => "ENGINEER",
        b"ISRC" => "SOURCE",
        _ => return None,
    })
}

/// Decodes INFO text: UTF-8 if valid, otherwise Latin-1. Trailing NULs and
/// surrounding whitespace are removed.
fn decode_text(raw: &[u8]) -> String {
    let end = raw.iter().position(|b| *b == 0).unwrap_or(raw.len());
    let raw = &raw[..end];
    let s = match std::str::from_utf8(raw) {
        Ok(s) => s.to_owned(),
        Err(_) => raw.iter().map(|&b| char::from(b)).collect(),
    };
    s.trim().to_owned()
}

/// Most WAV INFO tags kept; further ones are ignored.
const MAX_TAGS: usize = 1024;
/// Most bytes of WAV INFO tag text kept; further tags are ignored.
const MAX_TAG_BYTES: usize = 1024 * 1024;

/// Parses a `LIST` chunk body; only `INFO` lists are used. Malformed
/// sub-chunks end parsing silently (tags are best-effort).
pub(crate) fn parse_list(body: &[u8], tags: &mut Vec<(String, String)>) {
    if body.len() < 4 || &body[0..4] != b"INFO" {
        return;
    }
    let mut p = 4usize;
    while p + 8 <= body.len() {
        let id = [body[p], body[p + 1], body[p + 2], body[p + 3]];
        let len = le_u32(body, p + 4) as usize;
        let start = p + 8;
        let Some(end) = start.checked_add(len).filter(|e| *e <= body.len()) else {
            return;
        };
        if let Some(key) = info_to_vorbis(id) {
            let used: usize = tags.iter().map(|(k, v)| k.len() + v.len()).sum();
            if tags.len() >= MAX_TAGS || used + len > MAX_TAG_BYTES {
                return; // tags are best-effort; don't let a file blow up memory
            }
            let value = decode_text(&body[start..end]);
            if !value.is_empty() {
                tags.push((key.to_owned(), value));
            }
        }
        p = if len % 2 == 1 {
            after_pad(body, end)
        } else {
            end
        };
    }
}

/// Whether `id` looks like a RIFF chunk id (printable ASCII or space).
pub(crate) fn is_chunk_id(id: &[u8]) -> bool {
    id.iter().all(|b| b.is_ascii_graphic() || *b == b' ')
}

/// Where the next chunk starts after an odd-sized chunk ending at `end`.
///
/// RIFF requires a pad byte after odd-sized chunks. Some writers omit it,
/// and some fill it with garbage, even printable garbage such as a space.
/// Both positions are looked at: a zero byte is always a pad; otherwise the
/// position whose four bytes look like a chunk id wins, and if both do, a
/// well-known id at `end` means the pad is missing. Needs five bytes after
/// `end` to decide; with fewer there is no next chunk either way.
fn after_pad(buf: &[u8], end: usize) -> usize {
    let id = |at: usize| buf.get(at..at + 4).filter(|id| is_chunk_id(id));
    match (buf.get(end), id(end), id(end + 1)) {
        (Some(0), _, _) | (_, None, _) => end + 1,
        (_, Some(here), Some(_)) if !KNOWN_IDS.contains(&here) => end + 1,
        _ => end,
    }
}

/// Chunk ids common enough to beat a spec-conforming pad byte in
/// [`after_pad`].
const KNOWN_IDS: [&[u8]; 12] = [
    b"fmt ", b"data", b"LIST", b"fact", b"JUNK", b"junk", b"PAD ", b"bext", b"iXML", b"cue ",
    b"smpl", b"id3 ",
];

/// Largest `LIST` chunk after the data whose tags are read; larger ones are
/// skipped.
const MAX_TRAILING_LIST_BYTES: usize = 1024 * 1024;

/// Best-effort, incremental scan of the chunks after the `data` chunk for
/// `LIST/INFO` tags.
///
/// Only chunk headers and `LIST` bodies are held; other chunk bodies are
/// skipped as they arrive, so tags behind chunks of any size are found in
/// bounded memory. Anything malformed ends the scan.
#[derive(Debug, Default)]
pub struct TrailingScanner {
    /// Bytes to drop before the next chunk header.
    skip: u64,
    /// The next chunk may be preceded by a pad byte.
    pad: bool,
    /// A partial chunk header, or the `LIST` chunk being collected.
    buf: Vec<u8>,
    /// Size (header included) of the `LIST` chunk being collected.
    list: Option<usize>,
    done: bool,
    /// Tags found so far.
    pub tags: Vec<(String, String)>,
}

impl TrailingScanner {
    /// Starts after a data chunk of `data_len` bytes (odd sizes are padded).
    #[must_use]
    pub fn new(data_len: u32) -> Self {
        Self {
            pad: data_len % 2 == 1,
            ..Self::default()
        }
    }

    /// Bytes currently held.
    #[must_use]
    pub fn buffered_len(&self) -> usize {
        self.buf.len()
    }

    /// Scans the next piece of input.
    pub fn push(&mut self, mut input: &[u8]) {
        while !input.is_empty() && !self.done {
            if self.skip > 0 {
                let n = input
                    .len()
                    .min(usize::try_from(self.skip).unwrap_or(usize::MAX));
                self.skip -= n as u64;
                input = &input[n..];
                continue;
            }
            let want = match self.list {
                Some(total) => total,
                // A possible pad byte is decided on the first five bytes.
                None if self.pad => 5,
                None => 8,
            };
            let n = (want - self.buf.len()).min(input.len());
            self.buf.extend_from_slice(&input[..n]);
            input = &input[n..];
            if self.buf.len() < want {
                continue;
            }
            if let Some(total) = self.list.take() {
                parse_list(&self.buf[8..], &mut self.tags);
                self.pad = (total - 8) % 2 == 1;
                self.buf.clear();
            } else if self.pad {
                self.pad = false;
                if after_pad(&self.buf, 0) == 1 {
                    self.buf.remove(0);
                }
            } else if !is_chunk_id(&self.buf[..4]) {
                self.done = true;
                self.buf = Vec::new();
            } else {
                let len = le_u32(&self.buf, 4) as usize;
                if &self.buf[..4] == b"LIST" && len <= MAX_TRAILING_LIST_BYTES {
                    self.list = Some(8 + len);
                } else {
                    self.skip = len as u64;
                    self.pad = len % 2 == 1;
                    self.buf.clear();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt_pcm(channels: u16, rate: u32, bits: u16) -> Vec<u8> {
        let ba = channels * bits.div_ceil(8);
        let mut v = Vec::new();
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&channels.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&(rate * u32::from(ba)).to_le_bytes());
        v.extend_from_slice(&ba.to_le_bytes());
        v.extend_from_slice(&bits.to_le_bytes());
        v
    }

    fn wav(chunks: &[(&[u8; 4], Vec<u8>)], data: &[u8]) -> Vec<u8> {
        let mut body = b"WAVE".to_vec();
        for (id, c) in chunks {
            body.extend_from_slice(*id);
            body.extend_from_slice(&(c.len() as u32).to_le_bytes());
            body.extend_from_slice(c);
            if c.len() % 2 == 1 {
                body.push(0);
            }
        }
        body.extend_from_slice(b"data");
        body.extend_from_slice(&(data.len() as u32).to_le_bytes());
        body.extend_from_slice(data);
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn parses_plain_pcm16() {
        let f = wav(&[(b"fmt ", fmt_pcm(2, 44100, 16))], &[0; 8]);
        let HeaderState::Done(h) = parse_header(&f, true).unwrap() else {
            panic!("expected header")
        };
        assert_eq!(h.channels, 2);
        assert_eq!(h.sample_rate, 44100);
        assert_eq!(h.valid_bits, 16);
        assert_eq!(h.container_bytes, 2);
        assert_eq!(h.data_offset, 44);
        assert_eq!(h.data_len, 8);
        assert_eq!(h.total_frames(), 2);
    }

    #[test]
    fn every_prefix_needs_more_or_truncates() {
        let f = wav(&[(b"fmt ", fmt_pcm(1, 8000, 8))], &[]);
        for n in 0..44 {
            match parse_header(&f[..n], false) {
                Ok(HeaderState::NeedMore) => {}
                other => panic!("prefix {n}: {other:?}"),
            }
            let e = parse_header(&f[..n], true).unwrap_err();
            assert_eq!(e.code(), ErrorCode::Truncated, "prefix {n}");
        }
        assert!(matches!(parse_header(&f, false), Ok(HeaderState::Done(_))));
        // One resumable parser fed the growing prefix reaches the same result.
        let mut p = HeaderParser::new();
        for n in 0..44 {
            assert!(
                matches!(p.parse(&f[..n], false), Ok(HeaderState::NeedMore)),
                "{n}"
            );
        }
        let HeaderState::Done(h) = p.parse(&f, false).unwrap() else {
            panic!("expected header")
        };
        assert_eq!(h.data_offset, 44);
    }

    #[test]
    fn odd_chunk_pad_and_info_tags() {
        let mut list = b"INFO".to_vec();
        list.extend_from_slice(b"INAM");
        list.extend_from_slice(&5u32.to_le_bytes());
        list.extend_from_slice(b"Song\0");
        list.push(0); // pad
        list.extend_from_slice(b"IART");
        list.extend_from_slice(&4u32.to_le_bytes());
        list.extend_from_slice(&[0x4D, 0xFC, 0x6C, 0x6C]); // "Müll" in Latin-1
        let f = wav(
            &[
                (b"JUNK", vec![1, 2, 3]),
                (b"fmt ", fmt_pcm(1, 8000, 16)),
                (b"LIST", list),
            ],
            &[0; 4],
        );
        let HeaderState::Done(h) = parse_header(&f, true).unwrap() else {
            panic!()
        };
        assert_eq!(
            h.tags,
            vec![
                ("TITLE".into(), "Song".into()),
                ("ARTIST".into(), "Müll".into())
            ]
        );
    }

    #[test]
    fn rejects_bad_magic_early() {
        assert_eq!(
            parse_header(b"OggS", false).unwrap_err().code(),
            ErrorCode::InvalidWav
        );
        assert_eq!(
            parse_header(b"RF64\0\0\0\0WAVE", false).unwrap_err().code(),
            ErrorCode::UnsupportedFormat
        );
    }

    #[test]
    fn maps_every_hound_error() {
        let cases = [
            (hound::Error::Unsupported, ErrorCode::UnsupportedFormat),
            (
                hound::Error::FormatError("bits per sample is not a multiple of 8"),
                ErrorCode::UnsupportedBitDepth,
            ),
            (hound::Error::FormatError("bad"), ErrorCode::InvalidWav),
            (hound::Error::TooWide, ErrorCode::InvalidWav),
            (hound::Error::InvalidSampleFormat, ErrorCode::InvalidWav),
        ];
        for (e, code) in cases {
            assert_eq!(map_hound(e).code(), code);
        }
    }

    #[test]
    fn rejects_bad_fmt_bodies() {
        let fmt = |tag: u16, ch: u16, rate: u32, align: u16, bits: u16| {
            let mut f = tag.to_le_bytes().to_vec();
            f.extend_from_slice(&ch.to_le_bytes());
            f.extend_from_slice(&rate.to_le_bytes());
            f.extend_from_slice(&(rate * u32::from(align)).to_le_bytes());
            f.extend_from_slice(&align.to_le_bytes());
            f.extend_from_slice(&bits.to_le_bytes());
            f
        };
        let cases = [
            (vec![1, 0, 1, 0], ErrorCode::InvalidWav),
            (fmt(0x0055, 1, 8000, 1, 8), ErrorCode::UnsupportedFormat),
            (fmt(0x0003, 1, 8000, 8, 64), ErrorCode::UnsupportedFormat),
            (fmt(0x0001, 1, 8000, 5, 40), ErrorCode::UnsupportedBitDepth),
            (fmt(0x0001, 1, 0, 2, 16), ErrorCode::InvalidWav),
        ];
        for (raw, code) in cases {
            let got = parse_fmt(&raw).err().map(|e| e.code());
            assert_eq!(got, Some(code), "{raw:?}");
        }
    }

    #[test]
    fn rejects_data_before_fmt() {
        let mut f = b"RIFF\x24\0\0\0WAVEdata\0\0\0\0".to_vec();
        f.extend_from_slice(&[0; 16]);
        assert_eq!(
            parse_header(&f, true).unwrap_err().code(),
            ErrorCode::InvalidWav
        );
    }

    fn chunk(id: [u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = id.to_vec();
        v.extend_from_slice(&(body.len() as u32).to_le_bytes());
        v.extend_from_slice(body);
        if body.len() % 2 == 1 {
            v.push(0);
        }
        v
    }

    fn info_list(title: &str) -> Vec<u8> {
        let mut list = b"INFO".to_vec();
        list.extend_from_slice(&chunk(*b"INAM", title.as_bytes()));
        list
    }

    #[test]
    fn trailing_scanner_skips_big_chunks_in_any_split() {
        let mut tail = vec![0]; // pad of an odd data chunk
        tail.extend(chunk(*b"JUNK", &vec![7; 3 * 1024 * 1024 + 1]));
        tail.extend(chunk(*b"LIST", &info_list("Tail")));
        tail.extend(chunk(*b"LIST", &vec![0; MAX_TRAILING_LIST_BYTES + 1]));
        tail.extend(chunk(*b"LIST", &info_list("Last")));
        let want = vec![
            ("TITLE".to_string(), "Tail".to_string()),
            ("TITLE".to_string(), "Last".to_string()),
        ];
        for step in [1, 3, 8, 4096, tail.len()] {
            let mut t = TrailingScanner::new(3);
            for piece in tail.chunks(step) {
                t.push(piece);
                assert!(t.buffered_len() <= MAX_TRAILING_LIST_BYTES + 8);
            }
            assert_eq!(t.tags, want, "step {step}");
        }
    }

    #[test]
    fn trailing_scanner_stops_at_garbage() {
        let mut tail = b"\xff\xfe garbage".to_vec();
        tail.extend(chunk(*b"LIST", &info_list("No")));
        let mut t = TrailingScanner::new(2);
        t.push(&tail);
        assert!(t.tags.is_empty());
        assert_eq!(t.buffered_len(), 0);
        // A chunk right after an odd data chunk without its pad is still read.
        let mut t = TrailingScanner::new(1);
        t.push(&chunk(*b"LIST", &info_list("Yes")));
        assert_eq!(t.tags.len(), 1);
    }
}
