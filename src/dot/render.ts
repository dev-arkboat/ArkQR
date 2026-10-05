// DOM canvas painting for dot grids: rasterize once with the shared pure
// geometry (src/dot/grid.ts), then blit scaled with smoothing off. Black
// modules only — anchor detection assumes dark-on-white.

import { dotEncodeFrame } from './codec.js';
import { bytesToPaddedBits, renderGridPixels } from './grid.js';

export interface DotPaintOptions {
  targetSize?: number;
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
  const { width, data } = renderGridPixels(bits, D, modulePx);
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = width;
  const sctx = scratch.getContext('2d');
  if (!sctx) throw new Error('2d canvas context unavailable');
  sctx.putImageData(new ImageData(data, width, width), 0, 0);
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetSize, targetSize);
  ctx.drawImage(scratch, 0, 0, targetSize, targetSize);
}
