// IEEE CRC32 (polynomial 0xEDB88320), matching Ethernet / zip / PNG.
// Used as the per-frame integrity trailer: receivers silently drop frames
// whose CRC does not match, so RF/optical noise never corrupts a transfer.

const TABLE = new Uint32Array(256);

function buildTable(): void {
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    TABLE[n] = c >>> 0;
  }
}

buildTable();

/** CRC32 of `data`, returned as an unsigned 32-bit integer. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = TABLE[((crc ^ data[i]) >>> 0) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
