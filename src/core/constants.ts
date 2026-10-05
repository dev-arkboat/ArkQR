// Shared protocol constants. Single source of truth for limits used by both
// the sender (framing/validation before sending) and the receiver
// (validation of untrusted scanned bytes before allocating memory).

/** First two bytes of every frame: ASCII "AQ" (ArkQR). */
export const MAGIC = 0x4151;
/** Current wire protocol version. */
export const PROTOCOL_VERSION = 1;

/** frameType values. */
export const FRAME_TYPE_METADATA = 0;
export const FRAME_TYPE_DATA = 1;

/** magic(2) + version(1) + frameType(1) + sessionId(4). */
export const HEADER_BYTES = 8;
/** Random session id carried in every frame so transfers are never mixed. */
export const SESSION_ID_BYTES = 4;
/** Seed carried in every data frame header. */
export const SEED_BYTES = 4;
/** IEEE CRC32 trailer appended to every frame. */
export const CRC_BYTES = 4;
/** SHA-256 digest of the ORIGINAL file carried in the metadata frame. */
export const SHA256_BYTES = 32;

/** Upper bound for UTF-8 encoded file names accepted on the wire. */
export const MAX_FILE_NAME_BYTES = 255;
/** Upper bound for UTF-8 encoded MIME types accepted on the wire. */
export const MAX_MIME_BYTES = 128;
/** Hard cap: no transfer may declare more payload than this. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Hard cap on source block count (bounds decoder memory). */
export const MAX_BLOCKS = 16384;
/** Smallest sane block size (header efficiency + QR capacity). */
export const MIN_BLOCK_SIZE = 64;
/** Largest block size: 2048 + 16 header bytes still fits QR version 40-M. */
export const MAX_BLOCK_SIZE = 2048;
/** Byte-mode QR capacity at error correction level M (version 40). */
export const QR_MAX_BYTES_M = 2331;

/** Compression flag values. */
export const COMPRESSION_NONE = 0;
export const COMPRESSION_GZIP = 1;

/** A metadata frame is emitted first, then repeated every N data frames. */
export const METADATA_REPEAT_EVERY = 10;

/** Robust soliton distribution parameters (see soliton.ts). */
export const SOLITON_C = 0.1;
export const SOLITON_DELTA = 0.05;

/** Gauss-Jordan fallback only runs for systems at most this large. */
export const MAX_GE_BLOCKS = 1024;
