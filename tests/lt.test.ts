import { describe, expect, it } from 'vitest';
import {
  LtDecoder,
  MAX_STORED_EQUATIONS,
  cdfFor,
  encodeBlock,
  neighborsForSeed,
} from '../src/core/lt.js';
import { joinBlocks, splitBlocks } from '../src/core/protocol.js';
import { mulberry32 } from '../src/core/prng.js';
import { pseudoRandomBytes, shuffled } from './util.js';

/** Endless deterministic seed stream (stands in for the sender's RNG). */
function seedStream(base: number): () => number {
  const rng = mulberry32(base);
  return () => Math.floor(rng() * 4294967296);
}

/**
 * Feed encoded frames (in the given seed order) into a fresh decoder,
 * running decode() every `decodeEvery` frames like a throttled receiver.
 * Returns frames consumed until completion.
 */
function runToCompletion(
  blocks: Uint8Array[],
  blockSize: number,
  seeds: number[],
  decodeEvery = 16,
): { framesUsed: number } {
  const decoder = new LtDecoder(blocks.length, blockSize);
  const cdf = cdfFor(blocks.length);
  let used = 0;
  for (const seed of seeds) {
    const status = decoder.addFrame(seed, encodeBlock(blocks, seed, blockSize, cdf));
    used++;
    if (status === 'already-complete') break;
    if (used % decodeEvery === 0) {
      const out = decoder.decode();
      if (out) return { framesUsed: used };
    }
  }
  const out = decoder.decode();
  if (!out)
    throw new Error(`decoder stalled after ${used} frames for K=${blocks.length}`);
  return { framesUsed: used };
}

function expectRoundTrip(payload: Uint8Array, blockSize: number, seeds: number[]): void {
  const blocks = splitBlocks(payload, blockSize);
  const { framesUsed } = runToCompletion(blocks, blockSize, seeds);
  const decoder = new LtDecoder(blocks.length, blockSize);
  const cdf = cdfFor(blocks.length);
  for (let i = 0; i < framesUsed; i++)
    decoder.addFrame(seeds[i], encodeBlock(blocks, seeds[i], blockSize, cdf));
  const recovered = decoder.decode();
  expect(recovered).not.toBeNull();
  expect(joinBlocks(recovered ?? [], payload.length)).toEqual(payload);
}

describe('LT determinism', () => {
  it('derives identical neighbor sets from the same seed on both sides', () => {
    for (const K of [1, 2, 17, 200]) {
      for (const seed of [0, 1, 123456, 0xffffffff]) {
        expect([...neighborsForSeed(seed, K)]).toEqual([...neighborsForSeed(seed, K)]);
      }
    }
  });

  it('encodes deterministically', () => {
    const blocks = splitBlocks(pseudoRandomBytes(2048, 5), 256);
    expect(encodeBlock(blocks, 999, 256)).toEqual(encodeBlock(blocks, 999, 256));
  });

  it('flags duplicate seeds', () => {
    const blocks = splitBlocks(pseudoRandomBytes(1024, 6), 256);
    const decoder = new LtDecoder(blocks.length, 256);
    expect(decoder.addFrame(11, encodeBlock(blocks, 11, 256))).toBe('stored');
    expect(decoder.addFrame(11, encodeBlock(blocks, 11, 256))).toBe('duplicate');
  });
});

describe('LT round trips (file sizes)', () => {
  const nextSeeds = (n: number, base: number): number[] => {
    const next = seedStream(base);
    return Array.from({ length: n }, () => next());
  };

  it('0 B file: zero blocks, trivially complete', () => {
    const decoder = new LtDecoder(0, 512);
    expect(decoder.isComplete).toBe(true);
    expect(decoder.decode()).toEqual([]);
  });

  it('1 B file', () => {
    expectRoundTrip(new Uint8Array([0xab]), 256, nextSeeds(10, 1));
  });

  it('block-size boundary (exact multiple)', () => {
    expectRoundTrip(pseudoRandomBytes(1024, 11), 512, nextSeeds(40, 2));
    // And one byte over the boundary.
    expectRoundTrip(pseudoRandomBytes(1025, 12), 512, nextSeeds(40, 3));
  });

  it('100 KB file', () => {
    const payload = pseudoRandomBytes(100 * 1024, 21);
    const blocks = splitBlocks(payload, 512);
    const seeds = nextSeeds(blocks.length * 4, 22);
    const { framesUsed } = runToCompletion(blocks, 512, seeds);
    const overhead = framesUsed / blocks.length;
    console.info(
      `100KB: K=${blocks.length} frames=${framesUsed} overhead=${overhead.toFixed(3)}`,
    );
    expect(overhead).toBeLessThanOrEqual(2.0);
  });

  it('2 MB file', () => {
    const payload = pseudoRandomBytes(2 * 1024 * 1024, 31);
    const blocks = splitBlocks(payload, 512);
    const seeds = nextSeeds(Math.ceil(blocks.length * 2.5) + 64, 32);
    const { framesUsed } = runToCompletion(blocks, 512, seeds, 64);
    const overhead = framesUsed / blocks.length;
    console.info(
      `2MB: K=${blocks.length} frames=${framesUsed} overhead=${overhead.toFixed(3)}`,
    );
    expect(overhead).toBeLessThanOrEqual(2.0);
  });
});

