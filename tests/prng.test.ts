import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/prng.js';

describe('mulberry32', () => {
  it('is deterministic for the same seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 1000; i++) expect(a()).toBe(b());
  });

  it('differs across seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('stays in [0, 1)', () => {
    const rng = mulberry32(0xffffffff);
    for (let i = 0; i < 10000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('matches the reference first outputs (spec lock-in)', () => {
    // Reference values from the canonical mulberry32 definition; any change
    // breaks sender/receiver agreement, so this test pins them exactly.
    const rng = mulberry32(0);
    const first = Array.from({ length: 3 }, () => rng());
    expect(first[0]).toBeCloseTo(0.26642920868471265, 15);
    expect(first[1]).toBeCloseTo(0.0003297457005828619, 15);
    expect(first[2]).toBeCloseTo(0.2232720274478197, 15);
  });

  it('agrees with an independent canonical transcription', () => {
    const reference = (seed: number): (() => number) => {
      let a = seed | 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    for (const seed of [0, 1, 123456, 0xffffffff]) {
      const a = mulberry32(seed);
      const b = reference(seed);
      for (let i = 0; i < 1000; i++) expect(a()).toBe(b());
    }
  });
});
