// Binary frame encoding/decoding (big-endian, fixed header).
// Layout (see PROTOCOL.md):
//   header: magic u16 | version u8 | frameType u8 | sessionId[4]
//   metadata: fileNameLen u16 + fileName | mimeLen u16 + mime |
//             originalSize u32 | compressedSize u32 | compFlag u8 |
//             blockSize u16 | blockCount u32 | sha256[32]
//   data: seed u32 | payload[blockSize]
//   trailer: crc32 u32 over all preceding bytes.
//
// All scanned bytes are untrusted: every length is validated BEFORE any
// allocation, and declared sizes are capped (see constants.ts).

import {
  COMPRESSION_GZIP,
  COMPRESSION_NONE,
  CRC_BYTES,
  FRAME_TYPE_DATA,
  FRAME_TYPE_METADATA,
  HEADER_BYTES,
  MAGIC,
  MAX_BLOCK_SIZE,
  MAX_BLOCKS,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_BYTES,
  MAX_MIME_BYTES,
  MIN_BLOCK_SIZE,
  PROTOCOL_VERSION,
  SESSION_ID_BYTES,
  SEED_BYTES,
  SHA256_BYTES,
} from './constants.js';
import { crc32 } from './crc32.js';

export interface MetadataPayload {
  sessionId: Uint8Array;
  fileName: string;
  mime: string;
  originalSize: number;
  compressedSize: number;
  compressed: boolean;
  blockSize: number;
  blockCount: number;
  sha256: Uint8Array;
}

export interface DataPayload {
  sessionId: Uint8Array;
  seed: number;
  payload: Uint8Array;
}

export type DecodedFrame =
  { kind: 'metadata'; meta: MetadataPayload } | { kind: 'data'; data: DataPayload };

/** CRC mismatch (silently dropped) vs structurally invalid (dropped + counted). */
export type DecodeFailure = { kind: 'crc' } | { kind: 'invalid'; reason: string };

export type DecodeResult =
  { ok: true; frame: DecodedFrame } | { ok: false; failure: DecodeFailure };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, false);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, false);
}

function appendCrc(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + CRC_BYTES);
  out.set(body, 0);
  new DataView(out.buffer, out.byteOffset + body.length, CRC_BYTES).setUint32(
    0,
    crc32(body),
    false,
  );
  return out;
}

function writeHeader(view: DataView, frameType: number, sessionId: Uint8Array): void {
  view.setUint16(0, MAGIC, false);
  view.setUint8(2, PROTOCOL_VERSION);
  view.setUint8(3, frameType);
  view.setUint8(4, sessionId[0]);
  view.setUint8(5, sessionId[1]);
  view.setUint8(6, sessionId[2]);
  view.setUint8(7, sessionId[3]);
}

function checkSessionId(sessionId: Uint8Array): void {
  if (!(sessionId instanceof Uint8Array) || sessionId.length !== SESSION_ID_BYTES) {
    throw new Error('sessionId must be 4 bytes');
  }
}

/** Encode a metadata frame. Throws on out-of-spec values (sender bug). */
export function encodeMetadataFrame(meta: MetadataPayload): Uint8Array {
  checkSessionId(meta.sessionId);
  const nameBytes = textEncoder.encode(meta.fileName);
  const mimeBytes = textEncoder.encode(meta.mime);
  if (nameBytes.length > MAX_FILE_NAME_BYTES) throw new Error('file name too long');
  if (mimeBytes.length > MAX_MIME_BYTES) throw new Error('MIME type too long');
  if (meta.sha256.length !== SHA256_BYTES) throw new Error('sha256 must be 32 bytes');
  validateSizes(meta.originalSize, meta.compressedSize, meta.blockSize, meta.blockCount);

  const body = new Uint8Array(
    HEADER_BYTES +
      2 +
      nameBytes.length +
      2 +
      mimeBytes.length +
      4 +
      4 +
      1 +
      2 +
      4 +
      SHA256_BYTES,
  );
  const view = new DataView(body.buffer, body.byteOffset, body.length);
  writeHeader(view, FRAME_TYPE_METADATA, meta.sessionId);
  let o = HEADER_BYTES;
  writeU16(view, o, nameBytes.length);
  o += 2;
  body.set(nameBytes, o);
  o += nameBytes.length;
  writeU16(view, o, mimeBytes.length);
  o += 2;
  body.set(mimeBytes, o);
  o += mimeBytes.length;
  writeU32(view, o, meta.originalSize);
  o += 4;
  writeU32(view, o, meta.compressedSize);
  o += 4;
  view.setUint8(o, meta.compressed ? COMPRESSION_GZIP : COMPRESSION_NONE);
  o += 1;
  writeU16(view, o, meta.blockSize);
  o += 2;
  writeU32(view, o, meta.blockCount);
  o += 4;
  body.set(meta.sha256, o);
  return appendCrc(body);
}

/** Encode one data frame: header + seed + payload + CRC. */
export function encodeDataFrame(
  sessionId: Uint8Array,
  seed: number,
  payload: Uint8Array,
): Uint8Array {
  checkSessionId(sessionId);
  const body = new Uint8Array(HEADER_BYTES + SEED_BYTES + payload.length);
  const view = new DataView(body.buffer, body.byteOffset, body.length);
  writeHeader(view, FRAME_TYPE_DATA, sessionId);
  view.setUint32(HEADER_BYTES, seed >>> 0, false);
  body.set(payload, HEADER_BYTES + SEED_BYTES);
  return appendCrc(body);
}

