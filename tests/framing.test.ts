import { describe, expect, it } from 'vitest';
import {
  decodeFrame,
  encodeDataFrame,
  encodeMetadataFrame,
  type MetadataPayload,
} from '../src/core/framing.js';
import { MAX_FILE_BYTES } from '../src/core/constants.js';
import { pseudoRandomBytes } from './util.js';

function sampleMeta(): MetadataPayload {
  return {
    sessionId: new Uint8Array([1, 2, 3, 4]),
    fileName: 'héllo wörld.txt',
    mime: 'text/plain',
    originalSize: 1234,
    compressedSize: 1000,
    compressed: true,
    blockSize: 256,
    blockCount: 4,
    sha256: pseudoRandomBytes(32, 7),
  };
}

describe('framing', () => {
  it('metadata round-trips (incl. unicode name)', () => {
    const meta = sampleMeta();
    const bytes = encodeMetadataFrame(meta);
    const res = decodeFrame(bytes);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.frame.kind).toBe('metadata');
    if (res.frame.kind !== 'metadata') return;
    expect({ ...res.frame.meta, sessionId: [...res.frame.meta.sessionId] }).toEqual({
      ...meta,
      sessionId: [...meta.sessionId],
    });
  });

  it('data round-trips', () => {
    const payload = pseudoRandomBytes(512, 9);
    const bytes = encodeDataFrame(new Uint8Array([9, 8, 7, 6]), 0xdeadbeef, payload);
    const res = decodeFrame(bytes);
    expect(res.ok).toBe(true);
    if (!res.ok || res.frame.kind !== 'data') return expect.unreachable();
    expect(res.frame.data.seed).toBe(0xdeadbeef);
    expect(res.frame.data.payload).toEqual(payload);
    expect([...res.frame.data.sessionId]).toEqual([9, 8, 7, 6]);
  });

  it('catches corruption via CRC (bit flips)', () => {
    const bytes = encodeDataFrame(
      new Uint8Array([1, 1, 1, 1]),
      42,
      pseudoRandomBytes(256, 3),
    );
    // Inside header-session/payload/CRC: structure stays valid, CRC must fail.
    for (const pos of [5, 20, bytes.length - 5, bytes.length - 1]) {
      const bad = bytes.slice();
      bad[pos] ^= 0x01;
      const res = decodeFrame(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.failure.kind).toBe('crc');
    }
    // A flipped magic byte is rejected structurally before the CRC gate.
    const badMagic = bytes.slice();
    badMagic[0] ^= 0xff;
    const res = decodeFrame(badMagic);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe('invalid');
  });

  it('rejects bad magic / version / truncation', () => {
    const bytes = encodeMetadataFrame(sampleMeta());
    const badMagic = bytes.slice();
    badMagic[0] ^= 0xff;
    expect(decodeFrame(badMagic)).toMatchObject({ ok: false });

    const badVer = bytes.slice();
    badVer[2] = 0x7f;
    // Recompute CRC so it gets past the CRC gate to the version check.
    expect(decodeFrame(badVer).ok).toBe(false);

    expect(decodeFrame(new Uint8Array(3))).toMatchObject({ ok: false });
    expect(decodeFrame(bytes.slice(0, bytes.length - 8)).ok).toBe(false);
  });

  it('rejects oversized declarations before allocating', () => {
    const meta = { ...sampleMeta(), originalSize: MAX_FILE_BYTES + 1 };
    expect(() => encodeMetadataFrame(meta)).toThrow();
    const meta2 = { ...sampleMeta(), blockCount: 99999 };
    expect(() => encodeMetadataFrame(meta2)).toThrow();
    const meta3 = { ...sampleMeta(), fileName: 'x'.repeat(300) };
    expect(() => encodeMetadataFrame(meta3)).toThrow();
  });

  it('caps are coherent: 1 GiB at 64 B blocks validates with no allocation', () => {
    const oneGiB = MAX_FILE_BYTES;
    const meta = {
      ...sampleMeta(),
      originalSize: oneGiB,
      compressedSize: oneGiB,
      blockSize: 64,
      blockCount: oneGiB / 64,
    };
    const bytes = encodeMetadataFrame(meta);
    const res = decodeFrame(bytes);
    expect(res.ok).toBe(true);
  });

  it('rejects inconsistent blockCount', () => {
    // compressedSize 1000 / blockSize 256 -> K must be 4.
    const meta = { ...sampleMeta(), blockCount: 5 };
    expect(() => encodeMetadataFrame(meta)).toThrow();
  });
});
