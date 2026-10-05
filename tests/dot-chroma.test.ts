import { describe, expect, it } from 'vitest';
import {
  CHROMA_PALETTE,
  chromaDecodeGrid,
  chromaEncodeFrame,
  classifyChroma,
  packQuads,
  refsUsable,
  unpackQuads,
  type RGB,
} from '../src/dot/chroma.js';
import { detectChromaFrame } from '../src/dot/detect.js';
import { renderColorGridPixels } from '../src/dot/grid.js';
import { encodeDataFrame } from '../src/core/framing.js';
import { pseudoRandomBytes } from './util.js';

const REFS: [RGB, RGB, RGB, RGB] = [
  { r: 255, g: 255, b: 255 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
];

describe('chroma classification', () => {
  it('identifies pure palette colors with huge margins', () => {
    for (let v = 0; v < 4; v++) {
      const c = classifyChroma(CHROMA_PALETTE[v], REFS);
      expect(c.value).toBe(v);
      expect(c.margin).toBeGreaterThan(200);
    }
  });

  it('survives realistic shifts (warm light + sensor noise)', () => {
    const shifted: [RGB, RGB, RGB, RGB] = [
      { r: 250, g: 240, b: 225 },
      { r: 225, g: 30, b: 20 },
      { r: 40, g: 220, b: 60 },
      { r: 30, g: 40, b: 215 },
    ];
    const samples: RGB[] = [
      { r: 245, g: 235, b: 220 },
      { r: 215, g: 45, b: 30 },
      { r: 55, g: 210, b: 70 },
      { r: 40, g: 55, b: 205 },
    ];
    samples.forEach((s, i) => {
      expect(classifyChroma(s, shifted).value).toBe(i);
    });
  });

  it('gates degenerate references', () => {
    expect(refsUsable(REFS)).toBe(true);
    const flat: [RGB, RGB, RGB, RGB] = [
      { r: 10, g: 10, b: 10 },
      { r: 12, g: 9, b: 11 },
      { r: 200, g: 200, b: 200 },
      { r: 205, g: 198, b: 202 },
    ];
    expect(refsUsable(flat)).toBe(false);
  });
});

describe('quad packing', () => {
  it('round-trips 2-bit values', () => {
    const values = new Uint8Array([0, 1, 2, 3, 3, 2, 1, 0]);
    const packed = packQuads(values);
    expect(packed).toEqual(new Uint8Array([0x1b, 0xe4]));
    expect(unpackQuads(packed, 8)).toEqual(values);
    expect(() => packQuads(new Uint8Array([0, 1, 2]))).toThrow();
    expect(() => packQuads(new Uint8Array([0, 1, 2, 9]))).toThrow();
  });
});

describe('chroma RS framing', () => {
  it('packs every preset density (4x denser than binary dots)', () => {
    for (const [blockSize, wantD] of [
      [256, 96],
      [512, 96],
      [800, 96],
      [1400, 96],
      [2000, 144],
    ] as const) {
      const frame = pseudoRandomBytes(16 + blockSize, blockSize);
      const { D, values } = chromaEncodeFrame(frame);
      expect(D).toBe(wantD);
      expect(values.length).toBe(wantD * wantD);
      // Reference header intact.
      expect([...values.slice(0, 8)]).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
      expect(chromaDecodeGrid(packQuads(values), 16 + blockSize)).toEqual(frame);
    }
  });

  it('recovers frames with scattered cell damage', () => {
    const frame = pseudoRandomBytes(816, 21);
    const { D, values } = chromaEncodeFrame(frame);
    // Corrupt 60 cells (~0.65%): each bad cell damages its byte; RS budget
    // is 16 bad bytes per chunk — well within it here.
    const damaged = values.slice();
    let state = 123456789;
    const rand = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      return state;
    };
    const hit = new Set<number>();
    while (hit.size < 60) {
      const idx = 8 + (rand() % (D * D - 8));
      hit.add(idx);
      damaged[idx] = (damaged[idx] + 1 + (rand() % 3)) % 4;
    }
    expect(chromaDecodeGrid(packQuads(damaged), 816)).toEqual(frame);
  });

  it('fails closed on heavy damage and bad lengths', () => {
    const frame = pseudoRandomBytes(528, 22);
    const { values } = chromaEncodeFrame(frame);
    const destroyed = values.slice().fill(2);
    expect(chromaDecodeGrid(packQuads(destroyed), 528)).toBeNull();
    expect(chromaDecodeGrid(packQuads(values).slice(0, 10), 528)).toBeNull();
    expect(chromaDecodeGrid(packQuads(values), 0)).toBeNull();
    expect(() => chromaEncodeFrame(new Uint8Array(0))).toThrow();
  });
});

describe('chroma end to end (synthetic)', () => {
  function roundTrip(frame: Uint8Array, modulePx: number): Uint8Array | null {
    const { D, values } = chromaEncodeFrame(frame);
    const { width, height, data } = renderColorGridPixels(
      values,
      D,
      modulePx,
      CHROMA_PALETTE,
    );
    const det = detectChromaFrame(data, width, height);
    if (!det) return null;
    expect(det.size).toBe(D);
    return chromaDecodeGrid(det.packed, frame.length);
  }

  it('recovers frame bytes from a clean color render', () => {
    const session = new Uint8Array([9, 9, 9, 9]);
    const frame = encodeDataFrame(session, 5150, pseudoRandomBytes(512, 71));
    expect(roundTrip(frame, 5)).toEqual(frame);
  });

  it('survives a warm-light shift (calibration rides along)', () => {
    const session = new Uint8Array([9, 9, 9, 9]);
    const frame = encodeDataFrame(session, 5151, pseudoRandomBytes(512, 72));
    const { D, values } = chromaEncodeFrame(frame);
    const rendered = renderColorGridPixels(values, D, 5, CHROMA_PALETTE);
    // Warm room: red/green gain, blue loss, on every pixel equally.
    const shifted = new Uint8ClampedArray(rendered.data.length);
    for (let i = 0; i < rendered.data.length; i += 4) {
      shifted[i] = Math.min(255, rendered.data[i] + 18);
      shifted[i + 1] = Math.min(255, rendered.data[i + 1] + 8);
      shifted[i + 2] = Math.max(0, rendered.data[i + 2] - 22);
      shifted[i + 3] = 255;
    }
    const det = detectChromaFrame(shifted, rendered.width, rendered.height);
    expect(det).not.toBeNull();
    expect(det ? chromaDecodeGrid(det.packed, frame.length) : null).toEqual(frame);
  });

  it('returns null when anchors are missing', () => {
    const rgba = new Uint8ClampedArray(64 * 64 * 4).fill(200);
    expect(detectChromaFrame(rgba, 64, 64)).toBeNull();
  });
});
