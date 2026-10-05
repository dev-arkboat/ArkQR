import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/core/crc32.js';

describe('crc32', () => {
  it('matches standard vectors', () => {
    const enc = new TextEncoder();
    expect(crc32(new Uint8Array(0))).toBe(0x00000000);
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(enc.encode('hello'))).toBe(0x3610a686);
    expect(crc32(enc.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('detects single-bit flips', () => {
    const data = new TextEncoder().encode('arkqr-frame-payload-0123456789');
    const good = crc32(data);
    for (const [idx, mask] of [
      [0, 0x01],
      [7, 0x80],
      [data.length - 1, 0x40],
    ] as const) {
      const bad = data.slice();
      bad[idx] ^= mask;
      expect(crc32(bad)).not.toBe(good);
    }
  });

  it('is sensitive to length changes', () => {
    const enc = new TextEncoder();
    expect(crc32(enc.encode('abc'))).not.toBe(crc32(enc.encode('abcd')));
    expect(crc32(enc.encode('abc'))).not.toBe(crc32(enc.encode('ab')));
  });
});
