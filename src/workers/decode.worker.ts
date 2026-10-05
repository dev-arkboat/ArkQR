// Decode worker: runs off the main thread. The camera loop posts captures
// here and DROPS frames while a decode is in flight (skip-when-behind), so
// backpressure never queues up stale work.
//
// Per capture: jsQR on the full image first (QR symbols, one pass, full
// speed). Only on a miss, the experimental dot-grid detector (close range,
// centered captures). Every path returns raw frame bytes; the frame CRC in
// the main thread is the final arbiter.

import jsQR from 'jsqr';
import { detectChromaFrame } from '../dot/detect.js';
import { detectDotFrame } from '../dot/detect.js';

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
  /** Tagged candidates; the frame CRC downstream gates every family. */
  frames: ScannedFrame[];
}

/** One decoded candidate: family tag routes downstream processing. */
export interface ScannedFrame {
  kind: 'qr' | 'dots' | 'chroma';
  bytes: ArrayBuffer;
}

self.onmessage = (ev: MessageEvent<ScanMessage>): void => {
  const msg = ev.data;
  try {
    const frames: ScannedFrame[] = [];
    const push = (kind: ScannedFrame['kind'], bytes: Uint8Array): void => {
      // Copy into a fresh ArrayBuffer so ownership transfers cleanly.
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      frames.push({ kind, bytes: buf });
    };
    const code = jsQR(msg.data, msg.width, msg.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (code) {
      push('qr', Uint8Array.from(code.binaryData));
    } else {
      // Experimental dot grids: size self-selects from anchor geometry.
      const det = detectDotFrame(msg.data, msg.width, msg.height);
      if (det) {
        push('dots', det.bytes);
      } else {
        // Experimental color grids: per-capture calibration + RS layer.
        const chroma = detectChromaFrame(msg.data, msg.width, msg.height);
        if (chroma) push('chroma', chroma.packed);
      }
    }
    const transfer = frames.map((f) => f.bytes);
    self.postMessage(
      { kind: 'result', id: msg.id, frames } satisfies ResultMessage,
      transfer,
    );
  } catch {
    self.postMessage({ kind: 'result', id: msg.id, frames: [] } satisfies ResultMessage);
  }
};
