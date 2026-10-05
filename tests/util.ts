// Shared deterministic test helpers (NOT a test file itself).

import { mulberry32 } from '../src/core/prng.js';

/** Deterministic pseudo-random bytes (seeded, reproducible across runs). */
export function pseudoRandomBytes(length: number, seed = 0x12345678): Uint8Array {
  const rng = mulberry32(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

/** Highly compressible payload (text-like). */
export function compressibleBytes(length: number): Uint8Array {
  const pattern = new TextEncoder().encode(
    'ArkQR fountain codes stream eternal; the quick brown fox. ',
  );
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = pattern[i % pattern.length];
  return out;
}

/** Fisher-Yates shuffle with a seeded PRNG (reproducible). */
export function shuffled<T>(items: T[], seed = 42): T[] {
  const rng = mulberry32(seed);
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
