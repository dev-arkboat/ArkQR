// Encode worker: owns file prep (compress + hash + chunk, the expensive
// one-off work) and generates endless LT data frames on demand, so the UI
// thread only ever paints QR matrices and never janks on large files.

import { cdfFor, encodeBlock } from '../core/lt.js';
import { encodeDataFrame } from '../core/framing.js';
import { randomUint32 } from '../core/prng.js';
import { prepareTransfer, type PreparedTransfer } from '../core/protocol.js';

export interface InitMessage {
  kind: 'init';
  jobId: number;
  bytes: ArrayBuffer;
  fileName: string;
  mime: string;
  blockSize: number;
}

export interface NextMessage {
  kind: 'next';
  jobId: number;
  req: number;
  count: number;
}

export type MainToWorker = InitMessage | NextMessage;

export interface ReadyMessage {
  kind: 'ready';
  jobId: number;
  metaFrame: ArrayBuffer;
  fileName: string;
  mime: string;
  originalSize: number;
  compressedSize: number;
  compressed: boolean;
  blockSize: number;
  blockCount: number;
}

export interface FramesMessage {
  kind: 'frames';
  jobId: number;
  req: number;
  frames: ArrayBuffer[];
  seeds: number[];
}

export interface WorkerError {
  kind: 'error';
  jobId: number;
  req: number;
  message: string;
}

export type WorkerToMain = ReadyMessage | FramesMessage | WorkerError;

interface Job {
  id: number;
  prepared: PreparedTransfer;
}

let job: Job | null = null;

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

self.onmessage = (ev: MessageEvent<MainToWorker>): void => {
  const msg = ev.data;
  if (msg.kind === 'init') {
    void handleInit(msg);
    return;
  }
  handleNext(msg);
};

async function handleInit(msg: InitMessage): Promise<void> {
  try {
    const prepared = await prepareTransfer(new Uint8Array(msg.bytes), {
      fileName: msg.fileName,
      mime: msg.mime,
      blockSize: msg.blockSize,
    });
    job = { id: msg.jobId, prepared };
    const metaCopy = prepared.metaFrame.slice();
    post(
      {
        kind: 'ready',
        jobId: msg.jobId,
        metaFrame: metaCopy.buffer,
        fileName: prepared.meta.fileName,
        mime: prepared.meta.mime,
        originalSize: prepared.meta.originalSize,
        compressedSize: prepared.meta.compressedSize,
        compressed: prepared.meta.compressed,
        blockSize: prepared.meta.blockSize,
        blockCount: prepared.meta.blockCount,
      },
      [metaCopy.buffer],
    );
  } catch (err) {
    post({
      kind: 'error',
      jobId: msg.jobId,
      req: -1,
      message: err instanceof Error ? err.message : 'prepare failed',
    });
  }
}

function handleNext(msg: NextMessage): void {
  try {
    if (!job || job.id !== msg.jobId) throw new Error('no active encode job');
    const count = Math.max(0, Math.min(200, Math.floor(msg.count)));
    const { prepared } = job;
    const frames: ArrayBuffer[] = [];
    const seeds: number[] = [];
    const transfer: Transferable[] = [];
    if (prepared.meta.blockCount > 0 && count > 0) {
      const cdf = cdfFor(prepared.meta.blockCount);
      for (let i = 0; i < count; i++) {
        const seed = randomUint32();
        const payload = encodeBlock(prepared.blocks, seed, prepared.meta.blockSize, cdf);
        const frame = encodeDataFrame(prepared.sessionId, seed, payload);
        // Copy into a fresh ArrayBuffer so ownership transfers cleanly.
        const buf = new ArrayBuffer(frame.byteLength);
        new Uint8Array(buf).set(frame);
        seeds.push(seed);
        frames.push(buf);
        transfer.push(buf);
      }
    }
    post({ kind: 'frames', jobId: msg.jobId, req: msg.req, frames, seeds }, transfer);
  } catch (err) {
    post({
      kind: 'error',
      jobId: msg.jobId,
      req: msg.req,
      message: err instanceof Error ? err.message : 'encode failed',
    });
  }
}
