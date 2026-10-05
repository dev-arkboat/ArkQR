// SEND mode: file picker / drag-drop -> encode worker -> endless QR stream
// painted on canvas with requestAnimationFrame timing. Also owns the
// optional MediaRecorder video export (separate large canvas, fixed high
// bitrate, lower frame rate).

import { MAX_FILE_BYTES } from '../core/constants.js';
import {
  DENSITY_PRESETS,
  estimateSeconds,
  formatBytes,
  formatEta,
  type DensityPreset,
  type PreparedTransfer,
} from '../core/protocol.js';
import { INK_COLORS, paintFrame, type InkName } from '../qr/paint.js';
import type { EcLevel } from '../qr/matrix.js';
import { EncodeClient, FrameStream, type TransferInfo } from '../workers/encodeClient.js';
import { WakeLock } from './wake.js';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const EXPORT_FPS = 4;
const EXPORT_SIZE = 1024;
const EXPORT_BITRATE = 12_000_000;
const EXPORT_MIMES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

function pickExportMime(): string | null {
  if (typeof MediaRecorder !== 'function') return null;
  for (const m of EXPORT_MIMES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      continue;
    }
  }
  return null;
}

export class SendController {
  private file: File | null = null;
  private client: EncodeClient | null = null;
  private stream: FrameStream | null = null;
  private info: TransferInfo | null = null;
  private playing = false;
  private fps = 12;
  private rafId = 0;
  private lastTick = 0;
  private framesSent = 0;
  private prefetch: Promise<Uint8Array> | null = null;
  private showing = false;
  private readonly wake = new WakeLock();

  private exportRecorder: MediaRecorder | null = null;
  private exportChunks: Blob[] = [];
  private exportMime: string | null = null;
  private exportUrl: string | null = null;
  private exportTimer = 0;
  private exportStream: FrameStream | null = null;
  private exportCanvas: HTMLCanvasElement | null = null;
  private exportFrames = 0;

  private readonly ui = {
    dropZone: el<HTMLDivElement>('drop-zone'),
    fileInput: el<HTMLInputElement>('file-input'),
    fileInfo: el<HTMLDivElement>('file-info'),
    fileName: el<HTMLElement>('send-filename'),
    fileSize: el<HTMLElement>('send-filesize'),
    eta: el<HTMLElement>('send-eta'),
    frames: el<HTMLElement>('frames-sent'),
    warn: el<HTMLParagraphElement>('send-warn'),
    fpsSlider: el<HTMLInputElement>('fps-slider'),
    fpsValue: el<HTMLElement>('fps-value'),
    capInput: el<HTMLInputElement>('cap-input'),
    play: el<HTMLButtonElement>('play-btn'),
    fullscreen: el<HTMLButtonElement>('fullscreen-btn'),
    reset: el<HTMLButtonElement>('send-reset-btn'),
    canvas: el<HTMLCanvasElement>('qr-canvas'),
    qrWrap: el<HTMLDivElement>('qr-wrap'),
    live: el<HTMLElement>('send-live'),
    stageFps: el<HTMLElement>('stage-fps'),
    status: el<HTMLParagraphElement>('send-status'),
    exportBtn: el<HTMLButtonElement>('export-btn'),
    exportStop: el<HTMLButtonElement>('export-stop-btn'),
    exportStatus: el<HTMLParagraphElement>('export-status'),
    exportDownload: el<HTMLAnchorElement>('export-download'),
  };

