// Dot-grid detector (pure: runs in the decode worker AND in unit tests).
// Pipeline: grayscale -> Otsu threshold -> connected components -> find the
// four anchor squares (TL distinctive by size) -> homography from anchor
// centroids -> sample data cells -> bytes. Anything uncertain returns null;
// the frame CRC in the main thread is the final arbiter.

import {
  anchorCenters,
  bitsToBytes,
  DOT_ANCHOR,
  DOT_GAP,
  DOT_SIZES,
  type DotSize,
} from './grid.js';
import {
  CHROMA_REF_CELLS,
  classifyChroma,
  packQuads,
  refsUsable,
  type RGB,
} from './chroma.js';

export interface GrayImage {
  data: Uint8Array;
  w: number;
  h: number;
}

/** Rec.709 luminance to a single byte plane. */
export function toGray(rgba: Uint8ClampedArray, w: number, h: number): GrayImage {
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    data[i] = Math.round(
      0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2],
    );
  }
  return { data, w, h };
}

/** Otsu threshold over a region (defaults to the whole image). */
export function otsuThreshold(
  gray: GrayImage,
  region?: { x: number; y: number; w: number; h: number },
): number {
  const x0 = Math.max(0, region?.x ?? 0);
  const y0 = Math.max(0, region?.y ?? 0);
  const x1 = Math.min(gray.w, x0 + (region?.w ?? gray.w));
  const y1 = Math.min(gray.h, y0 + (region?.h ?? gray.h));
  const hist = new Uint32Array(256);
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      hist[gray.data[y * gray.w + x]]++;
      total++;
    }
  }
  if (total === 0) return 128;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let bestSum = 0;
  let bestCount = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0 || wB === total) continue;
    sumB += t * hist[t];
    const wF = total - wB;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestSum = t;
      bestCount = 1;
    } else if (between === best) {
      // Flat valley (e.g. two spikes): keep the middle, not the edge.
      bestSum += t;
      bestCount++;
    }
  }
  return bestCount === 0 ? 128 : Math.round(bestSum / bestCount);
}

export interface Blob {
  area: number;
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fill: number;
}

/** Two-pass connected-component labeling (4-connectivity) on dark pixels. */
export function labelDarkBlobs(dark: Uint8Array, w: number, h: number): Blob[] {
  const labels = new Int32Array(w * h);
  const parent: number[] = [0];
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    return r;
  };
  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!dark[y * w + x]) continue;
      const left = x > 0 && dark[y * w + x - 1] ? labels[y * w + x - 1] : 0;
      const up = y > 0 && dark[(y - 1) * w + x] ? labels[(y - 1) * w + x] : 0;
      if (left === 0 && up === 0) {
        parent.push(next);
        labels[y * w + x] = next;
        next++;
      } else if (left !== 0 && up !== 0 && find(left) !== find(up)) {
        const a = find(left);
        const b = find(up);
        parent[a > b ? a : b] = a > b ? b : a;
        labels[y * w + x] = a > b ? b : a;
      } else {
        labels[y * w + x] = left !== 0 ? find(left) : find(up);
      }
    }
  }
  interface Acc {
    area: number;
    sumX: number;
    sumY: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }
  const acc = new Map<number, Acc>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const raw = labels[y * w + x];
      if (raw === 0) continue;
      const root = find(raw);
      labels[y * w + x] = root;
      let a = acc.get(root);
      if (!a) {
        a = { area: 0, sumX: 0, sumY: 0, x0: x, y0: y, x1: x, y1: y };
        acc.set(root, a);
      }
      a.area++;
      a.sumX += x;
      a.sumY += y;
      if (x < a.x0) a.x0 = x;
      if (y < a.y0) a.y0 = y;
      if (x > a.x1) a.x1 = x;
      if (y > a.y1) a.y1 = y;
    }
  }
  const blobs: Blob[] = [];
  for (const a of acc.values()) {
    const bw = a.x1 - a.x0 + 1;
    const bh = a.y1 - a.y0 + 1;
    blobs.push({
      area: a.area,
      cx: a.sumX / a.area,
      cy: a.sumY / a.area,
      x0: a.x0,
      y0: a.y0,
      x1: a.x1,
      y1: a.y1,
      fill: a.area / (bw * bh),
    });
  }
  return blobs;
}

