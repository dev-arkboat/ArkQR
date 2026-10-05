// Reed-Solomon over GF(256) (primitive poly 0x11D, first root α^0 — the QR
// convention). Used ONLY for the dot-matrix layer, which has no per-symbol
// error correction of its own: up to 16 bad bytes per 255-byte chunk are
// repaired, turning would-be drops into accepted frames. QR symbols already
// carry their own RS ECC, so double-encoding them would waste ~14% for
// nothing. Shortened codes (n < 255) supported. Pure and fully tested.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

function buildTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

buildTables();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (a === 0) return 0;
  if (b === 0) throw new Error('division by zero in GF(256)');
  return EXP[(LOG[a] - LOG[b] + 255) % 255];
}

/** Evaluate poly (coeffs high-degree first) at x. */
function polyEval(coeffs: number[], x: number): number {
  let y = 0;
  for (const c of coeffs) y = gfMul(y, x) ^ c;
  return y;
}

/** Generator poly of degree nsym with first root α^0. */
function generatorPoly(nsym: number): number[] {
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    const root = [1, EXP[i]];
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= gfMul(g[j], root[0]);
      next[j + 1] ^= gfMul(g[j], root[1]);
    }
    g = next;
  }
  return g;
}

/**
 * Encode data (≤ 255 - nsym bytes) into a systematic codeword
 * [data | parity] of length data.length + nsym.
 */
export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  if (nsym <= 0 || nsym > 64) throw new Error(`bad nsym ${nsym}`);
  if (data.length + nsym > 255) throw new Error('codeword exceeds 255 bytes');
  const gen = generatorPoly(nsym);
  const parity = new Array<number>(nsym).fill(0);
  for (const byte of data) {
    const feedback = byte ^ (parity[0] ?? 0);
    parity.shift();
    parity.push(0);
    if (feedback !== 0) {
      for (let j = 0; j < nsym; j++) {
        parity[j] ^= gfMul(gen[j + 1] ?? 0, feedback);
      }
    }
  }
  return Uint8Array.of(...data, ...parity);
}

/** Syndromes S_0..S_{nsym-1} of a codeword (all zero = clean). */
function syndromes(code: Uint8Array, nsym: number): number[] {
  const syn: number[] = [];
  for (let i = 0; i < nsym; i++) syn.push(polyEval([...code], EXP[i]));
  return syn;
}

/** Evaluate poly in lowest-degree-first form at x. */
function polyEvalLow(coeffs: number[], x: number): number {
  let y = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) y = gfMul(y, x) ^ (coeffs[i] ?? 0);
  return y;
}

/** Berlekamp-Massey: error-locator poly (lowest-first) from syndromes. */
function berlekampMassey(syn: number[]): number[] {
  let locator = [1];
  let prev = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let n = 0; n < syn.length; n++) {
    let discrepancy = syn[n] ?? 0;
    for (let i = 1; i <= L; i++) {
      discrepancy ^= gfMul(locator[i] ?? 0, syn[n - i] ?? 0);
    }
    if (discrepancy === 0) {
      m++;
      continue;
    }
    const next = locator.slice();
    while (next.length < prev.length + m) next.push(0);
    const scale = gfDiv(discrepancy, b);
    for (let i = 0; i < prev.length; i++) {
      next[i + m] ^= gfMul(scale, prev[i] ?? 0);
    }
    if (2 * L <= n) {
      L = n + 1 - L;
      prev = locator;
      b = discrepancy;
      m = 1;
    } else {
      m++;
    }
    locator = next;
  }
  while (locator.length > 1 && locator[locator.length - 1] === 0) locator.pop();
  return locator;
}

/**
 * Decode one codeword: returns the data part, or null when uncorrectable.
 * Corrects up to floor(nsym/2) byte errors; anything else fails CLOSED
 * (verified by re-checking syndromes — never returns corrupt data).
 */
export function rsDecode(code: Uint8Array, nsym: number): Uint8Array | null {
  const n = code.length;
  const k = n - nsym;
  if (k <= 0 || n > 255) return null;
  const syn = syndromes(code, nsym);
  if (syn.every((s) => s === 0)) return code.slice(0, k);
  const locator = berlekampMassey(syn);
  const errors = locator.length - 1;
  if (errors <= 0 || errors > Math.floor(nsym / 2)) return null;

  // Chien search: error positions (array indices, high-degree first).
  // Root x = α^-i (i in 0..n-1) means an error at index n-1-i.
  const positions: number[] = [];
  for (let i = 0; i < n; i++) {
    if (polyEvalLow(locator, EXP[255 - (i % 255)]) === 0) {
      positions.push(n - 1 - i);
      if (positions.length > errors) return null;
    }
  }
  if (positions.length !== errors) return null;

  // Forney: error magnitudes. Ω = (S·Λ) mod x^nsym (lowest-first throughout),
  // Λ' the formal derivative: Λ'(x) keeps odd-powered terms shifted down.
  const prod = new Array<number>(syn.length + locator.length - 1).fill(0);
  for (let i = 0; i < syn.length; i++) {
    for (let j = 0; j < locator.length; j++) {
      prod[i + j] ^= gfMul(syn[i] ?? 0, locator[j] ?? 0);
    }
  }
  const omega = prod.slice(0, nsym);
  // Formal derivative in characteristic 2, lowest-first: Λ'(x) keeps the
  // odd-powered terms shifted down one (even terms vanish).
  const deriv: number[] = [];
  for (let i = 1; i < locator.length; i += 2) {
    deriv.push(locator[i] ?? 0);
    deriv.push(0);
  }
  deriv.pop();

  const fixed = code.slice();
  for (const pos of positions) {
    const i = n - 1 - pos;
    const xInv = EXP[255 - (i % 255)];
    const numerator = polyEvalLow(omega, xInv);
    const denominator = polyEvalLow(deriv, xInv);
    if (denominator === 0) return null;
    const x = EXP[i % 255];
    fixed[pos] ^= gfMul(x, gfDiv(numerator, denominator));
  }
  // Closed verification: corrected word must have zero syndromes.
  if (!syndromes(fixed, nsym).every((s) => s === 0)) return null;
  return fixed.slice(0, k);
}
