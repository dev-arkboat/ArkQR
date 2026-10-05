// Lab color probe: sample pure emitted patches through the camera and judge
// whether received hues stay separable enough to carry data. Evidence tool,
// not a transfer path: tight clusters mean color could work here, smeared
// clusters mean physics says no — in this lighting, on these devices.

import {
  describeCameraError,
  insecureContextHint,
  isSecureContext,
} from '../camera/scanner.js';
import { judgeColor, PROBE_PALETTE, type RGB } from '../lab/color.js';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const SAMPLE_MIN = 3;
const READOUT_EVERY_MS = 200;

function rgbText(c: RGB): string {
  return `${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}`;
}

export class LabController {
  private stream: MediaStream | null = null;
  private rafId = 0;
  private running = false;
  private lastReadout = 0;
  private readonly samples = new Map<string, RGB[]>();
  private readonly ctx: CanvasRenderingContext2D | null;

  private readonly ui = {
    start: el<HTMLButtonElement>('lab-start'),
    stop: el<HTMLButtonElement>('lab-stop'),
    reset: el<HTMLButtonElement>('lab-reset'),
    capture: el<HTMLButtonElement>('lab-capture'),
    color: el<HTMLSelectElement>('lab-color'),
    video: el<HTMLVideoElement>('lab-video'),
    canvas: el<HTMLCanvasElement>('lab-canvas'),
    readout: el<HTMLElement>('lab-readout'),
    results: el<HTMLElement>('lab-results'),
    verdict: el<HTMLElement>('lab-verdict'),
    error: el<HTMLParagraphElement>('lab-error'),
  };

  constructor() {
    this.ctx = this.ui.canvas.getContext('2d', { willReadFrequently: true });
    for (const entry of PROBE_PALETTE) this.samples.set(entry.name, []);
  }

  init(): void {
    this.ui.start.addEventListener('click', () => {
      void this.start();
    });
    this.ui.stop.addEventListener('click', () => {
      this.stop();
    });
    this.ui.reset.addEventListener('click', () => {
      this.clearSamples();
    });
    this.ui.capture.addEventListener('click', () => {
      this.capture();
    });
    this.renderResults();
  }

  async start(): Promise<void> {
    this.hideError();
    if (!isSecureContext()) {
      this.showError(insecureContextHint());
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
      this.stream = stream;
      this.ui.video.srcObject = stream;
      await this.ui.video.play().catch(() => undefined);
      this.running = true;
      this.ui.start.disabled = true;
      this.ui.stop.disabled = false;
      this.ui.capture.disabled = false;
      this.ui.readout.textContent = 'Aiming… hold a patch to fill the frame center.';
      this.loop();
    } catch (err) {
      this.showError(describeCameraError(err));
    }
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.ui.video.srcObject) this.ui.video.srcObject = null;
    this.ui.start.disabled = false;
    this.ui.stop.disabled = true;
    this.ui.capture.disabled = true;
    this.ui.readout.textContent = 'Camera off.';
  }

  clearSamples(): void {
    for (const key of this.samples.keys()) this.samples.set(key, []);
    this.renderResults();
  }

  private capture(): void {
    if (!this.running) return;
    const color = this.ui.color.value;
    const list = this.samples.get(color);
    if (!list) return;
    const sample = this.sampleCenter();
    if (!sample) return;
    list.push(sample);
    this.renderResults();
  }

  /** Mean RGB of the frame center (what the patch fills when aimed). */
  private sampleCenter(): RGB | null {
    const video = this.ui.video;
    if (!this.ctx || video.readyState < 2 || video.videoWidth === 0) return null;
    const w = 320;
    const h = Math.max(2, Math.round((320 * video.videoHeight) / video.videoWidth));
    if (this.ui.canvas.width !== w || this.ui.canvas.height !== h) {
      this.ui.canvas.width = w;
      this.ui.canvas.height = h;
    }
    this.ctx.drawImage(video, 0, 0, w, h);
    const size = 24;
    const x0 = Math.floor(w / 2 - size / 2);
    const y0 = Math.floor(h / 2 - size / 2);
    const pixels = this.ctx.getImageData(x0, y0, size, size).data;
    let r = 0;
    let g = 0;
    let b = 0;
    const n = size * size;
    for (let i = 0; i < pixels.length; i += 4) {
      r += pixels[i];
      g += pixels[i + 1];
      b += pixels[i + 2];
    }
    return { r: r / n, g: g / n, b: b / n };
  }

  private readonly loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (now - this.lastReadout < READOUT_EVERY_MS) return;
    this.lastReadout = now;
    const sample = this.sampleCenter();
    this.ui.readout.textContent = sample
      ? `center now: rgb(${rgbText(sample)})`
      : 'No video frame yet.';
  };

  private renderResults(): void {
    const body = this.ui.results;
    body.innerHTML = '';
    let judged = 0;
    let failed: string[] = [];
    for (const entry of PROBE_PALETTE) {
      const list = this.samples.get(entry.name) ?? [];
      const row = document.createElement('tr');
      const verdict = list.length >= SAMPLE_MIN ? judgeColor(entry.name, list) : null;
      if (verdict) {
        judged++;
        if (!verdict.pass) failed = [...failed, entry.name];
      }
      const cells: [string, string][] = [
        [entry.name, ''],
        [String(list.length), 'mono'],
        [verdict ? rgbText(verdict.mean) : '—', 'mono'],
        [verdict ? verdict.classifiedAs : '—', ''],
        [verdict ? verdict.worstMargin.toFixed(0) : '—', 'mono'],
        [
          !verdict ? '—' : verdict.pass ? 'PASS' : 'FAIL',
          verdict?.pass ? 'pass' : 'fail',
        ],
      ];
      for (const [text, cls] of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        row.appendChild(td);
      }
      if (verdict && !verdict.pass) row.title = verdict.reason;
      body.appendChild(row);
    }
    if (judged === PROBE_PALETTE.length && failed.length === 0) {
      this.ui.verdict.textContent =
        'All five hues separable with margin — color could carry data in this lighting, on these devices.';
    } else if (failed.length > 0) {
      this.ui.verdict.textContent = `Not separable here: ${failed.join(', ')} smear${
        failed.length === 1 ? 's' : ''
      } into other hues. Color cannot safely carry data in this lighting.`;
    } else {
      this.ui.verdict.textContent = `Capture ${SAMPLE_MIN}+ samples per patch (aim, steady, capture) for a verdict.`;
    }
  }

  private showError(text: string): void {
    this.ui.error.textContent = text;
    this.ui.error.hidden = false;
  }

  private hideError(): void {
    this.ui.error.hidden = true;
  }
}