function cross(o: Blob, a: Blob, b: Blob): number {
  return (a.cx - o.cx) * (b.cy - o.cy) - (a.cy - o.cy) * (b.cx - o.cx);
}

function dist(a: Blob, b: Blob): number {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

/**
 * Find the four anchors among blobs: solid squares, three of one size and a
 * bigger top-left, arranged as a convex quadrilateral. Returns centroids in
 * image order [TL, TR, BR, BL] (two mirror assignments tried by the caller).
 */
export function findAnchorQuad(blobs: Blob[]): Blob[] | null {
  const solid = blobs.filter((b) => b.fill > 0.55 && b.area >= 9);
  if (solid.length < 4) return null;
  const byArea = solid.slice().sort((a, b) => b.area - a.area);
  const pool = byArea.slice(0, 16);
  let best: Blob[] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        for (let m = k + 1; m < pool.length; m++) {
          const quad = [pool[i], pool[j], pool[k], pool[m]];
          const score = quadScore(quad);
          if (score !== null && score < bestScore) {
            bestScore = score;
            best = quad;
          }
        }
      }
    }
  }
  if (!best || bestScore > 1.2) return null;
  return orderQuad(best);
}

/** Lower is better; null rejects (non-convex, skewed, or wrong anchors). */
function quadScore(quad: Blob[]): number | null {
  const ordered = orderQuad(quad);
  const [a, b, c, d] = ordered;
  // Convex: consistent turn direction.
  const signs = [cross(a, b, c), cross(b, c, d), cross(c, d, a), cross(d, a, b)];
  if (signs.some((s) => s === 0)) return null;
  if (!(signs.every((s) => s > 0) || signs.every((s) => s < 0))) return null;
  // Near-right angles: adjacent edges roughly perpendicular.
  const dot = (p: Blob, q: Blob, r: Blob): number => {
    const v1x = p.cx - q.cx;
    const v1y = p.cy - q.cy;
    const v2x = r.cx - q.cx;
    const v2y = r.cy - q.cy;
    const n1 = Math.hypot(v1x, v1y);
    const n2 = Math.hypot(v2x, v2y);
    if (n1 === 0 || n2 === 0) return 1;
    return Math.abs((v1x * v2x + v1y * v2y) / (n1 * n2));
  };
  const skew = dot(d, a, b) + dot(a, b, c) + dot(b, c, d) + dot(c, d, a);
  if (skew > 1.4) return null;
  // Side lengths: opposite pairs similar, overall squarish (tolerant).
  const sides = [dist(a, b), dist(b, c), dist(c, d), dist(d, a)];
  const lo = Math.min(...sides);
  const hi = Math.max(...sides);
  if (lo === 0 || hi / lo > 2.2) return null;
  // Areas: three similar + one ~2x (the distinctive TL anchor: 7x7 vs 5x5).
  const areas = quad.map((q) => q.area).sort((x, y) => x - y);
  if (areas[0] === 0) return null;
  if (areas[2] / areas[0] > 2.2) return null;
  const tlRatio = areas[3] / areas[2];
  if (tlRatio < 1.4 || tlRatio > 2.8) return null;
  return skew + (hi / lo - 1);
}

