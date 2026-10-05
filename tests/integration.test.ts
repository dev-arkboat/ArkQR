// End-to-end, no camera: bytes -> frame -> QR pixels -> jsQR -> frame ->
// fountain decode -> file. Proves the wire format survives real QR
// encode/decode with raw binary payloads (all byte values 0..255).

import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import {
  encodeToMatrix,
  bytesToLatin1,
  latin1ToBytes,
  matrixToPixels,
} from '../src/qr/matrix.js';
import {
  decodeFrame,
  encodeDataFrame,
  encodeMetadataFrame,
  type MetadataPayload,
} from '../src/core/framing.js';
import { DENSITY_PRESETS, joinBlocks, prepareTransfer } from '../src/core/protocol.js';
import { LtDecoder, encodeBlock } from '../src/core/lt.js';
import { gzipDecompress } from '../src/core/compression.js';
import { bytesToHex, sha256Bytes } from '../src/core/hash.js';
import { mulberry32 } from '../src/core/prng.js';
import { pseudoRandomBytes } from './util.js';

/** Render frame bytes to pixels and read them back with jsQR. */
function qrRoundTrip(frame: Uint8Array): Uint8Array {
  const matrix = encodeToMatrix(frame);
  const { width, height, data } = matrixToPixels(matrix, 4);
  const found = jsQR(data, width, height);
  expect(found).not.toBeNull();
  if (!found) throw new Error('jsQR missed a clean render');
  // binaryData carries the raw byte-mode bytes verbatim.
  return Uint8Array.from(found.binaryData);
}

describe('QR byte fidelity', () => {
  it('carries all 256 byte values through a data frame', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const frame = encodeDataFrame(new Uint8Array([5, 6, 7, 8]), 123, all);
    const back = qrRoundTrip(frame);
    expect(back).toEqual(frame);
    // jsQR's text field cannot carry arbitrary binary (it attempts text
    // decoding), which is exactly why ArkQR uses `binaryData` + CRC framing.
    // The latin-1 helpers themselves are lossless:
    expect(latin1ToBytes(bytesToLatin1(frame))).toEqual(frame);
  });

  it('carries a Max-density (1400 B) frame through QR', () => {
    const payload = pseudoRandomBytes(DENSITY_PRESETS.max.blockSize, 55);
    const frame = encodeDataFrame(new Uint8Array([1, 2, 3, 4]), 77, payload);
    const matrix = encodeToMatrix(frame);
    // Must fit well inside QR limits (version 40 = 177 modules).
    expect(matrix.size).toBeLessThanOrEqual(177);
    console.info(
      `Max frame: ${frame.length} bytes -> ${matrix.size}x${matrix.size} modules`,
    );
    const back = qrRoundTrip(frame);
    expect(back).toEqual(frame);
  });

  it('carries an Ultra-density (2000 B) frame through QR', () => {
    const payload = pseudoRandomBytes(DENSITY_PRESETS.ultra.blockSize, 56);
    const frame = encodeDataFrame(new Uint8Array([1, 2, 3, 4]), 78, payload);
    const matrix = encodeToMatrix(frame);
    expect(matrix.size).toBeLessThanOrEqual(177);
    console.info(
      `Ultra frame: ${frame.length} bytes -> ${matrix.size}x${matrix.size} modules`,
    );
    const back = qrRoundTrip(frame);
    expect(back).toEqual(frame);
  });

  it('level L packs the same bytes into a smaller symbol that still decodes', () => {
    const payload = pseudoRandomBytes(DENSITY_PRESETS.max.blockSize, 57);
    const frame = encodeDataFrame(new Uint8Array([1, 2, 3, 4]), 79, payload);
    const mLevel = encodeToMatrix(frame, 'M');
    const lLevel = encodeToMatrix(frame, 'L');
    expect(lLevel.size).toBeLessThan(mLevel.size);
    console.info(
      `Max frame versions: M=${mLevel.size} modules, L=${lLevel.size} modules`,
    );
    const { width, height, data } = matrixToPixels(lLevel, 3);
    const found = jsQR(data, width, height);
    expect(found).not.toBeNull();
    expect(Uint8Array.from(found?.binaryData ?? [])).toEqual(frame);
  });

  it('metadata frame survives QR round-trip', () => {
    const meta: MetadataPayload = {
      sessionId: new Uint8Array([10, 20, 30, 40]),
      fileName: 'résumé — 报告.pdf',
      mime: 'application/pdf',
      originalSize: 4242,
      compressedSize: 4000,
      compressed: false,
      blockSize: 512,
      blockCount: 8,
      sha256: pseudoRandomBytes(32, 3),
    };
    const back = qrRoundTrip(encodeMetadataFrame(meta));
    const res = decodeFrame(back);
    expect(res.ok).toBe(true);
  });
});

describe('full pipeline: file -> frames -> QR -> jsQR -> file', () => {
  it('reconstructs a 5 KB file with hash match (paced like a receiver)', async () => {
    const original = pseudoRandomBytes(5 * 1024, 2024);
    const prepared = await prepareTransfer(original, {
      fileName: 'notes.bin',
      mime: 'application/octet-stream',
      blockSize: 256,
    });

    // Metadata arrives through a real QR scan first.
    const metaBytes = qrRoundTrip(prepared.metaFrame);
    const metaRes = decodeFrame(metaBytes);
    expect(metaRes.ok).toBe(true);
    if (!metaRes.ok || metaRes.frame.kind !== 'metadata') return expect.unreachable();
    const meta = metaRes.frame.meta;
    expect(meta.fileName).toBe('notes.bin');
    expect(meta.blockCount).toBe(prepared.meta.blockCount);

    // Stream data frames through QR + jsQR with loss + duplication.
    const rng = mulberry32(777);
    const decoder = new LtDecoder(meta.blockCount, meta.blockSize);
    let scanned = 0;
    let seed = 1;
    let recovered: Uint8Array[] | null = null;
    while (recovered === null && seed < meta.blockCount * 20) {
      const payload = encodeBlock(prepared.blocks, seed, meta.blockSize);
      const frame = encodeDataFrame(prepared.sessionId, seed, payload);
      seed++;
      if (rng() < 0.35) continue; // dropped frame (camera missed it)
      const bytes = qrRoundTrip(frame);
      const res = decodeFrame(bytes);
      expect(res.ok).toBe(true);
      if (!res.ok || res.frame.kind !== 'data') continue;
      decoder.addFrame(res.frame.data.seed, res.frame.data.payload);
      scanned++;
      if (rng() < 0.2) {
        // duplicate scan of the same QR
        decoder.addFrame(res.frame.data.seed, res.frame.data.payload);
        scanned++;
      }
      if (scanned % 8 === 0) recovered = decoder.decode();
    }
    recovered ??= decoder.decode();
    expect(recovered).not.toBeNull();

    const payloadBytes = joinBlocks(recovered ?? [], meta.compressedSize);
    const fileBytes = meta.compressed ? await gzipDecompress(payloadBytes) : payloadBytes;
    expect(fileBytes).toEqual(original);
    expect(bytesToHex(await sha256Bytes(fileBytes))).toBe(bytesToHex(meta.sha256));
  });
});
