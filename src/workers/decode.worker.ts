// Decode worker: runs jsQR off the main thread. The camera loop posts camera
// pixels here and DROPS frames while a decode is in flight (skip-when-behind),
// so backpressure never queues up stale work. One capture yields at most one
// frame (jsQR locks onto a single code per image); the fountain code makes
// every captured frame useful regardless of order or duplicates.

import jsQR from 'jsqr';

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
  /** Raw byte-mode payloads found (usually 0 or 1). */
  frames: ArrayBuffer[];
}

self.onmessage = (ev: MessageEvent<ScanMessage>): void => {
  const msg = ev.data;
  try {
    const code = jsQR(msg.data, msg.width, msg.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (!code) {
      self.postMessage({
        kind: 'result',
        id: msg.id,
        frames: [],
      } satisfies ResultMessage);
      return;
    }
    const bytes = Uint8Array.from(code.binaryData);
    // Copy into a fresh ArrayBuffer so ownership transfers cleanly.
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    self.postMessage(
      { kind: 'result', id: msg.id, frames: [buf] } satisfies ResultMessage,
      [buf],
    );
  } catch {
    self.postMessage({ kind: 'result', id: msg.id, frames: [] } satisfies ResultMessage);
  }
};
