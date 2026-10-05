// LT (Luby Transform) fountain code: endless decodable stream from K source
// blocks. The sender XORs source blocks selected by a seeded PRNG; the
// receiver re-derives the same neighbor sets from each frame's seed and
// decodes with peeling (belief propagation), with Gauss-Jordan elimination
// as a fallback for small stalled systems.

import { MAX_GE_BLOCKS } from './constants.js';
import { mulberry32 } from './prng.js';
import { robustSolitonCdf, sampleDegree } from './soliton.js';

/** Build (and cache per K) the robust-soliton CDF both sides share. */
const cdfCache = new Map<number, Float64Array>();

export function cdfFor(blockCount: number): Float64Array {
  let cdf = cdfCache.get(blockCount);
  if (!cdf) {
    cdf = robustSolitonCdf(blockCount);
    cdfCache.set(blockCount, cdf);
  }
  return cdf;
}

/**
 * Deterministic neighbor set for `seed`: first PRNG output picks the degree
 * from the robust-soliton CDF, subsequent outputs pick distinct indices.
 * MUST stay identical on sender and receiver for the same (seed, K).
 */
export function neighborsForSeed(
  seed: number,
  blockCount: number,
  cdf?: Float64Array,
): Uint32Array {
  if (!Number.isInteger(blockCount) || blockCount < 1) {
    throw new Error(`invalid blockCount ${blockCount}`);
  }
  const table = cdf ?? cdfFor(blockCount);
  const rng = mulberry32(seed);
  const degree = Math.min(sampleDegree(blockCount, rng(), table), blockCount);
  const picked = new Set<number>();
  while (picked.size < degree) {
    picked.add(Math.floor(rng() * blockCount));
  }
  return Uint32Array.from(picked);
}

/** XOR source blocks {neighbors} into one blockSize-byte encoded payload. */
export function encodeBlock(
  sourceBlocks: readonly Uint8Array[],
  seed: number,
  blockSize: number,
  cdf?: Float64Array,
): Uint8Array {
  const blockCount = sourceBlocks.length;
  const neighbors = neighborsForSeed(seed, blockCount, cdf);
  const out = new Uint8Array(blockSize);
  for (let n = 0; n < neighbors.length; n++) {
    const block = sourceBlocks[neighbors[n]];
    for (let i = 0; i < blockSize; i++) out[i] ^= block[i];
  }
  return out;
}

export type AddStatus = 'stored' | 'duplicate' | 'already-complete';

/**
 * Cap on stored equations: the stream is endless and every draw is i.i.d.,
 * so a sliding window of recent equations plus all resolved blocks keeps
 * decoding convergent while bounding memory (and per-decode() CPU). Small
 * transfers never hit the cap; only huge ones prune.
 */
export const MAX_STORED_EQUATIONS = 65536;

interface Equation {
  seed: number;
  neighbors: number[];
  payload: Uint8Array;
}

/**
 * Fountain decoder. Feed frames in any order, duplicates included; call
 * decode() (throttled by the caller) to run peeling + the GE fallback.
 */
export class LtDecoder {
  private readonly equations: Equation[] = [];
  private readonly seenSeeds = new Set<number>();
  private readonly resolved: (Uint8Array | null)[];
  private resolvedCount = 0;
  private readonly equationCap: number;

  constructor(
    readonly blockCount: number,
    readonly blockSize: number,
  ) {
    if (!Number.isInteger(blockCount) || blockCount < 0) {
      throw new Error(`invalid blockCount ${blockCount}`);
    }
    if (!Number.isInteger(blockSize) || blockSize <= 0) {
      throw new Error(`invalid blockSize ${blockSize}`);
    }
    this.resolved = new Array<Uint8Array | null>(blockCount).fill(null);
    this.equationCap = Math.min(4 * blockCount + 1024, MAX_STORED_EQUATIONS);
  }

  get isComplete(): boolean {
    return this.resolvedCount >= this.blockCount;
  }

  get progressBlocks(): number {
    return this.resolvedCount;
  }

  get equationCount(): number {
    return this.equations.length;
  }

  addFrame(seed: number, payload: Uint8Array): AddStatus {
    if (this.isComplete) return 'already-complete';
    if (payload.length !== this.blockSize) {
      throw new Error(`payload length ${payload.length} != blockSize ${this.blockSize}`);
    }
    if (this.seenSeeds.has(seed)) return 'duplicate';
    this.seenSeeds.add(seed);
    const neighbors = Array.from(neighborsForSeed(seed >>> 0, this.blockCount));
    this.equations.push({ seed: seed >>> 0, neighbors, payload: payload.slice() });
    this.prune();
    return 'stored';
  }

  /** Drop oldest equations past the cap (draws are i.i.d.; recents suffice). */
  private prune(): void {
    if (this.equations.length <= this.equationCap) return;
    const drop = this.equations.length - this.equationCap;
    const removed = this.equations.splice(0, drop);
    for (const eq of removed) this.seenSeeds.delete(eq.seed);
  }

