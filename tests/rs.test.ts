import { describe, expect, it } from 'vitest';
import { rsDecode, rsEncode } from '../src/dot/rs.js';
import { pseudoRandomBytes } from './util.js';

function corrupt(code: Uint8Array, positions: number[], maskSeed = 0x5a): Uint8Array {
  const out = code.slice();
  for (const [k, p] of positions.entries()) {
    // Deterministic non-zero damage that never accidentally fixes itself.
    const delta = ((maskSeed + k * 37) % 255) + 1;
    out[p] ^= delta;
    if (out[p] === code[p]) out[p] ^= 0x80;
  }
  return out;
}

function errorPositions(n: number, count: number, start = 0): number[] {
  const pos: number[] = [];
  for (let i = 0; i < count; i++) pos.push((start + i * 13) % n);
  return [...new Set(pos)];
}

describe('reed-solomon', () => {
  it('round-trips full and shortened codes cleanly', () => {
    for (const [len, nsym] of [
      [223, 32],
      [100, 32],
      [9, 32],
      [1, 4],
      [200, 10],
    ] as const) {
      const data = pseudoRandomBytes(len, len * 7 + 1);
      const code = rsEncode(data, nsym);
      expect(code.length).toBe(len + nsym);
      expect(rsDecode(code, nsym)).toEqual(data);
    }
  });

  it('rejects invalid parameters', () => {
    expect(() => rsEncode(new Uint8Array(250), 32)).toThrow(); // 282 > 255
    expect(() => rsEncode(new Uint8Array(10), 0)).toThrow();
    expect(rsDecode(new Uint8Array(10), 32)).toBeNull(); // k <= 0
  });

  it('repairs exactly t = nsym/2 byte errors', () => {
    const data = pseudoRandomBytes(223, 4242);
    const code = rsEncode(data, 32);
    for (const count of [1, 7, 15, 16]) {
      const bad = corrupt(code, errorPositions(code.length, count));
      expect(rsDecode(bad, 32)).toEqual(data);
    }
  });

  it('repairs errors clustered in parity and data', () => {
    const data = pseudoRandomBytes(100, 99);
    const code = rsEncode(data, 32);
    // 16 errors all inside the 32 parity bytes.
    const parityHits = Array.from({ length: 16 }, (_, i) => 100 + i * 2);
    expect(rsDecode(corrupt(code, parityHits), 32)).toEqual(data);
  });

  it('fails closed far beyond capacity (never corrupt data)', () => {
    const data = pseudoRandomBytes(223, 31337);
    const code = rsEncode(data, 32);
    // 60 scattered errors: uncorrectable; must return null, not garbage.
    const bad = corrupt(code, errorPositions(code.length, 60), 0x33);
    expect(rsDecode(bad, 32)).toBeNull();
  });

  it('handles all-zero and all-0xff payloads', () => {
    for (const fill of [0x00, 0xff]) {
      const data = new Uint8Array(50).fill(fill);
      const code = rsEncode(data, 20);
      expect(rsDecode(code, 20)).toEqual(data);
      expect(rsDecode(corrupt(code, [0, 7, 49, 60, 69]), 20)).toEqual(data);
    }
  });
});