describe('LT loss simulation (100 KB, blockSize 512)', () => {
  const PAYLOAD = pseudoRandomBytes(100 * 1024, 51);
  const BLOCK_SIZE = 512;
  const BLOCKS = splitBlocks(PAYLOAD, BLOCK_SIZE);
  const K = BLOCKS.length;

  function pool(multiplier: number, base: number): number[] {
    return Array.from({ length: Math.ceil(K * multiplier) + 64 }, seedStream(base));
  }

  function recoverFromSeeds(seeds: number[], label: string, bound: number): void {
    const decoder = new LtDecoder(K, BLOCK_SIZE);
    const cdf = cdfFor(K);
    let used = 0;
    let result: Uint8Array[] | null = null;
    for (const seed of seeds) {
      decoder.addFrame(seed, encodeBlock(BLOCKS, seed, BLOCK_SIZE, cdf));
      used++;
      if (used % 16 === 0) {
        result = decoder.decode();
        if (result) break;
      }
    }
    result ??= decoder.decode();
    expect(result).not.toBeNull();
    expect(joinBlocks(result ?? [], PAYLOAD.length)).toEqual(PAYLOAD);
    const overhead = used / K;
    console.info(`${label}: K=${K} used=${used} overhead=${overhead.toFixed(3)}`);
    expect(overhead).toBeLessThanOrEqual(bound);
  }

  it('survives 30% random loss', () => {
    const rng = mulberry32(1001);
    const kept = pool(4, 61).filter(() => rng() < 0.7);
    recoverFromSeeds(kept, 'drop30%', 3.0);
  });

  it('survives 60% random loss', () => {
    const rng = mulberry32(2002);
    const kept = pool(6, 62).filter(() => rng() < 0.4);
    recoverFromSeeds(kept, 'drop60%', 3.5);
  });

  it('survives shuffling + duplication', () => {
    const base = pool(3, 63);
    const doubled = [...base, ...base.slice(0, Math.floor(base.length / 2))];
    recoverFromSeeds(shuffled(doubled, 77), 'shuffled+duplicated', 3.0);
  });

  it('decodes incrementally across throttled decode() calls', () => {
    const seeds = pool(3, 64);
    const decoder = new LtDecoder(K, BLOCK_SIZE);
    const cdf = cdfFor(K);
    // First trickle: far too few frames to complete.
    for (let i = 0; i < 10; i++)
      decoder.addFrame(seeds[i], encodeBlock(BLOCKS, seeds[i], BLOCK_SIZE, cdf));
    expect(decoder.decode()).toBeNull();
    // Rest of the stream, decoding every 16 frames.
    let result: Uint8Array[] | null = null;
    for (let i = 10; i < seeds.length; i++) {
      decoder.addFrame(seeds[i], encodeBlock(BLOCKS, seeds[i], BLOCK_SIZE, cdf));
      if (i % 16 === 0) {
        result = decoder.decode();
        if (result) break;
      }
    }
    result ??= decoder.decode();
    expect(result).not.toBeNull();
    expect(joinBlocks(result ?? [], PAYLOAD.length)).toEqual(PAYLOAD);
  });
});

describe('Gauss-Jordan fallback', () => {
  it('solves a small stalled system with no degree-1 equations', () => {
    const K = 8;
    const blockSize = 16;
    const payload = pseudoRandomBytes(K * blockSize, 81);
    const blocks = splitBlocks(payload, blockSize);
    // Collect seeds whose neighbor sets all have degree >= 2 (peeling cannot start).
    const chosen: number[] = [];
    for (let seed = 1; seed < 5000 && chosen.length < 24; seed++) {
      if (neighborsForSeed(seed, K).length >= 2) chosen.push(seed);
    }
    expect(chosen.length).toBe(24);
    const decoder = new LtDecoder(K, blockSize);
    for (const seed of chosen)
      decoder.addFrame(seed, encodeBlock(blocks, seed, blockSize));
    const out = decoder.decode();
    expect(out).not.toBeNull();
    expect(joinBlocks(out ?? [], payload.length)).toEqual(payload);
  });
});

describe('decoder memory window', () => {
  it('bounds stored equations while still decoding huge streams', () => {
    const K = 100;
    const blockSize = 64;
    const payload = pseudoRandomBytes(K * blockSize, 314);
    const blocks = splitBlocks(payload, blockSize);
    const decoder = new LtDecoder(K, blockSize);
    // 20k unique frames: far past the 4*K+1024 window.
    for (let seed = 1; seed <= 20000; seed++) {
      decoder.addFrame(seed, encodeBlock(blocks, seed, blockSize));
    }
    expect(decoder.equationCount).toBeLessThanOrEqual(4 * K + 1024);
    expect(decoder.equationCount).toBeLessThanOrEqual(MAX_STORED_EQUATIONS);
    const out = decoder.decode();
    expect(out).not.toBeNull();
    expect(joinBlocks(out ?? [], payload.length)).toEqual(payload);
  });
});

describe('splitBlocks views', () => {
  it('shares memory for full blocks, copies only the padded tail', () => {
    const payload = pseudoRandomBytes(1025, 99);
    const blocks = splitBlocks(payload, 512);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].buffer).toBe(payload.buffer);
    expect(blocks[1].buffer).toBe(payload.buffer);
    expect(blocks[2].buffer).not.toBe(payload.buffer); // padded copy
    expect(joinBlocks(blocks, payload.length)).toEqual(payload);
  });
});
