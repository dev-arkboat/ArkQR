import { describe, expect, it } from 'vitest';
import { dotDecodeGrid, dotEncodeFrame } from '../src/dot/codec.js';
import { pseudoRandomBytes } from './util.js';

function flipBits(bytes: Uint8Array, count: number, seed: number): Uint8Array {
  const out = bytes.slice();
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    return state;
  };
  const touched = new Set<number>();
  while (touched.size < count) {
    const byte = next() % out.length;
    const bit = next() % 8;
    touched.add(byte * 8 + bit);
    out[byte] ^= 1 << bit;
  }
  return out;
}

describe('dot RS framing', () => {
  it('fits every preset density in a grid', () => {
    // frame = 16 header bytes + blockSize.
    for (const [blockSize, wantD] of [
      [256, 96],
      [512, 96],
      [800, 96],
      [1400, 144],
      [2000, 144],
    ] as const) {
      const { D, bytes } = dotEncodeFrame(pseudoRandomBytes(16 + blockSize, blockSize));
      expect(D).toBe(wantD);
      expect(bytes.length).toBe((wantD * wantD) / 8);
    }
  });

  it('round-trips exactly and rejects wrong lengths', () => {
    const frame = pseudoRandomBytes(528, 11);
    const { bytes } = dotEncodeFrame(frame);
    expect(dotDecodeGrid(bytes, 528)).toEqual(frame);
    expect(dotDecodeGrid(bytes.slice(0, 100), 528)).toBeNull();
    expect(dotDecodeGrid(bytes, 0)).toBeNull();
  });

  it('recovers frames with scattered module damage', () => {
    const frame = pseudoRandomBytes(816, 12);
    const { bytes } = dotEncodeFrame(frame);
    // 40 flipped bits worst case land ~40 bytes damaged across chunks;
    // RS(255,223) repairs 16 per chunk — comfortably within budget here.
    const damaged = flipBits(bytes, 40, 7);
    expect(dotDecodeGrid(damaged, 816)).toEqual(frame);
  });

  it('fails closed on heavy damage', () => {
    const frame = pseudoRandomBytes(528, 13);
    const { bytes } = dotEncodeFrame(frame);
    // Destroy the first chunk entirely (255 bad bytes >> 16 budget).
    const destroyed = bytes.slice();
    destroyed.fill(0xaa, 0, 255);
    expect(dotDecodeGrid(destroyed, 528)).toBeNull();
  });
});