function validateSizes(
  originalSize: number,
  compressedSize: number,
  blockSize: number,
  blockCount: number,
): void {
  for (const [label, v] of [
    ['originalSize', originalSize],
    ['compressedSize', compressedSize],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > MAX_FILE_BYTES) {
      throw new Error(`invalid ${label} ${v}`);
    }
  }
  if (
    !Number.isInteger(blockSize) ||
    blockSize < MIN_BLOCK_SIZE ||
    blockSize > MAX_BLOCK_SIZE
  ) {
    throw new Error(`invalid blockSize ${blockSize}`);
  }
  const expected = compressedSize === 0 ? 0 : Math.ceil(compressedSize / blockSize);
  if (!Number.isInteger(blockCount) || blockCount < 0 || blockCount > MAX_BLOCKS) {
    throw new Error(`invalid blockCount ${blockCount}`);
  }
  if (blockCount !== expected) {
    throw new Error(`blockCount ${blockCount} != ceil(${compressedSize}/${blockSize})`);
  }
}

/** Decode one scanned frame. Never throws for wire garbage: returns a failure. */
export function decodeFrame(bytes: Uint8Array): DecodeResult {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_BYTES + CRC_BYTES) {
    return { ok: false, failure: { kind: 'invalid', reason: 'too short' } };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (view.getUint16(0, false) !== MAGIC) {
    return { ok: false, failure: { kind: 'invalid', reason: 'bad magic' } };
  }
  if (view.getUint8(2) !== PROTOCOL_VERSION) {
    return { ok: false, failure: { kind: 'invalid', reason: 'bad version' } };
  }
  const frameType = view.getUint8(3);
  if (frameType !== FRAME_TYPE_METADATA && frameType !== FRAME_TYPE_DATA) {
    return { ok: false, failure: { kind: 'invalid', reason: 'bad frame type' } };
  }
  const body = bytes.subarray(0, bytes.length - CRC_BYTES);
  const want = view.getUint32(bytes.length - CRC_BYTES, false);
  if (crc32(body) !== want) return { ok: false, failure: { kind: 'crc' } };

  const sessionId = bytes.slice(4, 8);
  try {
    if (frameType === FRAME_TYPE_METADATA) {
      return {
        ok: true,
        frame: { kind: 'metadata', meta: parseMetadata(view, bytes, sessionId) },
      };
    }
    return { ok: true, frame: { kind: 'data', data: parseData(bytes, sessionId) } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'parse error';
    return { ok: false, failure: { kind: 'invalid', reason } };
  }
}

function parseMetadata(
  view: DataView,
  bytes: Uint8Array,
  sessionId: Uint8Array,
): MetadataPayload {
  let o = HEADER_BYTES;
  const need = (n: number): void => {
    if (o + n > bytes.length - CRC_BYTES) throw new Error('truncated metadata');
  };

  need(2);
  const nameLen = view.getUint16(o, false);
  o += 2;
  if (nameLen > MAX_FILE_NAME_BYTES) throw new Error('file name too long');
  need(nameLen);
  const fileName = decodeName(bytes.subarray(o, o + nameLen));
  o += nameLen;

  need(2);
  const mimeLen = view.getUint16(o, false);
  o += 2;
  if (mimeLen > MAX_MIME_BYTES) throw new Error('MIME too long');
  need(mimeLen);
  const mime = decodeText(bytes.subarray(o, o + mimeLen), 'MIME');
  o += mimeLen;

  need(4 + 4 + 1 + 2 + 4 + SHA256_BYTES);
  const originalSize = view.getUint32(o, false);
  o += 4;
  const compressedSize = view.getUint32(o, false);
  o += 4;
  const flag = view.getUint8(o);
  o += 1;
  if (flag !== COMPRESSION_NONE && flag !== COMPRESSION_GZIP) {
    throw new Error(`bad compression flag ${flag}`);
  }
  const blockSize = view.getUint16(o, false);
  o += 2;
  const blockCount = view.getUint32(o, false);
  o += 4;
  validateSizes(originalSize, compressedSize, blockSize, blockCount);
  const sha256 = bytes.slice(o, o + SHA256_BYTES);
  o += SHA256_BYTES;
  if (o !== bytes.length - CRC_BYTES) throw new Error('trailing bytes');

  return {
    sessionId,
    fileName,
    mime,
    originalSize,
    compressedSize,
    compressed: flag === COMPRESSION_GZIP,
    blockSize,
    blockCount,
    sha256,
  };
}

function parseData(bytes: Uint8Array, sessionId: Uint8Array): DataPayload {
  if (bytes.length < HEADER_BYTES + SEED_BYTES + CRC_BYTES + 1) {
    throw new Error('data frame too short');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const seed = view.getUint32(HEADER_BYTES, false);
  const payload = bytes.slice(HEADER_BYTES + SEED_BYTES, bytes.length - CRC_BYTES);
  return { sessionId, seed, payload };
}

function decodeText(raw: Uint8Array, what: string): string {
  try {
    return textDecoder.decode(raw);
  } catch {
    throw new Error(`bad UTF-8 in ${what}`);
  }
}

function decodeName(raw: Uint8Array): string {
  const name = decodeText(raw, 'file name');
  if (name.length === 0) throw new Error('empty file name');
  return name;
}
