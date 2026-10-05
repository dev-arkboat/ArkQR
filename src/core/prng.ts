// mulberry32: tiny deterministic PRNG. The SAME implementation runs on the
// sender (to pick LT neighbor sets when encoding) and on the receiver (to
// re-derive those neighbor sets from the seed in each frame header).
// Specified in PROTOCOL.md; do not replace without a version bump.

/** Create a deterministic [0, 1) generator from a 32-bit seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random 32-bit unsigned integer for frame seeds / session ids. */
export function randomUint32(): number {
  const g = globalThis.crypto;
  if (g && typeof g.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    g.getRandomValues(buf);
    return buf[0];
  }
  // Extremely old contexts only; seeds just need variety, not secrecy.
  return Math.floor(Math.random() * 4294967296);
}

/** Fresh random session id (4 bytes). */
export function randomSessionId(): Uint8Array {
  const id = new Uint8Array(4);
  const g = globalThis.crypto;
  if (g && typeof g.getRandomValues === 'function') {
    g.getRandomValues(id);
    return id;
  }
  for (let i = 0; i < 4; i++) id[i] = Math.floor(Math.random() * 256);
  return id;
}
