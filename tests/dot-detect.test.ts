import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  detectDotFrame,
  findAnchorQuad,
  labelDarkBlobs,
  otsuThreshold,
  solveHomography,
  toGray,
  type GrayImage,
} from '../src/dot/detect.js';
import { dotDecodeGrid, dotEncodeFrame } from '../src/dot/codec.js';
import { bytesToPaddedBits, renderGridPixels } from '../src/dot/grid.js';
import { encodeDataFrame } from '../src/core/framing.js';
import { pseudoRandomBytes } from './util.js';

function grayOf(w: number, h: number, fill: number): GrayImage {
  return { data: new Uint8Array(w * h).fill(fill), w, h };
}

describe('otsuThreshold', () => {
  it('separates bimodal images near the valley', () => {
    const gray = grayOf(10, 10, 250);
    for (let i = 0; i < 30; i++) gray.data[i] = 10;
    const t = otsuThreshold(gray);
    expect(t).toBeGreaterThan(10);
    expect(t).toBeLessThan(250);
  });

  it('handles empty regions', () => {
    expect(otsuThreshold(grayOf(4, 4, 0), { x: 0, y: 0, w: 0, h: 0 })).toBe(128);
  });
});

describe('labelDarkBlobs', () => {
  it('finds two squares and reports solidity + centroids', () => {
    const w = 30;
    const h = 20;
    const dark = new Uint8Array(w * h);
    const rect = (x0: number, y0: number, s: number): void => {
      for (let y = y0; y < y0 + s; y++) {
        for (let x = x0; x < x0 + s; x++) dark[y * w + x] = 1;
      }
    };
    rect(2, 2, 6);
    rect(20, 10, 4);
    const blobs = labelDarkBlobs(dark, w, h);
    expect(blobs).toHaveLength(2);
    const big = blobs.reduce((a, b) => (a.area > b.area ? a : b));
    expect(big.area).toBe(36);
    expect(big.cx).toBeCloseTo(4.5, 6);
    expect(big.cy).toBeCloseTo(4.5, 6);
    expect(big.fill).toBeCloseTo(1, 6);
  });
});

describe('solveHomography', () => {
  it('recovers a perspective map from 4 correspondences', () => {
    const src = [
      { x: 10, y: 10 },
      { x: 100, y: 14 },
      { x: 96, y: 104 },
      { x: 12, y: 98 },
    ];
    // Known map: mild perspective + scale + offset.
    const H0 = [2, 0.1, 5, -0.05, 2.2, 7, 0.0004, 0.0002, 1] as const;
    const apply = (x: number, y: number): { x: number; y: number } => {
      const w = H0[6] * x + H0[7] * y + H0[8];
      return {
        x: (H0[0] * x + H0[1] * y + H0[2]) / w,
        y: (H0[3] * x + H0[4] * y + H0[5]) / w,
      };
    };
    const dst = src.map((p) => apply(p.x, p.y));
    const H = solveHomography(src, dst);
    expect(H).not.toBeNull();
    for (const p of src) {
      const got = applyHomography(H ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], p.x, p.y);
      const want = apply(p.x, p.y);
      expect(Math.hypot(got.x - want.x, got.y - want.y)).toBeLessThan(1e-6);
    }
  });

  it('rejects degenerate input', () => {
    expect(solveHomography([{ x: 0, y: 0 }], [{ x: 0, y: 0 }])).toBeNull();
    // Collinear points: singular system.
    const line = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(solveHomography(line, line)).toBeNull();
  });
});

describe('findAnchorQuad', () => {
  it('picks the anchor set out of clutter', () => {
    // Three 5x5 + one 7x7 anchors in a square, plus noise blobs.
    const quad: { cx: number; cy: number; area: number }[] = [
      { cx: 0, cy: 0, area: 49 },
      { cx: 100, cy: 0, area: 25 },
      { cx: 100, cy: 100, area: 25 },
      { cx: 0, cy: 100, area: 25 },
    ];
    const blobs = [
      ...quad.map((q, i) => ({
        area: q.area,
        cx: q.cx,
        cy: q.cy,
        x0: q.cx - 3,
        y0: q.cy - 3,
        x1: q.cx + 3,
        y1: q.cy + 3,
        fill: i === 0 ? 0.95 : 0.9,
      })),
      { area: 200, cx: 50, cy: 50, x0: 40, y0: 40, x1: 60, y1: 60, fill: 0.3 },
      { area: 3, cx: 70, cy: 20, x0: 69, y0: 19, x1: 71, y1: 21, fill: 0.8 },
    ];
    const found = findAnchorQuad(blobs);
    expect(found).not.toBeNull();
    expect(found).toHaveLength(4);
    // Biggest (TL) comes first.
    expect(found?.[0].area).toBe(49);
  });
});

describe('detectDotFrame end to end (synthetic)', () => {
  function roundTrip(frame: Uint8Array, modulePx: number): Uint8Array | null {
    const { D, bytes } = dotEncodeFrame(frame);
    const bits = bytesToPaddedBits(bytes, D);
    const { width, height, data } = renderGridPixels(bits, D, modulePx);
    const det = detectDotFrame(data, width, height);
    if (!det) return null;
    expect(det.size).toBe(D);
    return dotDecodeGrid(det.bytes, frame.length);
  }

  it('recovers frame bytes from a clean render', () => {
    const session = new Uint8Array([3, 3, 3, 3]);
    const frame = encodeDataFrame(session, 4242, pseudoRandomBytes(256, 77));
    expect(roundTrip(frame, 5)).toEqual(frame);
  });

  it('selects the large grid for Ultra-size frames', () => {
    const session = new Uint8Array([3, 3, 3, 3]);
    const frame = encodeDataFrame(session, 4243, pseudoRandomBytes(2000, 78));
    const { D } = dotEncodeFrame(frame);
    expect(D).toBe(144);
    expect(roundTrip(frame, 4)).toEqual(frame);
  });

  it('tolerates a uniform gray lift (adaptive threshold)', () => {
    const session = new Uint8Array([3, 3, 3, 3]);
    const frame = encodeDataFrame(session, 4244, pseudoRandomBytes(256, 79));
    const { D, bytes } = dotEncodeFrame(frame);
    const bits = bytesToPaddedBits(bytes, D);
    const rendered = renderGridPixels(bits, D, 5);
    const lifted = new Uint8ClampedArray(rendered.data.length);
    for (let i = 0; i < rendered.data.length; i += 4) {
      const lift = rendered.data[i] === 0 ? 60 : 0;
      lifted[i] = rendered.data[i] + lift;
      lifted[i + 1] = rendered.data[i + 1] + lift;
      lifted[i + 2] = rendered.data[i + 2] + lift;
      lifted[i + 3] = 255;
    }
    const det = detectDotFrame(lifted, rendered.width, rendered.height);
    expect(det).not.toBeNull();
    expect(det ? dotDecodeGrid(det.bytes, frame.length) : null).toEqual(frame);
  });

  it('returns null when no anchors exist', () => {
    const gray = toGray(new Uint8ClampedArray(64 * 64 * 4).fill(200), 64, 64);
    const rgba = new Uint8ClampedArray(64 * 64 * 4).fill(200);
    expect(detectDotFrame(rgba, 64, 64)).toBeNull();
    expect(gray.w).toBe(64);
  });
});
