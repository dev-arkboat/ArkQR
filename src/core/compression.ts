// gzip via the CompressionStream API, used ONLY when it shrinks the data
// (flag in the metadata frame). Graceful fallback: identity when the API
// is missing (older browsers), so transfers still work, just uncompressed.

export function compressionSupported(): boolean {
  return (
    typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
  );
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** gzip-compress; throws if the CompressionStream API is unavailable. */
export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  if (!compressionSupported()) throw new Error('CompressionStream unavailable');
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return streamToBytes(stream);
}

/** gzip-decompress; throws if the API is unavailable or data is corrupt. */
export async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  if (!compressionSupported()) throw new Error('DecompressionStream unavailable');
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return streamToBytes(stream);
}

/**
 * Compress with gzip only if the result is strictly smaller.
 * Identity (compressed=false) when unsupported or not beneficial.
 */
export async function compressIfBeneficial(
  data: Uint8Array,
): Promise<{ bytes: Uint8Array; compressed: boolean }> {
  if (!compressionSupported()) return { bytes: data, compressed: false };
  try {
    const gz = await gzipCompress(data);
    if (gz.length < data.length) return { bytes: gz, compressed: true };
  } catch {
    // Fall through to identity: never break a transfer over compression.
  }
  return { bytes: data, compressed: false };
}
