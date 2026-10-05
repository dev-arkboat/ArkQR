// DOM canvas rendering of QR matrices: large, high-contrast, white
// background, proper quiet zone, integer scaling. The QR stream is the one
// intentionally animated surface (exempt from prefers-reduced-motion).

import { encodeToMatrix, type EcLevel, type QrMatrix } from './matrix.js';

export type InkName = 'black' | 'red' | 'green' | 'blue';

/**
 * Module ink palette. Decoding reads luminance, so red/blue behave like
 * black; pure green is much lighter and may scan worse on some phones
 * (labelled experimental in the UI). Presentation only — never wire format.
 */
export const INK_COLORS: Record<InkName, string> = {
  black: '#000000',
  red: '#ff0000',
  green: '#00ff00',
  blue: '#0000ff',
};

/** Rec.709 relative luminance of a #rrggbb color, 0 (black) to 255 (white). */
export function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export interface PaintOptions {
  /** Target canvas CSS/bitmap size in px (canvas is square). Default 640. */
  targetSize?: number;
  /** Quiet-zone width in modules. Default 4 (QR spec minimum). */
  quietModules?: number;
  foreground?: string;
  background?: string;
  ecLevel?: EcLevel;
}

/** Paint a precomputed matrix onto a canvas, sizing the canvas to fit. */
export function paintMatrix(
  canvas: HTMLCanvasElement,
  matrix: QrMatrix,
  opts: PaintOptions = {},
): void {
  const targetSize = opts.targetSize ?? 640;
  const quiet = opts.quietModules ?? 4;
  const fg = opts.foreground ?? '#000000';
  const bg = opts.background ?? '#ffffff';
  const total = matrix.size + quiet * 2;
  const scale = Math.max(1, Math.floor(targetSize / total));
  const px = total * scale;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = fg;
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.dark(r, c))
        ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
}

/** Encode frame bytes and paint them in one step (SEND hot path). */
export function paintFrame(
  canvas: HTMLCanvasElement,
  payload: Uint8Array,
  opts: PaintOptions = {},
): QrMatrix {
  const matrix = encodeToMatrix(payload, opts.ecLevel ?? 'M');
  paintMatrix(canvas, matrix, opts);
  return matrix;
}
