// Quad end-to-end (no camera): 4 frames -> 2x2 composed pixels.
// Strategy under test (mirrors the decode worker): the full image misses
// (jsQR handles one code per image), then the four exact halves each recover
// their tile. A lone single-QR image still decodes on the full pass.

import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { encodeToMatrix, matrixToPixels } from '../src/qr/matrix.js';
import { dedupeFrames, halfCrops } from '../src/qr/tiles.js';
import { encodeDataFrame } from '../src/core/framing.js';
import { pseudoRandomBytes } from './util.js';

const SCALE = 4;
const QUIET = 4;
const MARGIN = 16;
const GUTTER = 24;

function composeQuad(frames: Uint8Array[]): {
  width: number;
  height: number;
  data: Uint8ClampedArray;
} {
  const tiles = frames.map((f) => matrixToPixels(encodeToMatrix(f), SCALE, QUIET));
  const tw = Math.max(...tiles.map((t) => t.width));
  const th = Math.max(...tiles.map((t) => t.height));
  const width = MARGIN * 2 + tw * 2 + GUTTER;
  const height = MARGIN * 2 + th * 2 + GUTTER;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  tiles.forEach((tile, i) => {
    const ox = MARGIN + (i % 2) * (tw + GUTTER);
    const oy = MARGIN + Math.floor(i / 2) * (th + GUTTER);
    for (let y = 0; y < tile.height; y++) {
      const src = y * tile.width * 4;
      const dst = ((oy + y) * width + ox) * 4;
      data.set(tile.data.subarray(src, src + tile.width * 4), dst);
    }
  });
  return { width, height, data };
}

function decodeAttempt(data: Uint8ClampedArray, w: number, h: number): Uint8Array | null {
  const code = jsQR(data, w, h);
  return code ? Uint8Array.from(code.binaryData) : null;
}

function extractCrop(
  data: Uint8ClampedArray,
  fullWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * fullWidth + x) * 4;
    out.set(data.subarray(src, src + w * 4), row * w * 4);
  }
  return out;
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16)).join(',');

describe('quad layout end to end', () => {
  const session = new Uint8Array([7, 7, 7, 7]);
  const originals = [101, 102, 103, 104].map((seed) =>
    encodeDataFrame(session, seed, pseudoRandomBytes(256, seed)),
  );

  it('full image misses, exact halves recover all 4 tiles', () => {
    const screen = composeQuad(originals);
    // Full frame holds 4 codes: jsQR cannot lock on (documents the strategy).
    expect(decodeAttempt(screen.data, screen.width, screen.height)).toBeNull();

    const found: Uint8Array[] = [];
    for (const crop of halfCrops(screen.width, screen.height)) {
      const part = extractCrop(screen.data, screen.width, crop.x, crop.y, crop.w, crop.h);
      const code = decodeAttempt(part, crop.w, crop.h);
      if (code) found.push(code);
    }
    const unique = dedupeFrames(found);
    expect(new Set(unique.map(hex))).toEqual(new Set(originals.map(hex)));
  });

  it('single-QR image still decodes on the full pass', () => {
    const tile = matrixToPixels(encodeToMatrix(originals[0]), SCALE, QUIET);
    const code = decodeAttempt(tile.data, tile.width, tile.height);
    expect(code).not.toBeNull();
    expect(code).toEqual(originals[0]);
  });
});