/** Order four blobs counter-clockwise starting from the biggest (TL). */
function orderQuad(quad: Blob[]): Blob[] {
  const cx = (quad[0].cx + quad[1].cx + quad[2].cx + quad[3].cx) / 4;
  const cy = (quad[0].cy + quad[1].cy + quad[2].cy + quad[3].cy) / 4;
  const byAngle = quad.slice().sort((p, q) => {
    const pa = Math.atan2(p.cy - cy, p.cx - cx);
    const qa = Math.atan2(q.cy - cy, q.cx - cx);
    return pa - qa;
  });
  const tlIdx = byAngle.reduce(
    (best, b, i) => (b.area > byAngle[best].area ? i : best),
    0,
  );
  return [
    byAngle[tlIdx],
    byAngle[(tlIdx + 1) % 4],
    byAngle[(tlIdx + 2) % 4],
    byAngle[(tlIdx + 3) % 4],
  ];
}

export type Homography = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Exact homography from 4 point correspondences (DLT, h33 = 1). */
export function solveHomography(
  src: { x: number; y: number }[],
  dst: { x: number; y: number }[],
): Homography | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  // 8x9 augmented system for h11..h32 (h33 fixed to 1).
  // u = (h11 x + h12 y + h13) / (h31 x + h32 y + 1), likewise v.
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const h = solveLinear8(rows);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Gaussian elimination with partial pivoting for an 8x9 system. */
function solveLinear8(rows: number[][]): number[] | null {
  const n = 8;
  const a = rows.map((r) => r.slice());
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = a[pivot];
      a[pivot] = a[col];
      a[col] = tmp;
    }
    const div = a[col][col];
    for (let c = col; c <= n; c++) a[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor !== 0) {
        for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
      }
    }
  }
  return a.map((r) => r[n]);
}

export function applyHomography(
  H: Homography,
  x: number,
  y: number,
): { x: number; y: number } {
  const w = H[6] * x + H[7] * y + H[8];
  if (Math.abs(w) < 1e-12) return { x: -1, y: -1 };
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  };
}

export interface DotDetection {
  bytes: Uint8Array;
  size: DotSize;
}

/** Shoelace area: positive = clockwise in y-down image coords. */
function signedArea(pts: { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Pick the grid size from measured geometry (scale-invariant): anchor
 * spacing over anchor size is (D + 2*GAP) / ANCHOR ≈ 21.2 for D96 and
 * ≈ 30.8 for D144, so a midpoint threshold is robust.
 */
function selectSize(ordered: Blob[]): DotSize {
  const small = [ordered[1], ordered[2], ordered[3]];
  const meanArea = (small[0].area + small[1].area + small[2].area) / 3;
  const sides = [
    dist(ordered[0], ordered[1]),
    dist(ordered[1], ordered[2]),
    dist(ordered[2], ordered[3]),
    dist(ordered[3], ordered[0]),
  ];
  const meanSide = (sides[0] + sides[1] + sides[2] + sides[3]) / 4;
  const ratio = meanSide / Math.sqrt(meanArea);
  let best: DotSize = DOT_SIZES[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const D of DOT_SIZES) {
    const gap = Math.abs(ratio - (D + 2 * DOT_GAP) / DOT_ANCHOR);
    if (gap < bestGap) {
      bestGap = gap;
      best = D;
    }
  }
  return best;
}

/**
 * Locate the grid: grayscale -> threshold -> blobs -> anchor quad.
 * Shared by the binary and chroma detectors (anchors are always black).
 */
export function locateGrid(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): { gray: GrayImage; quad: Blob[] } | null {
  const gray = toGray(rgba, width, height);
  const t = otsuThreshold(gray);
  const dark = new Uint8Array(width * height);
  for (let i = 0; i < dark.length; i++) dark[i] = gray.data[i] < t ? 1 : 0;
  const blobs = labelDarkBlobs(dark, width, height);
  const quad = findAnchorQuad(blobs);
  if (!quad) return null;
  return { gray, quad };
}

/** Orientation-resolved homography: grid module coords -> image pixels. */
export function homographyFor(quad: Blob[], D: DotSize): Homography | null {
  const centers = anchorCenters(D);
  // Angle-ascending order is clockwise (y-down) for normal views and
  // counter-clockwise for mirrored ones; map accordingly, no trial needed.
  const pts = quad.map((b) => ({ x: b.cx, y: b.cy }));
  const mapped =
    signedArea(pts) > 0
      ? [pts[0], pts[1], pts[2], pts[3]]
      : [pts[0], pts[3], pts[2], pts[1]];
  return solveHomography(centers, mapped);
}

/** Screen region (anchor bbox expanded) for adaptive thresholding. */
export function screenRegion(quad: Blob[]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const xs = quad.map((b) => b.cx);
  const ys = quad.map((b) => b.cy);
  return {
    x: Math.floor(Math.min(...xs) * 0.8),
    y: Math.floor(Math.min(...ys) * 0.8),
    w: Math.ceil((Math.max(...xs) - Math.min(...xs)) * 1.25),
    h: Math.ceil((Math.max(...ys) - Math.min(...ys)) * 1.25),
  };
}

/**
 * Full detect: anchor quad -> size -> homography -> sample. Returns sampled
 * grid bytes (RS-decoding happens in the caller); null when uncertain. The
 * frame CRC downstream is the final arbiter.
 */
export function detectDotFrame(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): DotDetection | null {
  const found = locateGrid(rgba, width, height);
  if (!found) return null;
  const { gray, quad } = found;
  const size = selectSize(quad);
  const H = homographyFor(quad, size);
  if (!H) return null;
  // Threshold from the screen region (anchor bbox expanded): bimodal there.
  const t2 = otsuThreshold(gray, screenRegion(quad));
  const bits = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const p = applyHomography(H, i + 0.5, j + 0.5);
      const px = Math.round(p.x);
      const py = Math.round(p.y);
      if (px < 0 || py < 0 || px >= width || py >= height) return null;
      bits[j * size + i] = gray.data[py * width + px] < t2 ? 1 : 0;
    }
  }
  return { bytes: bitsToBytes(bits), size };
}

