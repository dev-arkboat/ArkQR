// DOM canvas rendering of QR matrices: large, high-contrast, white
// background, proper quiet zone, integer scaling. The QR stream is the one
// intentionally animated surface (exempt from prefers-reduced-motion).

import { encodeToMatrix, type QrMatrix } from './matrix.js';
import { quadCells } from './tiles.js';

export interface PaintOptions {
  /** Target canvas CSS/bitmap size in px (canvas is square). Default 640. */
  targetSize?: number;
  /** Quiet-zone width in modules. Default 4 (QR spec minimum). */
  quietModules?: number;
  foreground?: string;
  background?: string;
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
  const matrix = encodeToMatrix(payload);
  paintMatrix(canvas, matrix, opts);
  return matrix;
}

/**
 * Paint exactly 4 frames as a 2×2 grid. Each tile keeps its own quiet zone
 * and integer scale (tiles may differ in version, e.g. metadata vs data).
 * Roughly 4× the data per screen refresh at close range.
 */
export function paintQuad(
  canvas: HTMLCanvasElement,
  payloads: Uint8Array[],
  opts: PaintOptions = {},
): void {
  if (payloads.length !== 4) throw new Error('quad layout needs exactly 4 frames');
  const targetSize = opts.targetSize ?? 640;
  const quiet = opts.quietModules ?? 4;
  const fg = opts.foreground ?? '#000000';
  const bg = opts.background ?? '#ffffff';
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, targetSize, targetSize);
  ctx.fillStyle = fg;
  const cells = quadCells(targetSize, 8, 12);
  payloads.forEach((payload, i) => {
    const matrix = encodeToMatrix(payload);
    const cell = cells[i];
    const scale = Math.max(1, Math.floor(cell.size / (matrix.size + quiet * 2)));
    const drawn = matrix.size * scale;
    const ox = cell.x + Math.floor((cell.size - drawn) / 2);
    const oy = cell.y + Math.floor((cell.size - drawn) / 2);
    for (let r = 0; r < matrix.size; r++) {
      for (let c = 0; c < matrix.size; c++) {
        if (matrix.dark(r, c)) {
          ctx.fillRect(ox + (c + quiet) * scale, oy + (r + quiet) * scale, scale, scale);
        }
      }
    }
  });
}
