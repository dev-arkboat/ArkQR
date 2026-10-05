// High-level transfer preparation shared by the SEND UI and the encode
// worker: validate -> optionally compress -> hash -> chunk -> metadata frame.

import { MAX_FILE_BYTES } from './constants.js';
import { compressIfBeneficial } from './compression.js';
import { encodeMetadataFrame, type MetadataPayload } from './framing.js';
import { sha256Bytes } from './hash.js';
import { randomSessionId } from './prng.js';
import { sanitizeFileName } from './sanitize.js';

export const DENSITY_PRESETS = {
  reliable: { blockSize: 256, label: 'Reliable' },
  balanced: { blockSize: 512, label: 'Balanced' },
  fast: { blockSize: 800, label: 'Fast' },
  max: { blockSize: 1400, label: 'Max' },
} as const;

export type DensityPreset = keyof typeof DENSITY_PRESETS;

export interface PreparedTransfer {
  meta: MetadataPayload;
  metaFrame: Uint8Array;
  /** Bytes actually transmitted (compressed or original). */
  payload: Uint8Array;
  /** Source blocks, each exactly blockSize bytes (last zero-padded). */
  blocks: Uint8Array[];
  sessionId: Uint8Array;
}

/** Split into fixed-size blocks, zero-padding the last one. */
export function splitBlocks(data: Uint8Array, blockSize: number): Uint8Array[] {
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new Error(`invalid blockSize ${blockSize}`);
  }
  const count = Math.ceil(data.length / blockSize);
  const blocks: Uint8Array[] = new Array<Uint8Array>(count);
  for (let i = 0; i < count; i++) {
    const b = new Uint8Array(blockSize);
    b.set(data.subarray(i * blockSize, (i + 1) * blockSize), 0);
    blocks[i] = b;
  }
  return blocks;
}

/** Join source blocks and trim zero padding to the true payload length. */
export function joinBlocks(
  blocks: readonly Uint8Array[],
  payloadLength: number,
): Uint8Array {
  const out = new Uint8Array(payloadLength);
  let o = 0;
  for (const b of blocks) {
    const n = Math.min(b.length, payloadLength - o);
    if (n <= 0) break;
    out.set(b.subarray(0, n), o);
    o += n;
  }
  return out;
}

export interface PrepareOptions {
  fileName: string;
  mime: string;
  blockSize: number;
  /** Override for tests; defaults to fresh random bytes. */
  sessionId?: Uint8Array;
}

/** Validate, compress-if-smaller, hash, chunk, and frame the metadata. */
export async function prepareTransfer(
  input: Uint8Array,
  options: PrepareOptions,
): Promise<PreparedTransfer> {
  if (!(input instanceof Uint8Array)) throw new Error('input must be bytes');
  if (input.length > MAX_FILE_BYTES) {
    throw new Error(`file too large: ${input.length} > ${MAX_FILE_BYTES}`);
  }
  const { compressed, bytes } = await compressIfBeneficial(input);
  const digest = await sha256Bytes(input);
  const blockCount = Math.ceil(bytes.length / options.blockSize);
  const sessionId = options.sessionId ?? randomSessionId();
  const cleanName = sanitizeFileName(options.fileName);
  const meta: MetadataPayload = {
    sessionId,
    fileName: cleanName,
    mime: options.mime.slice(0, 128),
    originalSize: input.length,
    compressedSize: bytes.length,
    compressed,
    blockSize: options.blockSize,
    blockCount,
    sha256: digest,
  };
  const metaFrame = encodeMetadataFrame(meta);
  const blocks = splitBlocks(bytes, options.blockSize);
  return { meta, metaFrame, payload: bytes, blocks, sessionId };
}

/** Rough wall-clock estimate: K source blocks * overhead, at fps. */
export function estimateSeconds(
  blockCount: number,
  fps: number,
  overhead = 1.35,
): number {
  if (fps <= 0) return Number.POSITIVE_INFINITY;
  return (blockCount * overhead) / fps;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatEta(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return '—';
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `~${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `~${m}m` : `~${m}m ${rest}s`;
}
