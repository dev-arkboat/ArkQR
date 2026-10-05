// Zero-dependency PNG icon generator (runs on plain Node): renders the ArkQR
// QR-motif mark at 192px and 512px and writes public/icon-{192,512}.png.
// Usage: npm run gen-icons
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

function crc32Bytes(bytes) {
  let table = crc32Bytes.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32Bytes.table = table;
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32Bytes(body));
  return Buffer.concat([len, body, crc]);
}

function roundedRect(px, w, x0, y0, wdt, hgt, color) {
  for (let y = y0; y < y0 + hgt; y++) {
    for (let x = x0; x < x0 + wdt; x++) {
      px[(y * w + x) * 4] = color[0];
      px[(y * w + x) * 4 + 1] = color[1];
      px[(y * w + x) * 4 + 2] = color[2];
      px[(y * w + x) * 4 + 3] = 255;
    }
  }
}

function render(size) {
  const bg = [11, 16, 32];
  const white = [255, 255, 255];
  const accent = [91, 140, 255];
  const px = new Uint8Array(size * size * 4);
  roundedRect(px, size, 0, 0, size, size, bg);
  const u = (v) => Math.round((v / 512) * size);
  const finder = (fx, fy) => {
    roundedRect(px, size, u(fx), u(fy), u(128), u(128), white);
    roundedRect(px, size, u(fx + 32), u(fy + 32), u(64), u(64), bg);
  };
  finder(96, 96);
  finder(288, 96);
  finder(96, 288);
  roundedRect(px, size, u(288), u(288), u(56), u(56), accent);
  roundedRect(px, size, u(360), u(288), u(56), u(56), white);
  roundedRect(px, size, u(288), u(360), u(56), u(56), white);
  roundedRect(px, size, u(360), u(360), u(56), u(56), accent);

  const raw = Buffer.alloc((1 + size * 4) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    Buffer.from(px.slice(y * size * 4, (y + 1) * size * 4)).copy(
      raw,
      y * (1 + size * 4) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

for (const size of [192, 512]) {
  const out = join(root, `icon-${size}.png`);
  writeFileSync(out, render(size));
  console.log(`wrote ${out}`);
}