export interface ChromaDetection {
  /** Classified 2-bit values packed MSB-first (4 cells per byte). */
  packed: Uint8Array;
  size: DotSize;
}

/**
 * Chroma detect: same anchors/geometry as binary dots, but module colors
 * are matched against per-capture calibration references (first 8 cells).
 * Returns packed values for RS-decoding upstream, or null when references
 * are degenerate or geometry fails.
 */
export function detectChromaFrame(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): ChromaDetection | null {
  const found = locateGrid(rgba, width, height);
  if (!found) return null;
  const { quad } = found;
  const size = selectSize(quad);
  const H = homographyFor(quad, size);
  if (!H) return null;
  const sampleRgb = (i: number, j: number): RGB | null => {
    const p = applyHomography(H, i + 0.5, j + 0.5);
    const px = Math.round(p.x);
    const py = Math.round(p.y);
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    const o = (py * width + px) * 4;
    return { r: rgba[o], g: rgba[o + 1], b: rgba[o + 2] };
  };
  // Calibration references: two samples per palette color, averaged.
  const refCells: RGB[][] = [[], [], [], []];
  for (let k = 0; k < CHROMA_REF_CELLS; k++) {
    const rgb = sampleRgb(k, 0);
    if (!rgb) return null;
    refCells[k % 4].push(rgb);
  }
  const refs = refCells.map((list) => {
    const n = Math.max(1, list.length);
    let r = 0;
    let g = 0;
    let b = 0;
    for (const s of list) {
      r += s.r;
      g += s.g;
      b += s.b;
    }
    return { r: r / n, g: g / n, b: b / n };
  }) as [RGB, RGB, RGB, RGB];
  if (!refsUsable(refs)) return null;
  const values = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const rgb = sampleRgb(i, j);
      if (!rgb) return null;
      values[j * size + i] = classifyChroma(rgb, refs).value;
    }
  }
  return { packed: packQuads(values), size };
}
