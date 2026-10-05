# ArkQR — files over QR, no network

ArkQR sends a file from one device to another with **no network connection
between them**. The sender shows a continuous stream of animated QR codes;
the receiver scans them with its camera and rebuilds the file. Two modes:
**SEND** and **RECEIVE**. Static site, fully client-side, works offline
after the first load.

## How it works

1. **Prepare (SEND, in a Web Worker):** the file is gzip-compressed with
   `CompressionStream` _only if smaller_ (flag in metadata), SHA-256-hashed
   (of the **original** file), split into fixed-size source blocks, and
   framed per `PROTOCOL.md`.
2. **Fountain stream:** an LT code (robust soliton distribution,
   `c = 0.1`, `δ = 0.05`) turns the blocks into an _endless_ sequence of
   encoded frames. Each frame's neighbor set is derived deterministically
   from a seed in its header via mulberry32 — identical on both sides.
   The sender loops forever at 1–30 fps (default 8) with `requestAnimationFrame`
   timing; the metadata frame repeats every 10 data frames so receivers can
   join mid-stream.
3. **Scan (RECEIVE):** camera frames are decoded with the native
   `BarcodeDetector` when available, else `jsQR` in a Web Worker (auto-switch
   if native detections never validate — native APIs surface text, which
   cannot losslessly carry binary frames). Decoding runs off the main thread;
   frames are skipped, never queued, when behind.
4. **Reconstruct:** a peeling (belief-propagation) decoder with a
   Gauss-Jordan fallback reassembles the blocks from _any sufficient subset_
   in _any order_ — missed, shuffled and duplicate frames are all fine.
   CRC32 failures are silently dropped. On completion the receiver verifies
   SHA-256 and only then offers the download with the original name/MIME.

## Protocol summary

Binary big-endian frames: `magic(2)=0x4151 | version(1) | type(1) |
sessionId(4)` + metadata (`u16 fileName + UTF-8`, `u16 mime + UTF-8`,
`u32 originalSize`, `u32 compressedSize`, `u8 gzipFlag`, `u16 blockSize`,
`u32 blockCount`, `sha256(32)`) or data (`u32 seed`, `blockSize` payload) +
`u32 CRC32`. One binary byte-mode QR symbol per frame, EC level M,
auto version. Full spec: [`PROTOCOL.md`](./PROTOCOL.md).

## Honest speed expectations

Goodput ≈ `blockSize × fps / overhead`. Realistic measured range is
**~5–30 KB/s** depending on preset, fps, camera focus speed and how steady
your hands are. Examples at the 10 fps default: Reliable (256 B) ≈ 2.1 KB/s
→ 1 MB ≈ 8 min; Balanced (512 B, default) ≈ 4.3 KB/s → 1 MB ≈ 4 min; Fast
(800 B) ≈ 6.7 KB/s → 1 MB ≈ 2.5 min. Switch Screen layout to **Quad** for
roughly 4× that (four frames per refresh at close range — e.g. Balanced Quad
≈ 17 KB/s → 1 MB ≈ 1 min, 500 KB well under a minute). The RECEIVE tab shows a live intake
rate — below ~2 frames/s, raise sender Speed, switch to Fast density, or move
closer. This is a sneakernet for keys, documents and photos — not movies.

## Tips for reliable scanning

- Max brightness on the sender; dark room beats backlight.
- Fill ~50–70% of the receiver viewfinder with the QR; hold both devices
  steady (prop them up for large files).
- Start with **Reliable** density; move to Fast only at short distance.
- If the receiver stalls, slow the sender fps — fewer motion-blurred frames
  beat more blurry ones.
- The transfer survives starting mid-stream and briefly covering the camera.

## Browser support

- Desktop Chrome / Firefox / Safari (current): full support.
- Android Chrome (current): full support, rear camera + continuous autofocus
  where available.
- iOS Safari (current): supported via jsQR fallback (no native detector);
  camera requires **HTTPS or localhost** (a platform rule, not an app rule).
- Graceful degradation: capability checklist on the RECEIVE tab; friendly
  errors for denied/blocked cameras, missing workers, oversized files,
  session changes and hash mismatches.

## Known limitations

- **Video export** (`MediaRecorder` + `canvas.captureStream`, fixed ~12 Mbps,
  1024 px QR, 4 fps, WebM/MP4): video compression can blur QR modules, so a
  recording may scan worse than the live screen. Play fullscreen at native
  resolution from a good-quality source.
- No encryption (see extension point below). Anyone who can see/record the
  screen can receive the file — treat the display like a speakerphone.
- Density/fps changes restart the stream under a new session id; receivers
  must press **Reset**.

## Privacy

**Nothing leaves your devices.** No backend, no uploads, no analytics, no
accounts. Files are read locally, encoded locally, and scanned optically.
The service worker only caches the app shell for offline use. Received
content is treated as untrusted: lengths are validated before allocation
(32 MB / 16384-block caps), filenames are sanitized, content is never
executed or rendered — only offered as a download.

## Dependencies (justified)

| Package                                                         | Why                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `qrcode-generator`                                              | QR **encoding**: zero-dep, true byte-mode (raw bytes preserved), auto version, works in workers/Node.                                 |
| `jsqr`                                                          | QR **decoding** fallback + integration tests: pure JS, worker/Node-safe, exposes raw `binaryData`.                                    |
| `vite`, `typescript`, `vitest`, `eslint`, `prettier` (dev only) | Build, strict types, tests, lint, format. No UI framework — vanilla TS, tiny offline bundle.                                          |
| `@vitejs/plugin-basic-ssl` (dev only)                           | Self-signed HTTPS for `npm run dev:https` so phone cameras work in LAN testing (browsers gate `getUserMedia` behind secure contexts). |

## Develop

```sh
npm ci
npm run dev        # local dev (use https/localhost for camera)
npm run dev:https   # self-signed HTTPS on LAN, for phone camera testing
npm run test       # vitest: CRC/PRNG/framing/LT + loss sims + QR integration
npm run lint       # eslint (strict typed)
npm run format     # prettier check
npm run typecheck  # tsc --noEmit
npm run build      # static production build in dist/
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → tests → build.

## Deploy

The build is a static site with relative paths (`base: './'`), so it works
from any sub-path. Full production guide (GitHub Pages, Netlify, Vercel,
Cloudflare Pages, nginx/Caddy/Apache, custom domains, cache headers,
post-deploy verification): [`DEPLOY.md`](./DEPLOY.md).

Quick start (GitHub Pages):

```sh
npm run build
# push dist/ to the gh-pages branch, e.g.:
npx gh-pages -d dist
```

Then serve over **HTTPS** (Pages does this by default) so `getUserMedia`
works. For local camera testing use `npm run dev` (localhost is a secure
context), or `npm run dev:https` for self-signed HTTPS on your LAN so phones
can use their cameras. No camera at all? RECEIVE offers “Scan from photo”.

## Future: passphrase encryption (extension point)

Reserved for protocol v2: derive a key (PBKDF2/Argon2) from a passphrase,
AES-GCM the payload before chunking, add salt + nonce to the metadata
frame, and prompt for the passphrase on RECEIVE. No v1 wire change needed.
