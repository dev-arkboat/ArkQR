import { describe, expect, it } from 'vitest';
import { gzipCompress, gzipDecompress, compressIfBeneficial } from '../src/core/compression.js';
import { compressibleBytes, pseudoRandomBytes } from './util.js';

describe('compression', () => {
  it('compresses redundant data (flag set upstream)', async () => {
    const data = compressibleBytes(100_000);
    const gz = await gzipCompress(data);
    expect(gz.length).toBeLessThan(data.length / 4);
    expect(await gzipDecompress(gz)).toEqual(data);
  });

  it('leaves incompressible data alone', async () => {
    const data = pseudoRandomBytes(20_000, 99);
    const { bytes, compressed } = await compressIfBeneficial(data);
    expect(compressed).toBe(false);
    expect(bytes).toEqual(data);
  });

  it('marks compressible data as compressed with exact round-trip', async () => {
    const data = compressibleBytes(50_000);
    const { bytes, compressed } = await compressIfBeneficial(data);
    expect(compressed).toBe(true);
    expect(await gzipDecompress(bytes)).toEqual(data);
  });
});
