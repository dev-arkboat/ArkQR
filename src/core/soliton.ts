// Robust soliton distribution (Luby + Mitzenmacher's robust extension).
// Maps a uniform random value to an LT-code degree so that K source blocks
// decode from any ~K + O(sqrt(K) log^2 K) collected frames with high
// probability. Deterministic given K: both sides build the same CDF.

import { SOLITON_C, SOLITON_DELTA } from './constants.js';

/**
 * Cumulative distribution over degrees 1..blockCount.
 * Result `cdf[d - 1]` = P(degree <= d). Always ends at exactly 1.
 */
export function robustSolitonCdf(
  blockCount: number,
  c: number = SOLITON_C,
  delta: number = SOLITON_DELTA,
): Float64Array {
  if (!Number.isInteger(blockCount) || blockCount < 1) {
    throw new Error(`invalid blockCount ${blockCount}`);
  }
  if (blockCount === 1) return new Float64Array([1]);

  const K = blockCount;
  const R = c * Math.log(K / delta) * Math.sqrt(K);

  // 1-indexed working arrays; index 0 unused.
  const rho = new Float64Array(K + 1);
  const tau = new Float64Array(K + 1);

  rho[1] = 1 / K;
  for (let d = 2; d <= K; d++) rho[d] = 1 / (d * (d - 1));

  const pivot = Math.floor(K / R);
  const upper = Math.min(pivot - 1, K);
  for (let d = 1; d <= upper; d++) tau[d] = R / (d * K);
  if (pivot >= 1 && pivot <= K) tau[pivot] = (R * Math.log(R / delta)) / K;

  let total = 0;
  for (let d = 1; d <= K; d++) total += rho[d] + tau[d];

  const cdf = new Float64Array(K);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += (rho[d] + tau[d]) / total;
    cdf[d - 1] = d === K ? 1 : acc;
  }
  return cdf;
}

/** Smallest degree d with cdf[d-1] >= u (u in [0, 1)). */
export function sampleDegree(blockCount: number, u: number, cdf: Float64Array): number {
  if (cdf.length !== blockCount) throw new Error('CDF length mismatch');
  const x = u < 0 ? 0 : u >= 1 ? 1 - Number.EPSILON : u;
  for (let d = 1; d <= blockCount; d++) {
    if (x < cdf[d - 1]) return d;
  }
  return blockCount;
}
