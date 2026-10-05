// DOM canvas painting for dot grids: rasterize once with the shared pure
// geometry (src/dot/grid.ts), then blit scaled with smoothing off. Binary
// dots are black-on-white (anchor detection assumes dark-on-white); chroma
// uses the fixed 4-color palette with per-grid calibration references.

import { chromaEncodeFrame, CHROMA_PALETTE } from './chroma.js';
import { dotEncodeFrame } from './codec.js';
import { bytesToPaddedBits, renderColorGridPixels, renderGridPixels } from './grid.js';

export interface DotPaintOptions {
  targetSize?: number;
}

function blit(
  canvas: HTMLCanvasElement,
  pixels: { width: number; data: Uint8ClampedArray<ArrayBuffer> },
  targetSize: number,
): void {
  const scratch = document.createElement('canvas');
  scratch.width = pixels.width;
  scratch.height = pixels.width;
  const sctx = scratch.getContext('2d');
  if (!sctx) throw new Error('2d canvas context unavailable');
  sctx.putImageData(new ImageData(pixels.data, pixels.width, pixels.width), 0, 0);
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetSize, targetSize);
  ctx.drawImage(scratch, 0, 0, targetSize, targetSize);
}

/** Paint frame bytes as an anchored dot grid, sizing the canvas to fit. */
export function paintDots(
  canvas: HTMLCanvasElement,
  payload: Uint8Array,
  opts: DotPaintOptions = {},
): void {
  const targetSize = opts.targetSize ?? 640;
  const { D, bytes } = dotEncodeFrame(payload);
  const bits = bytesToPaddedBits(bytes, D);
  // Render at a fixed fine resolution, then scale down crisply.
  const modulePx = 8;
  blit(canvas, renderGridPixels(bits, D, modulePx), targetSize);
}

/** Paint frame bytes as a 4-color grid (2 bits per module + references). */
export function paintChroma(
  canvas: HTMLCanvasElement,
  payload: Uint8Array,
  opts: DotPaintOptions = {},
): void {
  const targetSize = opts.targetSize ?? 640;
  const { D, values } = chromaEncodeFrame(payload);
  const modulePx = 8;
  blit(canvas, renderColorGridPixels(values, D, modulePx, CHROMA_PALETTE), targetSize);
}
