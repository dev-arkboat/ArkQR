import { describe, expect, it } from 'vitest';
import { dedupeFrames, halfCrops, quadCells } from '../src/qr/tiles.js';

describe('halfCrops', () => {
  it('partitions the image into four adjacent halves', () => {
    const crops = halfCrops(400, 300);
    expect(crops).toHaveLength(4);
    expect(crops).toEqual([
      { x: 0, y: 0, w: 201, h: 151 },
      { x: 200, y: 0, w: 200, h: 151 },
      { x: 0, y: 150, w: 201, h: 150 },
      { x: 200, y: 150, w: 200, h: 150 },
    ]);
  });

  it('covers odd dimensions fully without overflow', () => {
    const w = 641;
    const h = 479;
    const crops = halfCrops(w, h);
    for (const c of crops) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(w);
      expect(c.y + c.h).toBeLessThanOrEqual(h);
    }
    const inside = (x: number, y: number): boolean =>
      crops.some((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
    for (const [x, y] of [
      [0, 0],
      [w - 1, 0],
      [0, h - 1],
      [w - 1, h - 1],
      [320, 239],
      [321, 240],
    ] as const) {
      expect(inside(x, y)).toBe(true);
    }
  });
});

describe('dedupeFrames', () => {
  it('drops byte-identical frames, keeps distinct ones', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    const c = new Uint8Array([1, 2, 4]);
    expect(dedupeFrames([a, b, c])).toHaveLength(2);
    expect(dedupeFrames([])).toHaveLength(0);
    expect(dedupeFrames([a])).toHaveLength(1);
  });
});

describe('quadCells', () => {
  it('fits four non-overlapping cells inside the canvas', () => {
    const cells = quadCells(640, 8, 12);
    expect(cells).toHaveLength(4);
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(8);
      expect(c.y).toBeGreaterThanOrEqual(8);
      expect(c.x + c.size).toBeLessThanOrEqual(632);
      expect(c.y + c.size).toBeLessThanOrEqual(632);
    }
    const overlap = (
      x1: number,
      y1: number,
      s1: number,
      x2: number,
      y2: number,
      s2: number,
    ) => x1 < x2 + s2 && x2 < x1 + s1 && y1 < y2 + s2 && y2 < y1 + s1;
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const a = cells[i];
        const b = cells[j];
        expect(overlap(a.x, a.y, a.size, b.x, b.y, b.size)).toBe(false);
      }
    }
  });
});
