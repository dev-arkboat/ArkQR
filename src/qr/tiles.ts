// Pure helpers for multi-QR (tiled) presentation. The wire format is
// untouched: each tile is one ordinary frame with its own seed. Fountain
// coding makes this robust — a partially visible grid still yields useful
// frames, in any order, with duplicates harmless.

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cell {
  x: number;
  y: number;
  size: number;
}

/**
 * Exact image halves (top-left, top-right, bottom-left, bottom-right).
 * Deliberately NOT overlapping: jsQR locks onto one code per image and fails
 * outright when two codes share the frame, tolerating only small (<~8 module)
 * slivers. Halves isolate one tile each when the screen is roughly centered;
 * misalignment just yields fewer frames per capture, which fountain codes
 * absorb. The viewfinder overlay guides centering.
 */
export function halfCrops(width: number, height: number): Crop[] {
  const hw = Math.floor(width / 2);
  const hh = Math.floor(height / 2);
  // 1 px center overlap (odd dimensions would otherwise leave a gap strip);
  // jsQR tolerates far larger slivers, so the overlap is harmless.
  return [
    { x: 0, y: 0, w: hw + 1, h: hh + 1 },
    { x: hw, y: 0, w: width - hw, h: hh + 1 },
    { x: 0, y: hh, w: hw + 1, h: height - hh },
    { x: hw, y: hh, w: width - hw, h: height - hh },
  ];
}

/** Drop byte-identical frames (same tile found via several crops). */
export function dedupeFrames(frames: Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const frame of frames) {
    if (!out.some((seen) => bytesEqual(seen, frame))) out.push(frame);
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Four equal cells in an S×S canvas with outer margin and gutters. */
export function quadCells(canvasSize: number, margin: number, gutter: number): Cell[] {
  const cell = Math.max(1, Math.floor((canvasSize - margin * 2 - gutter) / 2));
  const cells: Cell[] = [];
  for (let i = 0; i < 4; i++) {
    cells.push({
      x: margin + (i % 2) * (cell + gutter),
      y: margin + Math.floor(i / 2) * (cell + gutter),
      size: cell,
    });
  }
  return cells;
}
