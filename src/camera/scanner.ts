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

export async function nativeDetectorSupported(): Promise<boolean> {
  const Ctor = getDetectorConstructor();
  if (!Ctor) return false;
  const formats = await nativeFormats();
  return formats === null ? true : formats.includes('qr_code');
}

const SCAN_INTERVAL_MS = 120;
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
    if (!cameraSupported()) {
      throw new Error('Camera capture is not supported in this browser.');
    }
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      throw new Error(permissionMessage(err));
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

function permissionMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was denied. Allow camera permission and use HTTPS or localhost, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No suitable camera was found on this device.';
  }
  if (name === 'NotReadableError') {
    return 'The camera is in use by another app. Close it and try again.';
  }
  return 'Could not start the camera. Use HTTPS or localhost and grant permission, then try again.';
}