  init(): void {
    const { dropZone, fileInput } = this.ui;
    dropZone.addEventListener('click', () => {
      fileInput.click();
    });
    dropZone.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) void this.setFile(f);
      fileInput.value = '';
    });
    for (const ev of ['dragenter', 'dragover'] as const) {
      dropZone.addEventListener(ev, (e: DragEvent) => {
        e.preventDefault();
        dropZone.classList.add('dragging');
      });
    }
    for (const ev of ['dragleave', 'drop'] as const) {
      dropZone.addEventListener(ev, (e: DragEvent) => {
        e.preventDefault();
        dropZone.classList.remove('dragging');
      });
    }
    dropZone.addEventListener('drop', (e: DragEvent) => {
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.setFile(f);
    });

    this.ui.fpsSlider.addEventListener('input', () => {
      this.fps = Number(this.ui.fpsSlider.value);
      this.ui.fpsValue.textContent = `${this.fps} fps`;
      this.ui.stageFps.textContent = `${this.fps} fps`;
      this.refreshEta();
    });
    for (const preset of Object.keys(DENSITY_PRESETS) as DensityPreset[]) {
      el<HTMLInputElement>(`preset-${preset}`).addEventListener('change', () => {
        if (this.file) {
          void this.setFile(
            this.file,
            'Stream restarted with new density — receivers must press Reset.',
          );
        }
      });
    }
    this.ui.play.addEventListener('click', () => {
      this.togglePlay();
    });
    this.ui.fullscreen.addEventListener('click', () => {
      void this.toggleFullscreen();
    });
    this.ui.reset.addEventListener('click', () => {
      this.reset();
    });
    this.ui.exportBtn.addEventListener('click', () => {
      this.startExport();
    });
    this.ui.exportStop.addEventListener('click', () => {
      this.stopExport();
    });
    this.refreshEta();
  }

  private capBytes(): number {
    const mb = Math.max(1, Math.min(32, Math.floor(Number(this.ui.capInput.value) || 5)));
    return Math.min(mb * 1024 * 1024, MAX_FILE_BYTES);
  }

  async setFile(file: File, note?: string): Promise<void> {
    const cap = this.capBytes();
    if (file.size > cap) {
      this.setStatus(
        `File too large: ${formatBytes(file.size)} exceeds the ${formatBytes(cap)} cap. Raise the cap or pick a smaller file.`,
      );
      return;
    }
    this.teardownStream();
    this.file = file;
    this.setStatus('Preparing file (compressing, hashing, chunking)…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const blockSize = this.selectedBlockSize();
      const client = new EncodeClient();
      const info = await client.init(
        bytes,
        file.name || 'file',
        file.type || 'application/octet-stream',
        blockSize,
      );
      this.client = client;
      this.info = info;
      this.stream = client.createStream(info);
      this.framesSent = 0;
      this.prefetch = null;
      this.ui.fileInfo.hidden = false;
      this.ui.fileName.textContent = info.fileName;
      this.ui.fileSize.textContent = `${formatBytes(info.originalSize)}${info.compressed ? ` → ${formatBytes(info.compressedSize)} gzip` : ' (incompressible)'}`;
      this.refreshEta();
      this.updateWarn();
      this.ui.play.disabled = false;
      this.ui.fullscreen.disabled = false;
      this.ui.reset.disabled = false;
      this.ui.exportBtn.disabled = false;
      this.playing = true;
      this.ui.play.textContent = 'Pause';
      this.ui.live.hidden = false;
      this.lastTick = performance.now();
      this.setStatus(
        note ?? `Streaming “${info.fileName}”. Point the receiver camera at this screen.`,
      );
      void this.wake.acquire();
      cancelAnimationFrame(this.rafId);
      this.rafId = requestAnimationFrame(this.tick);
    } catch (err) {
      this.setStatus(
        `Could not prepare file: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }

  private selectedBlockSize(): number {
    for (const preset of Object.keys(DENSITY_PRESETS) as DensityPreset[]) {
      if (el<HTMLInputElement>(`preset-${preset}`).checked)
        return DENSITY_PRESETS[preset].blockSize;
    }
    return DENSITY_PRESETS.balanced.blockSize;
  }

  private selectedInk(): string {
    for (const ink of ['black', 'red', 'green', 'blue'] as InkName[]) {
      if (el<HTMLInputElement>(`ink-${ink}`).checked) return INK_COLORS[ink];
    }
    return INK_COLORS.black;
  }

  private selectedEc(): EcLevel {
    return el<HTMLInputElement>('ec-l').checked ? 'L' : 'M';
  }

  private refreshEta(): void {
    if (!this.info) {
      this.ui.eta.textContent = '—';
      return;
    }
    this.ui.eta.textContent = formatEta(estimateSeconds(this.info.blockCount, this.fps));
  }

  private updateWarn(): void {
    if (!this.info) {
      this.ui.warn.hidden = true;
      return;
    }
    const secs = estimateSeconds(this.info.blockCount, this.fps);
    if (secs > 300) {
      this.ui.warn.hidden = false;
      this.ui.warn.textContent = `Long transfer: estimated ${formatEta(secs)} at ${this.fps} fps. Try a denser preset or a higher speed — scanning stays reliable only if the receiver keeps up.`;
    } else {
      this.ui.warn.hidden = true;
    }
  }

  private readonly tick = (): void => {
    this.rafId = requestAnimationFrame(this.tick);
    if (!this.playing || !this.stream) return;
    const now = performance.now();
    const interval = 1000 / this.fps;
    if (now - this.lastTick < interval) return;
    // Fixed-step advance with a small catch-up cap: no setInterval drift, no spiral.
    const steps = Math.min(3, Math.floor((now - this.lastTick) / interval));
    this.lastTick += steps * interval;
    if (this.lastTick < now - interval * 3) this.lastTick = now;
    void this.showNext();
  };

  private async showNext(): Promise<void> {
    const stream = this.stream;
    if (this.showing || !stream) return;
    this.showing = true;
    try {
      const frame = await this.nextFrame(stream);
      paintFrame(this.ui.canvas, frame, {
        targetSize: 640,
        foreground: this.selectedInk(),
        ecLevel: this.selectedEc(),
      });
      this.framesSent++;
      this.ui.frames.textContent = String(this.framesSent);
    } catch (err) {
      this.setStatus(
        `Stream error: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      this.playing = false;
      this.ui.play.textContent = 'Play';
      this.ui.live.hidden = true;
    } finally {
      this.showing = false;
    }
  }

  /** One stream frame, keeping a single prefetch in flight for smoothness. */
  private async nextFrame(stream: FrameStream): Promise<Uint8Array> {
    this.prefetch ??= stream.next();
    const frame = await this.prefetch;
    if (this.stream) {
      this.prefetch = this.stream.next();
      this.prefetch.catch(() => undefined);
    } else {
      this.prefetch = null;
    }
    return frame;
  }

  private togglePlay(): void {
    if (!this.stream) return;
    this.playing = !this.playing;
    this.ui.play.textContent = this.playing ? 'Pause' : 'Play';
    this.ui.live.hidden = !this.playing;
    if (this.playing) {
      this.lastTick = performance.now();
      void this.wake.acquire();
      this.setStatus('Streaming…');
    } else {
      void this.wake.release();
      this.setStatus('Paused. Press Play to resume the stream.');
    }
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await this.ui.qrWrap.requestFullscreen();
      }
    } catch {
      this.setStatus('Fullscreen was blocked by the browser.');
    }
  }

  reset(): void {
    this.stopExport();
    this.teardownStream();
    this.file = null;
    this.ui.fileInfo.hidden = true;
    this.ui.play.disabled = true;
    this.ui.fullscreen.disabled = true;
    this.ui.reset.disabled = true;
    this.ui.exportBtn.disabled = true;
    this.ui.frames.textContent = '0';
    this.ui.eta.textContent = '—';
    this.ui.warn.hidden = true;
    this.ui.live.hidden = true;
    const ctx = this.ui.canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.ui.canvas.width, this.ui.canvas.height);
    }
    void this.wake.release();
    this.setStatus('Choose a file to begin.');
  }

  private teardownStream(): void {
    cancelAnimationFrame(this.rafId);
    this.stream = null;
    this.info = null;
    this.prefetch = null;
    this.playing = false;
    this.ui.play.textContent = 'Play';
    if (this.client) {
      this.client.terminate();
      this.client = null;
    }
  }

  private setStatus(text: string): void {
    this.ui.status.textContent = text;
  }

  // ---- Video export ----

  private startExport(): void {
    if (!this.client || !this.info || this.exportRecorder) return;
    this.exportMime = pickExportMime();
    if (!this.exportMime) {
      this.ui.exportStatus.textContent =
        'MediaRecorder is not supported in this browser.';
      return;
    }
    if (typeof HTMLCanvasElement !== 'function') return;
    const canvas = document.createElement('canvas');
    this.exportCanvas = canvas;
    const probe = canvas.captureStream?.(EXPORT_FPS);
    if (!probe) {
      this.ui.exportStatus.textContent =
        'Canvas capture is not supported in this browser.';
      return;
    }
    this.exportStream = this.client.createStream(this.info);
    this.exportChunks = [];
    this.exportFrames = 0;
    try {
      const recorder = new MediaRecorder(probe, {
        mimeType: this.exportMime,
        videoBitsPerSecond: EXPORT_BITRATE,
      });
      recorder.ondataavailable = (ev: BlobEvent): void => {
        if (ev.data.size > 0) this.exportChunks.push(ev.data);
      };
      recorder.onstop = (): void => {
        this.finishExport();
      };
      recorder.onerror = (): void => {
        this.ui.exportStatus.textContent = 'Recording failed.';
      };
      this.exportRecorder = recorder;
      recorder.start(1000);
      this.ui.exportBtn.disabled = true;
      this.ui.exportStop.disabled = false;
      this.ui.exportStatus.textContent = `Recording at ${EXPORT_FPS} fps, ${EXPORT_SIZE}px QR, ~12 Mbps. Keep this tab visible.`;
      const started = Date.now();
      const step = async (): Promise<void> => {
        if (!this.exportRecorder || !this.exportStream || !this.exportCanvas) return;
        try {
          const frame = await this.exportStream.next();
          // Export always uses black ink + M correction: recordings compress
          // and blur worse than live screens, so maximum robustness wins.
          paintFrame(this.exportCanvas, frame, { targetSize: EXPORT_SIZE });
          this.exportFrames++;
          const secs = Math.floor((Date.now() - started) / 1000);
          this.ui.exportStatus.textContent = `Recording… ${secs}s, ${this.exportFrames} frames. Keep this tab visible.`;
        } catch {
          if (!this.exportRecorder) return; // stopped while awaiting: onstop reports
          this.ui.exportStatus.textContent = 'Recording stream stalled.';
          return;
        }
        this.exportTimer = window.setTimeout(() => {
          void step();
        }, 1000 / EXPORT_FPS);
      };
      void step();
    } catch (err) {
      this.ui.exportStatus.textContent = `Could not start recording: ${err instanceof Error ? err.message : 'unknown error'}`;
      this.exportRecorder = null;
    }
  }

  private stopExport(): void {
    window.clearTimeout(this.exportTimer);
    if (this.exportRecorder && this.exportRecorder.state !== 'inactive') {
      this.exportRecorder.stop();
    } else {
      this.exportRecorder = null;
    }
    this.exportStream = null;
    this.ui.exportStop.disabled = true;
    if (this.info) this.ui.exportBtn.disabled = false;
  }

  private finishExport(): void {
    const mime = this.exportMime ?? 'video/webm';
    const blob = new Blob(this.exportChunks, { type: mime });
    this.exportChunks = [];
    this.exportRecorder = null;
    this.exportStream = null;
    this.ui.exportStop.disabled = true;
    if (this.info) this.ui.exportBtn.disabled = false;
    if (this.exportUrl) URL.revokeObjectURL(this.exportUrl);
    this.exportUrl = URL.createObjectURL(blob);
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const link = this.ui.exportDownload;
    link.href = this.exportUrl;
    link.download = `arkqr-stream.${ext}`;
    link.hidden = false;
    link.textContent = `Download recording (${formatBytes(blob.size)})`;
    this.ui.exportStatus.textContent =
      'Recording ready. Limitation: video compression can blur QR modules — play fullscreen at native resolution, and prefer the live screen whenever possible.';
  }
}

export type { PreparedTransfer };