  /**
   * Run peeling; on stall, Gauss-Jordan fallback for small systems.
   * Returns the K source blocks (still zero-padded) or null if more
   * frames are needed.
   */
  decode(): Uint8Array[] | null {
    if (this.blockCount === 0) return [];
    this.peel();
    if (!this.isComplete && this.blockCount <= MAX_GE_BLOCKS) {
      this.gaussJordan();
    }
    if (!this.isComplete) return null;
    return this.resolved.map((b) => (b as Uint8Array).slice());
  }

  private peel(): void {
    // Work on copies: decode() may run many times as frames trickle in, and
    // the stored equations must stay pristine between runs.
    const work = this.equations.map((eq) => ({
      neighbors: eq.neighbors,
      payload: eq.payload.slice(),
    }));
    const remaining: Set<number>[] = [];
    const adj = new Map<number, Set<number>>();
    work.forEach((eq, qi) => {
      const s = new Set<number>();
      for (const b of eq.neighbors) {
        const known = this.resolved[b];
        if (known === null) {
          s.add(b);
          let list = adj.get(b);
          if (!list) {
            list = new Set<number>();
            adj.set(b, list);
          }
          list.add(qi);
        } else {
          // Substitute blocks resolved by earlier decode() runs.
          for (let i = 0; i < this.blockSize; i++) eq.payload[i] ^= known[i];
        }
      }
      remaining.push(s);
    });

    const queue: number[] = [];
    remaining.forEach((s, qi) => {
      if (s.size === 1) queue.push(qi);
    });

    while (queue.length > 0) {
      const qi = queue.pop();
      if (qi === undefined) break;
      const s = remaining[qi];
      if (s.size !== 1) continue;
      const block = [...s][0];
      const eq = work[qi];
      if (this.resolved[block] !== null) {
        s.clear();
        continue;
      }
      const value = eq.payload.slice();
      this.resolved[block] = value;
      this.resolvedCount++;
      s.clear();
      const peers = adj.get(block);
      adj.delete(block);
      if (!peers) continue;
      for (const pi of peers) {
        if (pi === qi) continue;
        const ps = remaining[pi];
        if (!ps.has(block)) continue;
        ps.delete(block);
        const peer = work[pi];
        for (let i = 0; i < this.blockSize; i++) peer.payload[i] ^= value[i];
        if (ps.size === 1) queue.push(pi);
      }
    }
  }

  /**
   * Gauss-Jordan elimination over GF(2) on the unresolved subsystem.
   * Only for small K (constructor input already gates the call).
   */
  private gaussJordan(): void {
    const unknown: number[] = [];
    const colOf = new Map<number, number>();
    for (let b = 0; b < this.blockCount; b++) {
      if (this.resolved[b] === null) {
        colOf.set(b, unknown.length);
        unknown.push(b);
      }
    }
    const n = unknown.length;
    if (n === 0) return;
    const words = Math.ceil(n / 32);

    const masks: Uint32Array[] = [];
    const rhs: Uint8Array[] = [];
    for (const eq of this.equations) {
      const mask = new Uint32Array(words);
      const row = eq.payload.slice();
      let any = false;
      for (const b of eq.neighbors) {
        const c = colOf.get(b);
        if (c !== undefined) {
          mask[c >>> 5] |= 1 << (c & 31);
          any = true;
        } else {
          // Substitute blocks resolved by peeling or earlier runs.
          const known = this.resolved[b];
          if (known) for (let i = 0; i < this.blockSize; i++) row[i] ^= known[i];
        }
      }
      if (any) {
        masks.push(mask);
        rhs.push(row);
      }
    }
    if (masks.length < n) return; // underdetermined: keep collecting

    let pivot = 0;
    for (let col = 0; col < n && pivot < masks.length; col++) {
      let sel = -1;
      for (let r = pivot; r < masks.length; r++) {
        if ((masks[r][col >>> 5] & (1 << (col & 31))) !== 0) {
          sel = r;
          break;
        }
      }
      if (sel < 0) continue;
      if (sel !== pivot) {
        const tm = masks[sel];
        masks[sel] = masks[pivot];
        masks[pivot] = tm;
        const tr = rhs[sel];
        rhs[sel] = rhs[pivot];
        rhs[pivot] = tr;
      }
      for (let r = 0; r < masks.length; r++) {
        if (r !== pivot && (masks[r][col >>> 5] & (1 << (col & 31))) !== 0) {
          const pm = masks[pivot];
          const rm = masks[r];
          for (let w = 0; w < words; w++) rm[w] ^= pm[w];
          const pr = rhs[pivot];
          const rr = rhs[r];
          for (let i = 0; i < this.blockSize; i++) rr[i] ^= pr[i];
        }
      }
      pivot++;
    }

    for (let r = 0; r < masks.length; r++) {
      let single = -1;
      let count = 0;
      for (let c = 0; c < n; c++) {
        if ((masks[r][c >>> 5] & (1 << (c & 31))) !== 0) {
          single = c;
          count++;
          if (count > 1) break;
        }
      }
      if (count === 1) {
        const block = unknown[single];
        if (this.resolved[block] === null) {
          this.resolved[block] = rhs[r].slice();
          this.resolvedCount++;
        }
      }
    }
  }
}
