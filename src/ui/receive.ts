// RECEIVE mode: camera -> scanner (native/jsQR) -> frame validation ->
// fountain decode -> decompress -> SHA-256 verify -> download.
// Receivers lock to the first session id and ignore foreign sessions.

import { MAX_FILE_BYTES } from '../core/constants.js';
import { decodeFrame, type MetadataPayload } from '../core/framing.js';
import { gzipDecompress } from '../core/compression.js';
import { bytesToHex, sha256Bytes } from '../core/hash.js';
import { LtDecoder } from '../core/lt.js';
import { formatEta, joinBlocks } from '../core/protocol.js';
import { sanitizeFileName } from '../core/sanitize.js';
import {
  CameraScanner,
  cameraSupported,
  decodeImageFiles,
  isSecureContext,
  nativeDetectorSupported,
  type DecoderMode,
  type DecoderSource,
} from '../camera/scanner.js';
import { notify } from './feedback.js';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const PENDING_CAP = 4096;
const DECODE_EVERY_MS = 400;
const DECODE_EVERY_FRAMES = 32;

interface PendingFrame {
  seed: number;
  payload: Uint8Array;
}

function sessionHex(id: Uint8Array): string {
  return [...id].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class ReceiveController {
  private scanner: CameraScanner | null = null;
  private meta: MetadataPayload | null = null;
  private decoder: LtDecoder | null = null;
  private lockedSession: Uint8Array | null = null;
  private pending: PendingFrame[] = [];
  private accepted = 0;
  private rejected = 0;
  private duplicates = 0;
  private foreign = 0;
  private acceptedSinceDecode = 0;
  private lastDecodeAt = 0;
  private firstFrameAt = 0;
  private done = false;
  private lastTip = '';
  private downloadUrl: string | null = null;

  private readonly ui = {
    support: el<HTMLUListElement>('rx-support'),
    decoderMode: el<HTMLSelectElement>('decoder-mode'),
    beep: el<HTMLInputElement>('rx-beep'),
    camStart: el<HTMLButtonElement>('cam-start'),
    camStop: el<HTMLButtonElement>('cam-stop'),
    reset: el<HTMLButtonElement>('rx-reset'),
    photoBtn: el<HTMLButtonElement>('photo-btn'),
    photoInput: el<HTMLInputElement>('photo-input'),
    photoStatus: el<HTMLParagraphElement>('rx-photo-status'),
    video: el<HTMLVideoElement>('rx-video'),
    canvas: el<HTMLCanvasElement>('rx-canvas'),
    standby: el<HTMLDivElement>('rx-standby'),
    corners: el<HTMLDivElement>('rx-corners'),
    strategy: el<HTMLParagraphElement>('rx-strategy'),
    fileName: el<HTMLElement>('rx-filename'),
    percent: el<HTMLElement>('rx-percent'),
    blocks: el<HTMLElement>('rx-blocks'),
    accepted: el<HTMLElement>('rx-accepted'),
    rejected: el<HTMLElement>('rx-rejected'),
    duplicates: el<HTMLElement>('rx-duplicates'),
    eta: el<HTMLElement>('rx-eta'),
    rate: el<HTMLElement>('rx-rate'),
    tip: el<HTMLParagraphElement>('rx-tip'),
    session: el<HTMLElement>('rx-session'),
    bar: el<HTMLDivElement>('rx-progress-bar'),
    warning: el<HTMLParagraphElement>('rx-warning'),
    error: el<HTMLParagraphElement>('rx-error'),
    done: el<HTMLDivElement>('rx-done'),
    hash: el<HTMLElement>('rx-hash'),
    download: el<HTMLAnchorElement>('rx-download'),
  };

  async init(): Promise<void> {
    await this.renderSupport();
    this.ui.camStart.addEventListener('click', () => {
      void this.start();
    });
    this.ui.camStop.addEventListener('click', () => {
      this.stop();
    });
    this.ui.reset.addEventListener('click', () => {
      this.reset();
    });
    this.ui.photoBtn.addEventListener('click', () => {
      this.ui.photoInput.click();
    });
    this.ui.photoInput.addEventListener('change', () => {
      void this.handlePhotos();
    });
    this.ui.decoderMode.addEventListener('change', () => {
      if (this.scanner) {
        void this.restartWithMode();
      }
    });
  }

  private async renderSupport(): Promise<void> {
    const items: [string, boolean][] = [
      ['Secure context — camera needs HTTPS or localhost', isSecureContext()],
      ['Camera API', cameraSupported()],
      ['Web Workers', typeof Worker === 'function'],
      ['SHA-256 (SubtleCrypto)', !!globalThis.crypto?.subtle],
      ['gzip (CompressionStream, optional)', typeof CompressionStream === 'function'],
      ['Native barcode detector (optional)', await nativeDetectorSupported()],
    ];
    this.ui.support.innerHTML = '';
    for (const [label, ok] of items) {
      const li = document.createElement('li');
      li.textContent = `${ok ? '✓' : '✗'} ${label}`;
      li.className = ok
        ? 'ok'
        : label.startsWith('Native') || label.startsWith('gzip')
          ? 'optional'
          : 'missing';
      this.ui.support.appendChild(li);
    }
  }

  private selectedMode(): DecoderMode {
    const v = this.ui.decoderMode.value;
    return v === 'native' || v === 'jsqr' ? v : 'auto';
  }

  private async restartWithMode(): Promise<void> {
    this.stop();
    await this.start();
  }

  async start(): Promise<void> {
    this.hideError();
    try {
      const scanner = new CameraScanner(
        this.ui.video,
        this.ui.canvas,
        {
          onBytes: (bytes, source) => this.handleBytes(bytes, source),
          onStrategy: (source, auto) => {
            this.ui.strategy.textContent =
              source === 'native'
                ? 'Decoder: native BarcodeDetector.'
                : auto
                  ? 'Decoder: jsQR (auto-switched: native detections never validated).'
                  : 'Decoder: jsQR worker.';
          },
          onError: (message) => {
            this.showError(message);
          },
        },
        this.selectedMode(),
      );
      await scanner.start();
      this.scanner = scanner;
      this.ui.camStart.disabled = true;
      this.ui.camStop.disabled = false;
      this.ui.standby.hidden = true;
      this.ui.corners.hidden = false;
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'Could not start the camera.');
    }
  }

  stop(): void {
    this.scanner?.stop();
    this.scanner = null;
    this.ui.camStart.disabled = false;
    this.ui.camStop.disabled = true;
    this.ui.strategy.textContent = '';
    this.ui.corners.hidden = true;
    this.ui.standby.hidden = false;
  }

  /** Still-photo fallback: decode QR frames from images, no camera needed. */
  private async handlePhotos(): Promise<void> {
    const input = this.ui.photoInput;
    const files = [...(input.files ?? [])].slice(0, 50);
    input.value = '';
    if (files.length === 0) return;
    this.hideError();
    this.ui.photoStatus.textContent = `Decoding ${files.length} photo(s)…`;
    this.ui.photoBtn.disabled = true;
    try {
      const frames = await decodeImageFiles(files);
      for (const bytes of frames) this.handleBytes(bytes, 'jsqr');
      if (frames.length === 0) {
        this.showError(
          'No QR code found in the selected photo(s). Get closer, keep the QR flat and glare-free, and try again.',
        );
        this.ui.photoStatus.textContent = '';
      } else {
        this.ui.photoStatus.textContent = `Photo scan: ${frames.length}/${files.length} image(s) held a QR frame. Load more photos of later frames to continue.`;
      }
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'Could not decode the photos.');
      this.ui.photoStatus.textContent = '';
    } finally {
      this.ui.photoBtn.disabled = false;
    }
  }

  reset(): void {
    this.meta = null;
    this.decoder = null;
    this.lockedSession = null;
    this.pending = [];
    this.accepted = 0;
    this.rejected = 0;
    this.duplicates = 0;
    this.foreign = 0;
    this.acceptedSinceDecode = 0;
    this.lastDecodeAt = 0;
    this.firstFrameAt = 0;
    this.done = false;
    if (this.downloadUrl) {
      URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = null;
    }
    this.ui.done.hidden = true;
    this.hideError();
    this.hideWarning();
    this.ui.photoStatus.textContent = '';
    this.ui.rate.textContent = '—';
    this.ui.tip.textContent = '';
    this.lastTip = '';
    this.renderProgress();
    this.ui.fileName.textContent = '—';
    this.ui.session.textContent = '—';
  }

  /** Returns true when the scanned QR validated (drives native->jsQR fallback). */
  private handleBytes(bytes: Uint8Array, _source: DecoderSource): boolean {
    if (this.done) return true;
    const res = decodeFrame(bytes);
    if (!res.ok) {
      this.rejected++;
      this.renderProgress();
      return false;
    }
    if (this.firstFrameAt === 0) this.firstFrameAt = performance.now();
    if (res.frame.kind === 'metadata') {
      return this.handleMetadata(res.frame.meta);
    }
    return this.handleData(
      res.frame.data.sessionId,
      res.frame.data.seed,
      res.frame.data.payload,
    );
  }

  private checkSession(sessionId: Uint8Array): boolean {
    if (!this.lockedSession) {
      this.lockedSession = sessionId.slice();
      this.ui.session.textContent = sessionHex(sessionId);
      return true;
    }
    if (bytesEqual(this.lockedSession, sessionId)) return true;
    this.foreign++;
    this.showWarning(
      `Ignoring frames from a different transfer (session ${sessionHex(sessionId)}). ` +
        `Press Reset to switch to it. (${this.foreign} ignored)`,
    );
    this.renderProgress();
    return false;
  }

  private handleMetadata(meta: MetadataPayload): boolean {
    if (!this.checkSession(meta.sessionId)) return true;
    if (this.meta) return true; // repeated metadata frame: already known
    if (meta.originalSize > MAX_FILE_BYTES || meta.compressedSize > MAX_FILE_BYTES) {
      this.rejected++;
      this.showError(
        `Sender declares ${meta.originalSize} bytes, above the ${MAX_FILE_BYTES} byte safety cap. Ignoring.`,
      );
      this.renderProgress();
      return true;
    }
    this.meta = meta;
    this.hideWarning();
    this.ui.fileName.textContent = sanitizeFileName(meta.fileName);
    notify('meta', this.ui.beep.checked);
    if (meta.blockCount === 0) {
      // Empty file: metadata alone completes the transfer.
      void this.finish([]);
      return true;
    }
    this.decoder = new LtDecoder(meta.blockCount, meta.blockSize);
    // Replay data frames that arrived before the metadata (late join order).
    for (const p of this.pending) this.addPayload(p.seed, p.payload);
    this.pending = [];
    this.renderProgress();
    void this.maybeDecode(true);
    return true;
  }

  private handleData(sessionId: Uint8Array, seed: number, payload: Uint8Array): boolean {
    if (!this.checkSession(sessionId)) return true;
    if (!this.meta || !this.decoder) {
      if (this.pending.length < PENDING_CAP)
        this.pending.push({ seed, payload: payload.slice() });
      return true;
    }
    if (payload.length !== this.meta.blockSize) {
      this.rejected++;
      this.renderProgress();
      return true;
    }
    this.addPayload(seed, payload);
    return true;
  }

  private addPayload(seed: number, payload: Uint8Array): void {
    if (!this.decoder || this.done) return;
    try {
      const status = this.decoder.addFrame(seed >>> 0, payload);
      if (status === 'stored') {
        this.accepted++;
        this.acceptedSinceDecode++;
      } else if (status === 'duplicate') {
        this.duplicates++;
      }
    } catch {
      this.rejected++;
    }
    this.renderProgress();
    void this.maybeDecode(false);
  }

  private async maybeDecode(force: boolean): Promise<void> {
    if (!this.decoder || !this.meta || this.done) return;
    const now = performance.now();
    if (
      !force &&
      now - this.lastDecodeAt < DECODE_EVERY_MS &&
      this.acceptedSinceDecode < DECODE_EVERY_FRAMES
    ) {
      return;
    }
    this.lastDecodeAt = now;
    this.acceptedSinceDecode = 0;
    const blocks = this.decoder.decode();
    this.renderProgress();
    if (blocks) await this.finish(blocks);
  }

  private async finish(blocks: Uint8Array[]): Promise<void> {
    if (!this.meta || this.done) return;
    this.done = true;
    const meta = this.meta;
    try {
      const payload = joinBlocks(blocks, meta.compressedSize);
      const fileBytes = meta.compressed ? await gzipDecompress(payload) : payload;
      if (fileBytes.length !== meta.originalSize) {
        throw new Error(
          `size mismatch after reconstruction (${fileBytes.length} != ${meta.originalSize})`,
        );
      }
      const digest = await sha256Bytes(fileBytes);
      if (!bytesEqual(digest, meta.sha256)) {
        this.done = false; // keep collecting; user may also reset
        this.showError(
          'SHA-256 mismatch: the reconstructed file does not match the sender checksum. ' +
            'Keep the camera steady to collect more frames, or press Reset and try again.',
        );
        notify('error', this.ui.beep.checked);
        return;
      }
      const name = sanitizeFileName(meta.fileName);
      const blob = new Blob([fileBytes as BlobPart], {
        type: meta.mime || 'application/octet-stream',
      });
      if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = URL.createObjectURL(blob);
      this.ui.download.href = this.downloadUrl;
      this.ui.download.download = name;
      this.ui.download.textContent = `Download ${name} (${fileBytes.length} bytes)`;
      this.ui.hash.textContent = `sha256 ${bytesToHex(digest).slice(0, 16)}…`;
      this.ui.done.hidden = false;
      this.renderProgress();
      notify('complete', this.ui.beep.checked);
      this.stop();
    } catch (err) {
      this.done = false;
      this.showError(err instanceof Error ? err.message : 'Reconstruction failed.');
      notify('error', this.ui.beep.checked);
    }
  }

  private renderProgress(): void {
    const total = this.meta?.blockCount ?? 0;
    const resolved = this.decoder?.progressBlocks ?? (this.meta && total === 0 ? 0 : 0);
    const pct = this.meta
      ? total === 0
        ? 100
        : Math.floor((resolved / total) * 100)
      : 0;
    this.ui.percent.textContent = `${pct}%`;
    this.ui.blocks.textContent = `(${resolved}/${this.meta ? total : '—'} blocks)`;
    this.ui.bar.style.width = `${pct}%`;
    this.ui.bar.setAttribute('aria-valuenow', String(pct));
    this.ui.accepted.textContent = String(this.accepted);
    this.ui.rejected.textContent = String(this.rejected);
    this.ui.duplicates.textContent = String(this.duplicates);
    this.ui.eta.textContent = this.estimateEta(resolved, total);
    this.renderRateAndTip();
  }

  /** Live intake rate plus one actionable tip when the transfer is slow. */
  private renderRateAndTip(): void {
    if (this.firstFrameAt === 0) {
      this.ui.rate.textContent = '—';
      return;
    }
    const elapsed = (performance.now() - this.firstFrameAt) / 1000;
    if (elapsed < 1) return;
    const fps = this.accepted / elapsed;
    const blockSize = this.meta?.blockSize ?? 0;
    this.ui.rate.textContent =
      blockSize > 0
        ? `${fps.toFixed(1)} f/s · ${((fps * blockSize) / 1024).toFixed(1)} KB/s`
        : `${fps.toFixed(1)} f/s`;

    const total = this.accepted + this.rejected + this.duplicates;
    let tip = '';
    if (elapsed > 5 && total > 10 && this.rejected / total > 0.2) {
      tip =
        'Many frames are failing checks — move closer, raise sender brightness, and hold both devices steady.';
    } else if (elapsed > 10 && this.accepted > 0 && fps < 2) {
      tip =
        'Slow intake — raise the sender Speed slider, switch density to Fast, or move closer so the QR fills the frame.';
    } else if (elapsed > 10 && this.accepted === 0) {
      tip =
        'No usable frames yet — is the sender screen showing the animated QR? Try “Scan from photo” with a screenshot to test the pipeline.';
    }
    if (tip !== this.lastTip) {
      this.lastTip = tip;
      this.ui.tip.textContent = tip;
    }
  }

  private estimateEta(resolved: number, total: number): string {
    if (!this.meta || total === 0 || resolved <= 0 || this.firstFrameAt === 0) return '—';
    if (resolved >= total) return '~0s';
    const elapsed = (performance.now() - this.firstFrameAt) / 1000;
    if (elapsed < 2) return '—';
    const rate = resolved / elapsed;
    if (rate <= 0.05) return '—';
    return formatEta((total - resolved) / rate);
  }

  private showWarning(text: string): void {
    this.ui.warning.textContent = text;
    this.ui.warning.hidden = false;
  }

  private hideWarning(): void {
    this.ui.warning.hidden = true;
  }

  private showError(text: string): void {
    this.ui.error.textContent = text;
    this.ui.error.hidden = false;
  }

  private hideError(): void {
    this.ui.error.hidden = true;
  }
}
