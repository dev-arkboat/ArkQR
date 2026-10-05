// Decode worker: runs jsQR off the main thread. The camera loop posts camera
// pixels here and DROPS frames while a decode is in flight (skip-when-behind),
// so backpressure never queues up stale work.
//
// Strategy per capture: decode the full image first (single-QR layout hits
// here, one pass, full speed). Only on a miss, try the four exact halves
// (2×2 tiled layout). Halves are exact — never overlapping — because jsQR
// fails outright when two codes share a frame. Identical payloads dedupe, so
// one camera shot of a quad screen can yield up to 4 fountain frames.

import jsQR from 'jsqr';
import { dedupeFrames, halfCrops, type Crop } from '../qr/tiles.js';

export interface ScanMessage {
  kind: 'scan';
  id: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface ResultMessage {
  kind: 'result';
  id: number;
  /** Raw byte-mode payloads of every distinct QR found (often 0 or 1). */
  frames: ArrayBuffer[];
}

function extractCrop(
  data: Uint8ClampedArray,
  fullWidth: number,
  fullHeight: number,
  crop: Crop,
): { data: Uint8ClampedArray; w: number; h: number } {
  const x0 = Math.max(0, Math.min(fullWidth - 1, crop.x));
  const y0 = Math.max(0, Math.min(fullHeight - 1, crop.y));
  const w = Math.max(1, Math.min(crop.w, fullWidth - x0));
  const h = Math.max(1, Math.min(crop.h, fullHeight - y0));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * fullWidth + x0) * 4;
    out.set(data.subarray(src, src + w * 4), y * w * 4);
  }
  return { data: out, w, h };
}

function tryDecode(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  into: Uint8Array[],
): void {
  const code = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  if (code) into.push(Uint8Array.from(code.binaryData));
}

self.onmessage = (ev: MessageEvent<ScanMessage>): void => {
  const msg = ev.data;
  try {
    const found: Uint8Array[] = [];
    tryDecode(msg.data, msg.width, msg.height, found);
    if (found.length === 0) {
      // No single code in view: maybe a tiled screen — try exact halves.
      for (const crop of halfCrops(msg.width, msg.height)) {
        const part = extractCrop(msg.data, msg.width, msg.height, crop);
        tryDecode(part.data, part.w, part.h, found);
      }
    }
    const unique = dedupeFrames(found);
    // Copy into fresh ArrayBuffers so ownership transfers cleanly.
    const frames: ArrayBuffer[] = unique.map((bytes) => {
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      return buf;
    });
    self.postMessage(
      { kind: 'result', id: msg.id, frames } satisfies ResultMessage,
      frames,
    );
  } catch {
    self.postMessage({ kind: 'result', id: msg.id, frames: [] } satisfies ResultMessage);
  }
};
