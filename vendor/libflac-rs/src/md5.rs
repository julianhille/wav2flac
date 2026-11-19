//! MD5 (RFC 1321), ported from `md5.c`, for the STREAMINFO audio checksum.
//!
//! libFLAC hashes the **decoded** audio: each interleaved sample is serialized to
//! its low `bytes_per_sample` bytes, little-endian, sample-major
//! (`format_input_`, `md5.c:275`), and the byte stream is MD5'd. Because MD5 is a
//! streaming hash, hashing the whole concatenated stream equals libFLAC's
//! per-frame `FLAC__MD5Accumulate`. The oracle runs on little-endian x86, so the
//! `byteSwap` paths are no-ops and this is plain little-endian MD5.

/// Per-step left-rotation amounts.
#[rustfmt::skip]
const S: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/// Per-step additive constants (`floor(2^32 * |sin(i+1)|)`).
#[rustfmt::skip]
const K: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/// Streaming MD5 state.
pub struct Md5 {
    state: [u32; 4],
    len_bytes: u64,
    block: [u8; 64],
    block_len: usize,
}

impl Md5 {
    pub fn new() -> Self {
        Self {
            state: [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476],
            len_bytes: 0,
            block: [0u8; 64],
            block_len: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.len_bytes = self.len_bytes.wrapping_add(data.len() as u64);
        if self.block_len > 0 {
            let need = 64 - self.block_len;
            let take = need.min(data.len());
            self.block[self.block_len..self.block_len + take].copy_from_slice(&data[..take]);
            self.block_len += take;
            data = &data[take..];
            if self.block_len == 64 {
                let b = self.block;
                Self::transform(&mut self.state, &b);
                self.block_len = 0;
            }
        }
        while data.len() >= 64 {
            let mut b = [0u8; 64];
            b.copy_from_slice(&data[..64]);
            Self::transform(&mut self.state, &b);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.block[..data.len()].copy_from_slice(data);
            self.block_len = data.len();
        }
    }

    pub fn finalize(mut self) -> [u8; 16] {
        let bit_len = self.len_bytes.wrapping_mul(8);
        // Append the 0x80 terminator (there is always room).
        self.block[self.block_len] = 0x80;
        self.block_len += 1;
        // If there's no room for the 8-byte length, pad+flush this block first.
        if self.block_len > 56 {
            for b in &mut self.block[self.block_len..] {
                *b = 0;
            }
            let b = self.block;
            Self::transform(&mut self.state, &b);
            self.block = [0u8; 64];
            self.block_len = 0;
        }
        for b in &mut self.block[self.block_len..56] {
            *b = 0;
        }
        self.block[56..64].copy_from_slice(&bit_len.to_le_bytes());
        let b = self.block;
        Self::transform(&mut self.state, &b);

        let mut out = [0u8; 16];
        for (i, &w) in self.state.iter().enumerate() {
            out[4 * i..4 * i + 4].copy_from_slice(&w.to_le_bytes());
        }
        out
    }

    fn transform(state: &mut [u32; 4], block: &[u8; 64]) {
        let mut m = [0u32; 16];
        for (i, word) in m.iter_mut().enumerate() {
            *word = u32::from_le_bytes([
                block[4 * i],
                block[4 * i + 1],
                block[4 * i + 2],
                block[4 * i + 3],
            ]);
        }
        let [mut a, mut b, mut c, mut d] = *state;
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | (!b & d), i),
                16..=31 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let rotated = a
                .wrapping_add(f)
                .wrapping_add(K[i])
                .wrapping_add(m[g])
                .rotate_left(S[i]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(rotated);
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
    }
}

/// MD5 of interleaved PCM exactly as libFLAC hashes it: each sample's low
/// `bytes_per_sample` bytes, little-endian, in interleaved (sample-major) order.
pub fn audio_md5(interleaved: &[i32], bytes_per_sample: usize) -> [u8; 16] {
    let mut md5 = Md5::new();
    let mut buf = Vec::with_capacity(interleaved.len() * bytes_per_sample);
    for &s in interleaved {
        buf.extend_from_slice(&(s as u32).to_le_bytes()[..bytes_per_sample]);
    }
    md5.update(&buf);
    md5.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 1321 test vectors.
    #[test]
    fn rfc1321_vectors() {
        let cases: &[(&str, &str)] = &[
            ("", "d41d8cd98f00b204e9800998ecf8427e"),
            ("a", "0cc175b9c0f1b6a831c399e269772661"),
            ("abc", "900150983cd24fb0d6963f7d28e17f72"),
            ("message digest", "f96b697d7cb7938d525a2f31aaf161d0"),
            (
                "abcdefghijklmnopqrstuvwxyz",
                "c3fcd3d76192e4007dfb496cca67e13b",
            ),
        ];
        for &(input, want) in cases {
            let mut md5 = Md5::new();
            md5.update(input.as_bytes());
            let got = md5.finalize();
            let hex: String = got.iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(hex, want, "md5({input:?})");
        }
    }

    /// Updating in pieces must equal a single update (block-boundary handling).
    #[test]
    fn chunked_update_matches() {
        let data: Vec<u8> = (0..200u32).map(|i| (i * 7) as u8).collect();
        let mut whole = Md5::new();
        whole.update(&data);
        let whole = whole.finalize();
        for chunk in [1usize, 13, 64, 65, 100] {
            let mut m = Md5::new();
            for part in data.chunks(chunk) {
                m.update(part);
            }
            assert_eq!(m.finalize(), whole, "chunk size {chunk}");
        }
    }
}
