//! FLAC bitstream format constants (field lengths and type masks), from
//! `FLAC/format.h` (values in its doc comments) / `format.c`.

// Frame header field lengths (bits) and the sync code.
pub const FRAME_HEADER_SYNC: u32 = 0x3ffe;
pub const FRAME_HEADER_SYNC_LEN: u32 = 14;
pub const FRAME_HEADER_RESERVED_LEN: u32 = 1;
pub const FRAME_HEADER_BLOCKING_STRATEGY_LEN: u32 = 1;
pub const FRAME_HEADER_BLOCK_SIZE_LEN: u32 = 4;
pub const FRAME_HEADER_SAMPLE_RATE_LEN: u32 = 4;
pub const FRAME_HEADER_CHANNEL_ASSIGNMENT_LEN: u32 = 4;
pub const FRAME_HEADER_BITS_PER_SAMPLE_LEN: u32 = 3;
pub const FRAME_HEADER_ZERO_PAD_LEN: u32 = 1;
pub const FRAME_HEADER_CRC_LEN: u32 = 8;
pub const FRAME_FOOTER_CRC_LEN: u32 = 16;

// Subframe header.
pub const SUBFRAME_ZERO_PAD_LEN: u32 = 1;
pub const SUBFRAME_TYPE_LEN: u32 = 6;
pub const SUBFRAME_WASTED_BITS_FLAG_LEN: u32 = 1;
/// The fixed-size subframe header written as one byte-aligned unit.
pub const SUBFRAME_HEADER_LEN: u32 =
    SUBFRAME_ZERO_PAD_LEN + SUBFRAME_TYPE_LEN + SUBFRAME_WASTED_BITS_FLAG_LEN; // 8

// Subframe type codes, pre-shifted into the byte-aligned header
// (`...BYTE_ALIGNED_MASK`): the 6-bit type sits at bits 6..1, leaving bit 0 for
// the wasted-bits flag and bit 7 for the zero pad.
pub const SUBFRAME_TYPE_CONSTANT_BYTE_ALIGNED_MASK: u32 = 0x00;
pub const SUBFRAME_TYPE_VERBATIM_BYTE_ALIGNED_MASK: u32 = 0x02;
pub const SUBFRAME_TYPE_FIXED_BYTE_ALIGNED_MASK: u32 = 0x10;
pub const SUBFRAME_TYPE_LPC_BYTE_ALIGNED_MASK: u32 = 0x40;

pub const SUBFRAME_LPC_QLP_COEFF_PRECISION_LEN: u32 = 4;
pub const SUBFRAME_LPC_QLP_SHIFT_LEN: u32 = 5;

// Entropy coding method.
pub const ENTROPY_CODING_METHOD_TYPE_LEN: u32 = 2;
pub const ENTROPY_CODING_METHOD_PARTITIONED_RICE: u32 = 0;
pub const ENTROPY_CODING_METHOD_PARTITIONED_RICE2: u32 = 1;
pub const ENTROPY_CODING_METHOD_PARTITIONED_RICE_ORDER_LEN: u32 = 4;
pub const ENTROPY_CODING_METHOD_PARTITIONED_RICE_PARAMETER_LEN: u32 = 4;
pub const ENTROPY_CODING_METHOD_PARTITIONED_RICE2_PARAMETER_LEN: u32 = 5;
pub const ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER: u32 = 15;
pub const ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER: u32 = 31;

pub const MAX_FIXED_ORDER: u32 = 4;
pub const MAX_LPC_ORDER: u32 = 32;

// QLP coefficient precision bounds (`FLAC__MIN/MAX_QLP_COEFF_PRECISION`).
pub const MIN_QLP_COEFF_PRECISION: u32 = 5;
pub const MAX_QLP_COEFF_PRECISION: u32 = 15;
