// Camera capture + QR detection orchestration.
// Strategy: native BarcodeDetector when available (spec order), jsQR in a
// Web Worker otherwise. Known wrinkle, documented in README/PROTOCOL: native
// detectors surface text, which cannot losslessly carry our BINARY frames, so
// in `auto` mode repeated native detections that never validate trigger an
// automatic switch to the jsQR worker. Frames are processed off the main
// thread and skipped (never queued) when the pipeline is behind.

import type { ResultMessage, ScanMessage } from '../workers/decode.worker.js';
import { latin1ToBytes } from '../qr/matrix.js';

export type DecoderMode = 'auto' | 'native' | 'jsqr';
export type DecoderSource = 'native' | 'jsqr';

/** Return value tells the scanner whether the frame validated (CRC ok). */
export type BytesHandler = (bytes: Uint8Array, source: DecoderSource) => boolean;

export interface ScannerCallbacks {
  onBytes: BytesHandler;
  onStrategy?: (source: DecoderSource, autoSwitched: boolean) => void;
  onError?: (message: string) => void;
}

/** Structural view of the platform BarcodeDetector (no lib dependency). */
interface NativeDetector {
  detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]>;
}

function getDetectorConstructor(): (new (opts?: object) => NativeDetector) | null {
  const w = window as unknown as {
    BarcodeDetector?: new (opts?: object) => NativeDetector;
  };
  return typeof w.BarcodeDetector === 'function' ? w.BarcodeDetector : null;
}

async function nativeFormats(): Promise<string[] | null> {
  const w = window as unknown as {
    BarcodeDetector?: { getSupportedFormats?: () => Promise<string[]> };
  };
  try {
    const fn = w.BarcodeDetector?.getSupportedFormats;
    if (typeof fn === 'function') return await fn();
  } catch {
    // Fall through: assume nothing.
  }
  return null;
}

export function cameraSupported(): boolean {
  const md = navigator.mediaDevices;
  return (
    md !== undefined &&
    typeof md.getUserMedia === 'function' &&
    typeof Worker === 'function'
  );
}

/**
 * Camera access requires a secure context (HTTPS or localhost); on plain
 * HTTP, opened files, etc. the platform exposes no camera API at all.
 */
export function isSecureContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext;
}

/** Actionable guidance when the page itself cannot offer the camera. */
export function insecureContextHint(): string {
  if (typeof window === 'undefined' || !window.location) {
    return 'Camera access needs a secure context: serve ArkQR over HTTPS or localhost.';
  }
  const protocol = window.location.protocol;
  const host = window.location.host || window.location.hostname;
  if (protocol === 'file:') {
    return 'This page was opened as a file, so the browser exposes no camera. Serve it instead (e.g. run "npm run dev" and open the localhost URL), or deploy over HTTPS. No camera at all? Use “Scan from photo” below.';
  }
  return (
    `Camera access needs HTTPS or localhost (currently ${protocol}//${host}). ` +
    'For phone-to-phone testing over LAN run "npm run dev:https", accept the self-signed certificate, and open the https:// address it prints. ' +
    'No camera at all? Use “Scan from photo” below.'
  );
}

/**
 * Pure mapping of getUserMedia failures to actionable messages (kept
 * function-pure for unit tests; context advice lives in insecureContextHint).
 */
export function describeCameraError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError') {
    return 'Camera permission was denied. Re-allow it in the browser site settings (lock/tune icon in the address bar), then press Start camera again.';
  }
  if (name === 'SecurityError') {
    return 'The browser blocked the camera for security reasons — this usually means an insecure context. Serve over HTTPS or localhost and try again.';
  }
  if (name === 'NotFoundError') {
    return 'No camera was found on this device. Attach or enable one, or use “Scan from photo” instead.';
  }
  if (name === 'OverconstrainedError') {
    return 'No camera on this device matches the requested mode. Use “Scan from photo” instead, or try another device.';
  }
  if (name === 'NotReadableError') {
    return 'The camera is in use by another app or tab. Close it and try again.';
  }
  if (name === 'AbortError') {
    return 'The camera start was interrupted. Press Start camera and try again.';
  }
  const detail = name ? ` (${name})` : '';
  return `Could not start the camera${detail}. Check permission, close other apps using the camera, and use HTTPS or localhost.`;
}

export async function nativeDetectorSupported(): Promise<boolean> {
  const Ctor = getDetectorConstructor();
  if (!Ctor) return false;
  const formats = await nativeFormats();
  return formats === null ? true : formats.includes('qr_code');
}

