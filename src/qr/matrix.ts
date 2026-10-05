// Pure (DOM-free) QR encoding: raw frame bytes -> module matrix.
// Byte mode is fed a latin-1 string so every byte value 0..255 lands in the
// symbol verbatim (qrcode-generator's default Byte converter is `c & 0xff`).

import qrcode from 'qrcode-generator';

export interface QrMatrix {
  /** Modules per side (21 + 4*(version-1)). */
  size: number;
  dark: (row: number, col: number) => boolean;
}

/** Offered correction levels. M is sturdy; L packs the same bytes smaller. */
export type EcLevel = 'L' | 'M';

/** Frame bytes -> latin-1 string, chunked to avoid arg-list limits. */
export function bytesToLatin1(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return s;
}

/** Latin-1 string -> bytes (inverse of bytesToLatin1; for decoded text). */
export function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Encode one frame as a binary (byte-mode) QR symbol, auto version. */
export function encodeToMatrix(payload: Uint8Array, ecLevel: EcLevel = 'M'): QrMatrix {
  const qr = qrcode(0, ecLevel);
  qr.addData(bytesToLatin1(payload), 'Byte');
  qr.make();
  return {
    size: qr.getModuleCount(),
    dark: (row: number, col: number) => qr.isDark(row, col),
  };
}

/**
 * Rasterize a matrix to raw grayscale pixels (pure function, no canvas) for
 * tests: white background, black modules, quiet zone included.
 */
export function matrixToPixels(
  matrix: QrMatrix,
  scale: number,
  quietModules = 4,
): { width: number; height: number; data: Uint8ClampedArray } {
  const total = matrix.size + quietModules * 2;
  const width = total * scale;
  const height = total * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  // Opaque white.
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (!matrix.dark(r, c)) continue;
      for (let y = 0; y < scale; y++) {
        const py = (r + quietModules) * scale + y;
        for (let x = 0; x < scale; x++) {
          const px = (c + quietModules) * scale + x;
          const o = (py * width + px) * 4;
          data[o] = 0;
          data[o + 1] = 0;
          data[o + 2] = 0;
        }
      }
    }
  }
  return { width, height, data };
}
