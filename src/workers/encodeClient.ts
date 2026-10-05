// Main-thread client for the encode worker: file prep + a shared prefetch
// pool + per-consumer streams that interleave the metadata frame every N
// data frames (always first; metadata-only for empty files).

import { METADATA_REPEAT_EVERY } from '../core/constants.js';
import type {
  FramesMessage,
  MainToWorker,
  ReadyMessage,
  WorkerError,
  WorkerToMain,
} from './encode.worker.js';

export interface TransferInfo {
  metaFrame: Uint8Array;
  fileName: string;
  mime: string;
  originalSize: number;
  compressedSize: number;
  compressed: boolean;
  blockSize: number;
  blockCount: number;
}

const BATCH = 24;
const POOL_HIGH_WATER = 48;

export class EncodeClient {
  private readonly worker: Worker;
  private jobId = 0;
  private reqSeq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (m: FramesMessage) => void; reject: (e: Error) => void }
  >();
  private readyHandler: ((m: ReadyMessage) => void) | null = null;
  private errorHandler: ((m: WorkerError) => void) | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor() {
    this.worker = new Worker(new URL('./encode.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (ev: MessageEvent<WorkerToMain>) => {
      const msg = ev.data;
      if (msg.kind === 'frames') {
        const p = this.pending.get(msg.req);
        this.pending.delete(msg.req);
        p?.resolve(msg);
      } else if (msg.kind === 'ready') {
        this.readyHandler?.(msg);
        this.readyHandler = null;
      } else if (msg.kind === 'error') {
        if (msg.req >= 0) {
          const p = this.pending.get(msg.req);
          this.pending.delete(msg.req);
          p?.reject(new Error(msg.message));
        } else {
          this.errorHandler?.(msg);
          this.errorHandler = null;
        }
      }
    };
    this.worker.onerror = (ev: ErrorEvent): void => {
      const err = new Error(`encode worker failed: ${ev.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.errorHandler?.({
        kind: 'error',
        jobId: this.jobId,
        req: -1,
        message: err.message,
      });
      this.errorHandler = null;
    };
  }

  /** Copy `input` into the worker and run compress/hash/chunk there. */
  init(
    input: Uint8Array,
    fileName: string,
    mime: string,
    blockSize: number,
  ): Promise<TransferInfo> {
    this.jobId++;
    const jobId = this.jobId;
    const copy = input.slice();
    return new Promise<TransferInfo>((resolve, reject) => {
      this.readyHandler = (m: ReadyMessage): void => {
        if (m.jobId !== jobId) return;
        resolve({
          metaFrame: new Uint8Array(m.metaFrame),
          fileName: m.fileName,
          mime: m.mime,
          originalSize: m.originalSize,
          compressedSize: m.compressedSize,
          compressed: m.compressed,
          blockSize: m.blockSize,
          blockCount: m.blockCount,
        });
      };
      this.errorHandler = (m: WorkerError): void => {
        if (m.jobId === jobId) reject(new Error(m.message));
      };
      const msg: MainToWorker = {
        kind: 'init',
        jobId,
        bytes: copy.buffer,
        fileName,
        mime,
        blockSize,
      };
      this.worker.postMessage(msg, [copy.buffer]);
    });
  }

  /** Serialized frame request: worker + postMessage stay strictly ordered. */
  requestFrames(count: number): Promise<{ frames: Uint8Array[]; seeds: number[] }> {
    const run = this.chain.then(() => this.doRequest(count));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private doRequest(count: number): Promise<{ frames: Uint8Array[]; seeds: number[] }> {
    const req = this.reqSeq++;
    const jobId = this.jobId;
    return new Promise((resolve, reject) => {
      this.pending.set(req, {
        resolve: (m: FramesMessage) => {
          resolve({ frames: m.frames.map((b) => new Uint8Array(b)), seeds: m.seeds });
        },
        reject,
      });
      const msg: MainToWorker = { kind: 'next', jobId, req, count };
      this.worker.postMessage(msg);
    });
  }

  createStream(info: TransferInfo): FrameStream {
    return new FrameStream(this, info.metaFrame, info.blockCount);
  }

  terminate(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}

/** One consumer of the endless stream (display loop, video export, ...). */
export class FrameStream {
  private readonly pool: Uint8Array[] = [];
  private refill: Promise<void> | null = null;
  private dataSinceMeta = 0;
  private first = true;

  constructor(
    private readonly client: EncodeClient,
    private readonly metaFrame: Uint8Array,
    private readonly blockCount: number,
  ) {}

  async next(): Promise<Uint8Array> {
    if (
      this.first ||
      (this.blockCount > 0 && this.dataSinceMeta >= METADATA_REPEAT_EVERY)
    ) {
      this.first = false;
      this.dataSinceMeta = 0;
      void this.topUp();
      return this.metaFrame;
    }
    if (this.blockCount === 0) return this.metaFrame;
    if (this.pool.length === 0) await this.topUp();
    const frame = this.pool.shift();
    if (!frame) throw new Error('encode stream stalled');
    this.dataSinceMeta++;
    void this.topUp();
    return frame;
  }

  private topUp(): Promise<void> {
    if (this.refill) return this.refill;
    if (this.pool.length >= POOL_HIGH_WATER) return Promise.resolve();
    this.refill = this.client
      .requestFrames(BATCH)
      .then(({ frames }) => {
        this.pool.push(...frames);
      })
      .finally(() => {
        this.refill = null;
      });
    return this.refill;
  }
}