const SCAN_INTERVAL_MS = 80;
const MAX_NATIVE_DUDS = 30;
const JSQR_MAX_DIM = 960;

export class CameraScanner {
  private stream: MediaStream | null = null;
  private detector: NativeDetector | null = null;
  private worker: Worker | null = null;
  private workerBusy = false;
  private scanId = 0;
  private rafId = 0;
  private running = false;
  private lastScan = 0;
  private nativeInflight = false;
  private nativeDuds = 0;
  private activeSource: DecoderSource = 'jsqr';
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly scratch: HTMLCanvasElement,
    private readonly callbacks: ScannerCallbacks,
    private readonly mode: DecoderMode = 'auto',
  ) {
    this.ctx = scratch.getContext('2d', { willReadFrequently: true });
  }

  get source(): DecoderSource {
    return this.activeSource;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!isSecureContext()) {
      throw new Error(insecureContextHint());
    }
    if (!cameraSupported()) {
      throw new Error(
        'Camera capture is not supported in this browser. Use “Scan from photo” instead, or try current Chrome/Safari/Firefox.',
      );
    }
    const full: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(full);
    } catch (err) {
      // Over-strict ideals (e.g. a desktop with one odd webcam) should not
      // be fatal: retry with the bare minimum before giving up.
      if (err instanceof Error && err.name === 'OverconstrainedError') {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: true,
          });
        } catch (retryErr) {
          throw new Error(describeCameraError(retryErr));
        }
      } else {
        throw new Error(describeCameraError(err));
      }
    }
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', 'true');
    await this.video.play().catch(() => undefined);
    await this.requestContinuousFocus(stream);

    if (this.mode !== 'jsqr' && (await nativeDetectorSupported())) {
      const Ctor = getDetectorConstructor();
      if (Ctor) {
        try {
          this.detector = new Ctor({ formats: ['qr_code'] });
          this.activeSource = 'native';
        } catch {
          this.detector = null;
        }
      }
    }
    if (this.mode === 'jsqr' || !this.detector) {
      this.activeSource = 'jsqr';
      this.ensureWorker();
    }
    this.callbacks.onStrategy?.(this.activeSource, false);
    this.running = true;
    this.lastScan = 0;
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.nativeInflight = false;
    this.workerBusy = false;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video.srcObject) this.video.srcObject = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.detector = null;
  }

  private async requestContinuousFocus(stream: MediaStream): Promise<void> {
    try {
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      const advanced = { advanced: [{ focusMode: 'continuous' }] };
      await track.applyConstraints(advanced as MediaTrackConstraints);
    } catch {
      // Optional enhancement; ignore when unsupported.
    }
  }

  private ensureWorker(): void {
    if (this.worker || typeof Worker !== 'function') return;
    this.worker = new Worker(new URL('../workers/decode.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (ev: MessageEvent<ResultMessage>) => {
      this.workerBusy = false;
      const msg = ev.data;
      if (msg.found && msg.bytes) {
        this.callbacks.onBytes(new Uint8Array(msg.bytes), 'jsqr');
      }
    };
    this.worker.onerror = (): void => {
      this.workerBusy = false;
      this.callbacks.onError?.(
        'Background QR decoder failed; try restarting the camera.',
      );
    };
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (now - this.lastScan < SCAN_INTERVAL_MS) return;
    // Skip when behind: never overlap native detects or worker decodes.
    if (this.nativeInflight || this.workerBusy) return;
    if (this.video.readyState < 2 || this.video.videoWidth === 0) return;
    this.lastScan = now;
    if (this.activeSource === 'native' && this.detector) {
      void this.nativeScan();
    } else {
      this.jsqrScan();
    }
  };

  private async nativeScan(): Promise<void> {
    if (!this.detector || this.nativeInflight) return;
    this.nativeInflight = true;
    try {
      const codes = await this.detector.detect(this.video);
      if (codes.length === 0) return;
      let anyValid = false;
      for (const code of codes) {
        if (typeof code.rawValue !== 'string' || code.rawValue.length === 0) continue;
        const valid = this.callbacks.onBytes(latin1ToBytes(code.rawValue), 'native');
        anyValid = anyValid || valid;
      }
      this.noteNativeOutcome(anyValid);
    } catch {
      // Native path broke mid-stream: fall back to jsQR in auto mode.
      this.switchToJsqr(true);
    } finally {
      this.nativeInflight = false;
    }
  }

  private noteNativeOutcome(anyValid: boolean): void {
    if (anyValid) {
      this.nativeDuds = 0;
      return;
    }
    if (this.mode !== 'auto') return;
    this.nativeDuds++;
    if (this.nativeDuds >= MAX_NATIVE_DUDS) this.switchToJsqr(true);
  }

  private switchToJsqr(auto: boolean): void {
    this.detector = null;
    this.activeSource = 'jsqr';
    this.ensureWorker();
    this.callbacks.onStrategy?.('jsqr', auto);
  }

  private jsqrScan(): void {
    if (!this.ctx || this.workerBusy || !this.worker) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const scale = Math.min(1, JSQR_MAX_DIM / Math.max(vw, vh));
    const w = Math.max(2, Math.floor(vw * scale));
    const h = Math.max(2, Math.floor(vh * scale));
    if (this.scratch.width !== w || this.scratch.height !== h) {
      this.scratch.width = w;
      this.scratch.height = h;
    }
    try {
      this.ctx.drawImage(this.video, 0, 0, w, h);
      const image = this.ctx.getImageData(0, 0, w, h);
      this.workerBusy = true;
      this.scanId++;
      const msg: ScanMessage = {
        kind: 'scan',
        id: this.scanId,
        data: image.data,
        width: w,
        height: h,
      };
      this.worker.postMessage(msg, [image.data.buffer]);
    } catch {
      this.workerBusy = false;
    }
  }
}

