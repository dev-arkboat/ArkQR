// Chroma: 4-state color modules (white/red/green/blue = 2 bits each) on the
// dot-grid geometry. Anchors stay black, so detection is unchanged; only
// module classification goes from luminance threshold to nearest-reference
// color match. Calibration rides IN the grid: the first 8 cells carry a
// fixed white/red/green/blue reference pattern, sampled per capture —
// white-balance shifts move references and data together, which is what
// makes this viable at all. RS(255,223) protects the layer like binary dots.

import { RS_DATA, RS_PARITY } from './codec.js';
import { DOT_SIZES, type DotSize } from './grid.js';
import { rsDecode, rsEncode } from './rs.js';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Emitted palette, index = 2-bit value. Pure channels only. */
export const CHROMA_PALETTE: RGB[] = [
  { r: 255, g: 255, b: 255 }, // 0 white
  { r: 255, g: 0, b: 0 }, // 1 red
  { r: 0, g: 255, b: 0 }, // 2 green
  { r: 0, g: 0, b: 255 }, // 3 blue
];

/** First 8 data cells, row-major: two reference samples per palette color. */
export const CHROMA_REF_CELLS = 8;
const REF_PATTERN = [0, 1, 2, 3, 0, 1, 2, 3];

/** Nearest reference color for a received sample; margin = runner-up gap. */
export function classifyChroma(
  sample: RGB,
  refs: [RGB, RGB, RGB, RGB],
): { value: 0 | 1 | 2 | 3; margin: number } {
  let best = 0;
  let nearest = Number.POSITIVE_INFINITY;
  let second = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 4; i++) {
    const ref = refs[i];
    const d = Math.sqrt(
      (sample.r - ref.r) ** 2 + (sample.g - ref.g) ** 2 + (sample.b - ref.b) ** 2,
    );
    if (d < nearest) {
      second = nearest;
      nearest = d;
      best = i;
    } else if (d < second) {
      second = d;
    }
  }
  return { value: best as 0 | 1 | 2 | 3, margin: second - nearest };
}

/** References must be mutually distinct, else the capture is unusable. */
export function refsUsable(refs: [RGB, RGB, RGB, RGB], minDist = 40): boolean {
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const a = refs[i];
      const b = refs[j];
      const d = Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
      if (d < minDist) return false;
    }
  }
  return true;
}

/** Four 2-bit values <-> one byte, MSB first. */
export function packQuads(values: Uint8Array): Uint8Array {
  if (values.length % 4 !== 0) throw new Error('quad count must be a multiple of 4');
  const out = new Uint8Array(values.length / 4);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v > 3) throw new Error(`bad color value ${v}`);
    out[i >>> 2] |= v << (2 * (3 - (i & 3)));
  }
  return out;
}

export function unpackQuads(packed: Uint8Array, count: number): Uint8Array {
  const values = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    values[i] = (packed[i >>> 2] >>> (2 * (3 - (i & 3)))) & 3;
  }
  return values;
}

export interface ChromaPayload {
  D: DotSize;
  /** 2-bit cell values, row-major, refs first: exactly D*D entries. */
  values: Uint8Array;
}

/** Frame bytes -> RS chunks -> quads -> cells with reference header. */
export function chromaEncodeFrame(frame: Uint8Array): ChromaPayload {
  if (frame.length === 0) throw new Error('empty frame');
  const chunks = Math.max(1, Math.ceil(frame.length / RS_DATA));
  const dataLen = chunks * RS_DATA;
  const padded = new Uint8Array(dataLen);
  padded.set(frame.subarray(0, frame.length), 0);
  const codewords = new Uint8Array(dataLen + chunks * RS_PARITY);
  for (let c = 0; c < chunks; c++) {
    const data = padded.subarray(c * RS_DATA, (c + 1) * RS_DATA);
    codewords.set(rsEncode(data, RS_PARITY), c * (RS_DATA + RS_PARITY));
  }
  // 4 cells per codeword byte + reference header.
  const cellsNeeded = codewords.length * 4 + CHROMA_REF_CELLS;
  let D: DotSize = DOT_SIZES[DOT_SIZES.length - 1];
  let fits = false;
  for (const candidate of DOT_SIZES) {
    if (candidate * candidate >= cellsNeeded) {
      D = candidate;
      fits = true;
      break;
    }
  }
  if (!fits)
    throw new Error(`frame too large for chroma grid: needs ${cellsNeeded} cells`);
  const values = new Uint8Array(D * D);
  for (let i = 0; i < CHROMA_REF_CELLS; i++) values[i] = REF_PATTERN[i];
  const quads = unpackQuads(codewords, codewords.length * 4);
  values.set(quads, CHROMA_REF_CELLS);
  return { D, values };
}

/**
 * Packed classified values + declared frame length -> frame bytes, or null.
 * Geometry re-derives deterministically from metadata like binary dots.
 */
export function chromaDecodeGrid(
  packed: Uint8Array,
  frameBytes: number,
): Uint8Array | null {
  if (frameBytes <= 0) return null;
  const chunks = Math.max(1, Math.ceil(frameBytes / RS_DATA));
  const dataLen = chunks * RS_DATA;
  const codeLen = dataLen + chunks * RS_PARITY;
  const cellsNeeded = codeLen * 4 + CHROMA_REF_CELLS;
  let D: DotSize | null = null;
  for (const candidate of DOT_SIZES) {
    if (candidate * candidate >= cellsNeeded) {
      D = candidate;
      break;
    }
  }
  if (D === null) return null;
  if (packed.length !== Math.ceil((D * D) / 4)) return null;
  const values = unpackQuads(packed, D * D);
  const quads = values.slice(CHROMA_REF_CELLS, CHROMA_REF_CELLS + codeLen * 4);
  const codewords = packQuads(quads);
  const data = new Uint8Array(dataLen);
  const stride = RS_DATA + RS_PARITY;
  for (let c = 0; c < chunks; c++) {
    const chunk = codewords.subarray(c * stride, (c + 1) * stride);
    if (chunk.length !== stride) return null;
    const fixed = rsDecode(chunk, RS_PARITY);
    if (!fixed) return null;
    data.set(fixed, c * RS_DATA);
  }
  return data.slice(0, frameBytes);
}
