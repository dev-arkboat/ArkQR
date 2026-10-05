// Dot-matrix physical layer (experimental alternative to QR symbols).
// Carries IDENTICAL frame bytes (magic + version + type + session + payload
// + CRC); only the pixels differ. There is deliberately NO per-symbol error
// correction: any misread bit fails the frame CRC and the fountain code
// absorbs the drop. Tuned for close-range, centered captures. All geometry
// lives here, shared byte-for-byte by the renderer and the detector.

export const DOT_SIZES = [96, 144] as const;
export type DotSize = (typeof DOT_SIZES)[number];

/** Regular corner anchor side, in data modules. */
export const DOT_ANCHOR = 5;
/** Top-left anchor is bigger: absolute orientation without trial rotations. */
export const DOT_ANCHOR_TL = 7;
/** Gap between data edge and anchor inner edge, in modules. */
export const DOT_GAP = 5;
/** White margin beyond anchors, in modules. */
export const DOT_QUIET = 4;

/** Smallest grid whose bits fit n bytes (throws past DOT coverage). */
export function dForFrameBytes(n: number): DotSize {
  for (const d of DOT_SIZES) {
    if ((d * d) / 8 >= n) return d;
  }
  throw new Error(`frame too large for dot grid: ${n} bytes`);
}

export interface AnchorSquare {
  /** Top-left corner + side, in data-module coordinates (data at 0..D). */
  x: number;
  y: number;
  size: number;
}

/** Four anchors around the data area: TL distinctive, rest identical. */
export function anchorSquares(D: number): AnchorSquare[] {
  return [
    { x: -DOT_GAP - DOT_ANCHOR_TL, y: -DOT_GAP - DOT_ANCHOR_TL, size: DOT_ANCHOR_TL },
    { x: D + DOT_GAP, y: -DOT_GAP - DOT_ANCHOR, size: DOT_ANCHOR },
    { x: -DOT_GAP - DOT_ANCHOR, y: D + DOT_GAP, size: DOT_ANCHOR },
    { x: D + DOT_GAP, y: D + DOT_GAP, size: DOT_ANCHOR },
  ];
}

/** Anchor centers in data-module coordinates, clockwise: TL, TR, BR, BL. */
export function anchorCenters(D: number): { x: number; y: number }[] {
  const squares = anchorSquares(D);
  const ordered = [squares[0], squares[1], squares[3], squares[2]];
  return ordered.map((a) => ({ x: a.x + a.size / 2, y: a.y + a.size / 2 }));
}

/** Full canvas extent in modules, quiet zone included. */
export function gridExtent(D: number): { min: number; span: number } {
  const min = -DOT_GAP - DOT_ANCHOR_TL - DOT_QUIET;
  const max = D + DOT_GAP + DOT_ANCHOR + DOT_QUIET;
  return { min, span: max - min };
}

/** Bytes -> bits, MSB first, zero-padded to D*D. */
export function bytesToPaddedBits(data: Uint8Array, D: number): Uint8Array {
  const bits = new Uint8Array(D * D);
  const total = Math.min(data.length * 8, bits.length);
  for (let i = 0; i < total; i++) {
    bits[i] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
  }
  return bits;
}

/** Bits (MSB first, row-major) -> bytes. Length must be a multiple of 8. */
export function bitsToBytes(bits: Uint8Array): Uint8Array {
  if (bits.length % 8 !== 0) throw new Error('bit length must be a multiple of 8');
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >>> 3] |= 1 << (7 - (i & 7));
  }
  return out;
}

/**
 * Rasterize a dot grid to raw pixels (white bg, black round data dots,
 * square anchors). Single geometry source for canvas painting and tests.
 */
export function renderGridPixels(
  bits: Uint8Array,
  D: number,
  modulePx: number,
): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
  if (bits.length !== D * D) throw new Error('bit count must equal D*D');
  const { min, span } = gridExtent(D);
  const size = Math.ceil(span * modulePx);
  // Explicit ArrayBuffer so the pixels feed ImageData directly.
  const data = new Uint8ClampedArray(new ArrayBuffer(size * size * 4));
  data.fill(255);
  const put = (px: number, py: number): void => {
    if (px < 0 || py < 0 || px >= size || py >= size) return;
    const o = (py * size + px) * 4;
    data[o] = 0;
    data[o + 1] = 0;
    data[o + 2] = 0;
    data[o + 3] = 255;
  };
  const toPx = (m: number): number => Math.round((m - min) * modulePx);
  // Data dots (inscribed circles).
  for (let j = 0; j < D; j++) {
    for (let i = 0; i < D; i++) {
      if (!bits[j * D + i]) continue;
      const cx = toPx(i + 0.5);
      const cy = toPx(j + 0.5);
      const r = modulePx / 2;
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(x, y);
        }
      }
    }
  }
  // Anchors (solid squares).
  for (const a of anchorSquares(D)) {
    const x0 = toPx(a.x);
    const y0 = toPx(a.y);
    const s = Math.round(a.size * modulePx);
    for (let y = y0; y < y0 + s; y++) {
      for (let x = x0; x < x0 + s; x++) put(x, y);
    }
  }
  return { width: size, height: size, data };
}
