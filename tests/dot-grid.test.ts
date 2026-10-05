import { describe, expect, it } from 'vitest';
import {
  anchorCenters,
  anchorSquares,
  bitsToBytes,
  bytesToPaddedBits,
  dForFrameBytes,
  gridExtent,
  renderGridPixels,
} from '../src/dot/grid.js';
describe('dot grid sizing', () => {
  it('picks the smallest fitting grid', () => {
    expect(dForFrameBytes(272)).toBe(96); // Reliable frame
    expect(dForFrameBytes(816)).toBe(96); // Fast frame
    expect(dForFrameBytes(1152)).toBe(96); // exact fit
    expect(dForFrameBytes(1153)).toBe(144);
    expect(dForFrameBytes(2016)).toBe(144); // Ultra frame
    expect(dForFrameBytes(2592)).toBe(144); // exact fit
    expect(() => dForFrameBytes(2593)).toThrow();
  });

  it('fits every preset density in a grid', () => {
    // RS-expanded worst case (Ultra) is covered in dot-codec tests; here the
    // raw frame sizes: 272..2016 bytes all fit D96/D144.
    expect(dForFrameBytes(272)).toBe(96);
    expect(dForFrameBytes(2016)).toBe(144);
  });

  it('packs bits MSB-first with zero padding and round-trips', () => {
    const data = new Uint8Array([0xa5, 0x3c]);
    const bits = bytesToPaddedBits(data, 16);
    expect(bits.length).toBe(256);
    expect([...bits.slice(0, 16)]).toEqual([
      1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 0,
    ]);
    expect(bits.slice(16).every((b) => b === 0)).toBe(true);
    expect(bitsToBytes(bits.slice(0, 16))).toEqual(data);
    expect(() => bitsToBytes(new Uint8Array(7))).toThrow();
  });
});

describe('dot anchors', () => {
  it('places a distinctive TL anchor among three identical ones', () => {
    const squares = anchorSquares(96);
    expect(squares).toHaveLength(4);
    expect(squares[0].size).toBe(7);
    expect(squares.slice(1).every((s) => s.size === 5)).toBe(true);
    const centers = anchorCenters(96);
    // TL top-left, others clockwise; symmetric about the data area.
    expect(centers[0].x).toBeLessThan(0);
    expect(centers[0].y).toBeLessThan(0);
    expect(centers[1].x).toBeGreaterThan(96);
    expect(centers[3].y).toBeGreaterThan(96);
    // Canvas extent leaves a quiet zone beyond every anchor.
    const { min, span } = gridExtent(96);
    expect(min).toBeLessThan(-12);
    expect(min + span).toBeGreaterThan(96 + 12);
  });
});

describe('renderGridPixels', () => {
  it('renders black dots on white with solid anchors', () => {
    const D = 16;
    const bits = new Uint8Array(D * D);
    bits[0] = 1;
    const { width, height, data } = renderGridPixels(bits, D, 4);
    expect(width).toBe(height);
    let black = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 128) black++;
    expect(black).toBeGreaterThan(0);
    // Corner anchors exist: top-left region has substantial ink.
    let tlBlack = 0;
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 60; x++) {
        if (data[(y * width + x) * 4] < 128) tlBlack++;
      }
    }
    expect(tlBlack).toBeGreaterThan(200);
  });

  it('rejects mismatched bit counts', () => {
    expect(() => renderGridPixels(new Uint8Array(10), 16, 4)).toThrow();
  });
});