// ---- Still-photo fallback -------------------------------------------------
// No camera, denied permission, or desktop testing: decode QR frames from
// image files (photos of the sender screen, screenshots). One photo carries
// one frame; each decoded frame feeds the exact same validation + fountain
// pipeline as live scans.

const STILL_MAX_DIM = 1600;
const STILL_TIMEOUT_MS = 20000;

interface Drawable {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose?: () => void;
}

async function loadDrawable(file: File): Promise<Drawable> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => {
          bitmap.close();
        },
      };
    } catch {
      // Fall through to the <img> path (e.g. an exotic format).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => {
        resolve();
      };
      img.onerror = () => {
        reject(new Error('unreadable image'));
      };
      img.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function rasterize(drawable: Drawable): ImageData {
  const scale = Math.min(1, STILL_MAX_DIM / Math.max(drawable.width, drawable.height));
  const w = Math.max(2, Math.round(drawable.width * scale));
  const h = Math.max(2, Math.round(drawable.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas is unavailable in this browser.');
  ctx.drawImage(drawable.source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * Decode every image file through the jsQR worker; returns the raw QR
 * payloads found (files without a readable QR are skipped).
 */
export async function decodeImageFiles(files: File[]): Promise<Uint8Array[]> {
  if (typeof Worker !== 'function') {
    throw new Error('Web Workers are unavailable in this browser.');
  }
  const worker = new Worker(new URL('../workers/decode.worker.ts', import.meta.url), {
    type: 'module',
  });
  const pending = new Map<number, (bytes: Uint8Array | null) => void>();
  let scanId = 0;
  worker.onmessage = (ev: MessageEvent<ResultMessage>): void => {
    const msg = ev.data;
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve?.(msg.found && msg.bytes ? new Uint8Array(msg.bytes) : null);
  };
  worker.onerror = (): void => {
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  };
  const found: Uint8Array[] = [];
  try {
    for (const file of files) {
      const bytes = await decodeOneImage(worker, pending, file, () => ++scanId);
      if (bytes) found.push(bytes);
    }
  } finally {
    worker.terminate();
  }
  return found;
}

async function decodeOneImage(
  worker: Worker,
  pending: Map<number, (bytes: Uint8Array | null) => void>,
  file: File,
  nextId: () => number,
): Promise<Uint8Array | null> {
  let drawable: Drawable | null = null;
  try {
    drawable = await loadDrawable(file);
    const pixels = rasterize(drawable);
    const id = nextId();
    const result = new Promise<Uint8Array | null>((resolve) => {
      pending.set(id, resolve);
      const msg: ScanMessage = {
        kind: 'scan',
        id,
        data: pixels.data,
        width: pixels.width,
        height: pixels.height,
      };
      try {
        worker.postMessage(msg, [pixels.data.buffer]);
      } catch {
        pending.delete(id);
        resolve(null);
      }
      setTimeout(() => {
        if (pending.delete(id)) resolve(null);
      }, STILL_TIMEOUT_MS);
    });
    return await result;
  } catch {
    return null;
  } finally {
    drawable?.dispose?.();
  }
}
