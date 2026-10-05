// SHA-256 over the ORIGINAL file bytes (pre-compression), via SubtleCrypto.
// The receiver recomputes it after reconstruction + decompression and only
// offers the download on an exact match.

/** Raw 32-byte SHA-256 digest. */
export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(digest);
}

/** Lowercase hex encoding of bytes (for display / test comparison). */
export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
