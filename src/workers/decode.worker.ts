// Decode worker: runs jsQR off the main thread. The camera loop posts camera
// pixels here and DROPS frames while a decode is in flight (skip-when-behind),
// so backpressure never queues up stale work.

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
  found: boolean;
  /** Raw byte-mode bytes of the QR payload (from jsQR binaryData). */
  bytes?: ArrayBuffer;
}

self.onmessage = (ev: MessageEvent<ScanMessage>): void => {
  const msg = ev.data;
  try {
    const found = jsQR(msg.data, msg.width, msg.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (!found) {
      self.postMessage({
        kind: 'result',
        id: msg.id,
        found: false,
      } satisfies ResultMessage);
      return;
    }
    const bytes = Uint8Array.from(found.binaryData);
    self.postMessage(
      {
        kind: 'result',
        id: msg.id,
        found: true,
        bytes: bytes.buffer,
      } satisfies ResultMessage,
      [bytes.buffer],
    );
  } catch {
    self.postMessage({
      kind: 'result',
      id: msg.id,
      found: false,
    } satisfies ResultMessage);
  }
};
