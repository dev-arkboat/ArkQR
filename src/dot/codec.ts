// Dot-grid error protection: frame bytes -> RS(255,223) chunks -> grid.
// Each 223-byte data chunk gets 32 parity bytes (repairs 16 bad bytes per
// chunk). Chunking is deterministic from the frame length alone: the frame is
// zero-padded up to a 223 multiple, every chunk is full, and the receiver
// recomputes the same geometry from metadata — no signaling needed.

import { dForFrameBytes, type DotSize } from './grid.js';
import { rsDecode, rsEncode } from './rs.js';

export const RS_DATA = 223;
export const RS_PARITY = 32;

export interface DotPayload {
  D: DotSize;
  /** RS codewords + zero grid padding: exactly D*D/8 bytes. */
  bytes: Uint8Array;
}

/** Frame bytes -> padded grid payload (RS-protected). */
export function dotEncodeFrame(frame: Uint8Array): DotPayload {
  if (frame.length === 0) throw new Error('empty frame');
  const chunks = Math.max(1, Math.ceil(frame.length / RS_DATA));
  const dataLen = chunks * RS_DATA;
  const padded = new Uint8Array(dataLen);
  padded.set(frame.subarray(0, frame.length), 0);
  const total = dataLen + chunks * RS_PARITY;
  const D = dForFrameBytes(total);
  const out = new Uint8Array((D * D) / 8);
  for (let c = 0; c < chunks; c++) {
    const data = padded.subarray(c * RS_DATA, (c + 1) * RS_DATA);
    out.set(rsEncode(data, RS_PARITY), c * (RS_DATA + RS_PARITY));
  }
  return { D, bytes: out };
}

/**
 * Sampled grid bytes + declared frame length -> frame bytes, or null.
 * Lengths are re-derived from metadata, RS-decoded per chunk, truncated.
 */
export function dotDecodeGrid(
  sampled: Uint8Array,
  frameBytes: number,
): Uint8Array | null {
  if (frameBytes <= 0) return null;
  const chunks = Math.max(1, Math.ceil(frameBytes / RS_DATA));
  const dataLen = chunks * RS_DATA;
  const total = dataLen + chunks * RS_PARITY;
  let D: DotSize;
  try {
    D = dForFrameBytes(total);
  } catch {
    return null;
  }
  if (sampled.length !== (D * D) / 8) return null;
  const data = new Uint8Array(dataLen);
  const stride = RS_DATA + RS_PARITY;
  for (let c = 0; c < chunks; c++) {
    const chunk = sampled.subarray(c * stride, (c + 1) * stride);
    if (chunk.length !== stride) return null;
    const fixed = rsDecode(chunk, RS_PARITY);
    if (!fixed) return null;
    data.set(fixed, c * RS_DATA);
  }
  return data.slice(0, frameBytes);
}
