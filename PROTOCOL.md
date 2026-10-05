# ArkQR Protocol Specification (v1)

## 0. Build plan (process step 1)

### File structure

```
E:\ArkQR
├── index.html                  # App shell, CSP meta, manifest link, module entry
├── public/
│   ├── manifest.webmanifest    # PWA manifest
│   ├── sw.js                   # Hand-written offline service worker (runtime cache-first)
│   ├── icon.svg / icon-192.png / icon-512.png
├── src/
│   ├── main.ts                 # Boot, tab nav, SW registration
│   ├── styles.css              # Mobile-first, light/dark, reduced-motion
│   ├── core/                   # ZERO DOM dependencies, fully unit-tested
│   │   ├── constants.ts        # Magic, version, limits, presets
│   │   ├── crc32.ts            # IEEE CRC32
│   │   ├── prng.ts             # mulberry32 (+ crypto seed helper)
│   │   ├── soliton.ts          # Robust soliton distribution (Luby/Mitzenmacher)
│   │   ├── lt.ts               # LT encoder + peeling decoder + Gauss-Jordan fallback
│   │   ├── framing.ts          # Binary frame encode/decode + validation
│   │   ├── compression.ts      # CompressionStream gzip iff smaller
│   │   ├── hash.ts             # SHA-256 via SubtleCrypto
│   │   ├── sanitize.ts         # Untrusted filename sanitizer
│   │   └── protocol.ts         # prepareFile, splitBlocks, estimates, presets
│   ├── qr/
│   │   ├── matrix.ts           # Pure: bytes -> QR module matrix (no DOM)
│   │   └── paint.ts            # DOM: matrix -> <canvas> with quiet zone
│   ├── camera/
│   │   └── scanner.ts          # getUserMedia + native/jsQR strategies, skip-when-behind
│   ├── workers/
│   │   ├── encode.worker.ts    # File prep + endless LT frame generation
│   │   └── decode.worker.ts    # jsQR off-main-thread decode
│   ├── ui/
│   │   ├── app.ts              # Mode switching
│   │   ├── send.ts             # SEND mode controller
│   │   ├── receive.ts          # RECEIVE mode controller
│   │   ├── feedback.ts         # Beep + haptics
│   │   └── wake.ts             # Screen Wake Lock helper
│   └── types/
│       └── jsqr.d.ts           # Local types for jsqr (ships none)
├── tests/                      # Vitest: crc32, prng, framing, lt (+loss sims), integration
├── scripts/gen-icons.mjs       # Zero-dep PNG icon generator (node:zlib)
└── .github/workflows/ci.yml    # lint + typecheck + test + build
```

### Chosen libraries (with reasons — also repeated in README)

| Dependency                                                 | Reason                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qrcode-generator` (1.4.4)                                 | QR **encoding**: zero-dependency, true byte-mode, auto version select, tiny, works in workers/Node. Alternatives (`qrcode`, `uqr`) are larger or lack stable byte-mode APIs.                                                                                    |
| `jsqr` (1.4.0)                                             | QR **decoding** fallback + integration tests: pure JS (no WASM), runs in Web Worker and Node, returns raw byte values for byte-mode symbols. Native `BarcodeDetector` is preferred at runtime when it can carry binary; jsQR guarantees correctness everywhere. |
| `vite`, `typescript`, `vitest`, `eslint`, `prettier` (dev) | Build / strict type-check / unit tests / lint / format. No UI framework: vanilla TS keeps the bundle tiny, fully offline, and removes an entire class of supply-chain/CSP risk. No other runtime dependencies.                                                  |

### Build order

core protocol + tests → SEND → RECEIVE → PWA/offline → video export → polish.
Tests + `vite build` must pass after every stage before moving on.

---

## 1. Overview

ArkQR transfers a file from a sender screen to a receiver camera with no
network path between the devices. The sender loops an endless fountain-coded
stream of QR frames; the receiver collects any sufficient subset (any order,
with misses/duplicates) and reconstructs the file. A metadata frame repeated
every `METADATA_REPEAT_EVERY` (10) data frames lets late joiners start
mid-stream.

## 2. Preprocessing

1. Read file bytes `F` (length `origSize`).
2. Compress with `CompressionStream('gzip')` → `C`. If `C.length < F.length`,
   transmit `C` with `compFlag = 1`, else transmit `F` with `compFlag = 0`.
   (If the API is unavailable, send uncompressed with flag 0.)
3. `payload = compressed ? C : F`, `compSize = payload.length`.
4. `sha256 = SHA-256(F)` — computed over the **original** file, verified by the
   receiver after decompression.
5. `sessionId` = 4 cryptographically random bytes per transfer.
6. Split `payload` into `K = ceil(compSize / blockSize)` source blocks of
   exactly `blockSize` bytes; zero-pad the last block.

## 3. Fountain coding (LT codes, robust soliton distribution)

- PRNG: **mulberry32**, seeded with the 32-bit frame `seed` carried in every
  data frame header. Both sides implement the identical function, so the
  neighbor set is derived deterministically from the seed alone.
- Degree sampling: robust soliton distribution (Luby/Mitzenmacher) with
  `c = 0.1`, `delta = 0.05`. Let `R = c·ln(K/δ)·√K`,
  `ρ(1) = 1/K`, `ρ(d) = 1/(d·(d−1))` for `d > 1`,
  `τ(d) = R/(d·K)` for `d < K/R`, `τ(K/R) = R·ln(R/δ)/K`, else `0`;
  normalize `μ = (ρ+τ)/Σ(ρ+τ)` into a CDF. `K = 1` ⇒ degree always 1.
- Neighbor selection: `rng = mulberry32(seed)`; `u1 = rng()` picks the degree
  via the CDF; further `rng()` outputs pick distinct indices in `[0, K)` by
  rejection sampling. Encoder and decoder share this exact routine.
- Encoded payload = byte-wise XOR of the selected source blocks.
- The sender emits an endless stream with fresh random seeds (`crypto` RNG).
- Decoder: iterative **peeling (belief propagation)** over the collected
  equations. If peeling stalls with unresolved blocks and the system is small
  (`K ≤ 1024`), a **Gauss-Jordan elimination fallback** over GF(2) solves the
  remaining subsystem (resolved blocks are substituted out first). Larger
  stalled systems keep collecting — with an endless stream, more equations
  always arrive.
- Expected overhead is ~5–30% extra frames beyond `K` (see `tests/lt.test.ts`
  which asserts an overhead bound and logs the measured value).

## 4. Frame format (binary, big-endian, fixed header)

Common header (8 bytes):

| Offset | Size | Field                               |
| ------ | ---- | ----------------------------------- |
| 0      | 2    | `magic = 0x4151` ("AQ")             |
| 2      | 1    | `version = 0x01`                    |
| 3      | 1    | `frameType`: 0 = metadata, 1 = data |
| 4      | 4    | `sessionId` (random per transfer)   |

Metadata frame (`frameType = 0`), after the header:

| Field                   | Encoding                                                    |
| ----------------------- | ----------------------------------------------------------- |
| file name               | `u16` byte-length + UTF-8 bytes (≤ 255 bytes)               |
| MIME type               | `u16` byte-length + UTF-8 bytes (≤ 128 bytes, may be empty) |
| original size           | `u32`                                                       |
| compressed size         | `u32`                                                       |
| compression flag        | `u8` (0 = none, 1 = gzip)                                   |
| block size              | `u16`                                                       |
| source block count `K`  | `u32`                                                       |
| SHA-256 (original file) | 32 bytes                                                    |

Data frame (`frameType = 1`): `u32 seed` + `blockSize` payload bytes.

Trailer (both types): `u32 CRC32` (IEEE, polynomial `0xEDB88320`) computed over
every preceding byte of the frame. Receivers **silently drop** CRC failures.

Validation (receivers treat scanned bytes as untrusted): verify
`magic`/`version`, exact/consistent lengths before allocating anything, enforce
`origSize, compSize ≤ MAX_FILE_BYTES` (1 GiB), `K ≤ MAX_BLOCKS` (16777216),
`K == ceil(compSize/blockSize)`, `blockSize` within `[64, 2048]`, filename/MIME
length caps. Sanitized filename: strip path separators and control characters.

Stream multiplexing: one metadata frame first, then re-sent every 10 data
frames (`METADATA_REPEAT_EVERY = 10`), so receivers can join at any time.
Receivers lock to the first `sessionId` seen and ignore others until reset.

## 5. QR mapping

- Each frame is encoded as **one binary (byte-mode) QR symbol**, raw bytes, no
  base64.
- Error correction level **M** by default, **L** as a sender option. L packs the
  same bytes into a smaller symbol (measured: 1416 B → 141 modules at M,
  125 at L), which scans easier/farther. Dropped frames are absorbed by the
  fountain code, so the weaker per-symbol correction stays safe. Receivers
  decode either level transparently — EC is not part of the frame format.
  Largest data-frame on the wire is `2000 + 16 = 2016` bytes (version 38),
  inside the 2331-byte version-40-M capacity.
- Rendered large on `<canvas>`: white background, dark modules, quiet zone ≥ 4
  modules, integer pixel scaling, `image-rendering: pixelated`.
- Module ink (black / pure red / green / blue) is presentation only: decoders
  read luminance, so the binary payload is identical. Pure green is lightest
  and may scan worse; the Lab color probe measures this per device.
- One frame per screen refresh. Multi-code tiled screens were prototyped and
  rejected: handheld tilt/keystone misaligns tiles, and the jsQR decoder
  handles exactly one code per image, so tiles fail in real hands. Density
  (larger blocks + higher fps on the proven single-code pipeline) is the
  speed lever, not tiling.

### Dot-matrix physical layer (experimental option)

- The same frame bytes, different pixels: white background, black round data
  dots on a square grid, four solid square corner anchors (top-left 7×7
  modules, the rest 5×5, giving absolute orientation), quiet zone included.
  Anchors are located by connected-component analysis; a DLT homography maps
  grid cells to image pixels (perspective-tolerant by construction).
- Two grid sizes: D96 (≤1152 B) and D144 (≤2592 B), covering every legal
  block size.
- Reed-Solomon RS(255,223) over GF(256) protects the layer: frames are
  zero-padded to 223-byte multiples, each chunk gets 32 parity bytes
  (16 byte-error correction per chunk), then zero-padded to the grid.
  Chunking re-derives deterministically from metadata, so no signaling is
  needed. QR symbols are NOT double-encoded (their own symbol ECC already
  covers them).
- Receivers try QR first, then dot grids (size self-selects from anchor
  geometry); the frame CRC gates everything. Before RS, drops here were
  total; RS converts marginal captures into accepts, which is what makes
  the dot layer viable at all.
- Honest limits: close range, centered captures, black-on-white only.

### Chroma grids (experimental color option)

- Four states per module — white/red/green/blue = 2 bits — on the same
  anchored geometry (black anchors, same homography detection). Roughly 4×
  the density of binary dots at the same module size.
- Calibration rides in the grid: the first 8 cells carry a fixed
  white/red/green/blue reference pattern, sampled per capture. References and
  data drift together under shifting white balance, which is what makes
  classification viable outside a lab. Degenerate captures (references too
  close together) are rejected before spending RS budget.
- Same RS(255,223) protection over the resulting bytes; same deterministic
  chunking; same CRC gate. Run the Lab color probe first: all-PASS hues
  predict chroma viability on that hardware and lighting.

## 6. Density presets

| Preset             | `blockSize` | Wire bytes/frame | Notes                                             |
| ------------------ | ----------- | ---------------- | ------------------------------------------------- |
| Reliable           | 256         | 272              | Smallest symbols, easiest to scan, slowest        |
| Balanced (default) | 512         | 528              | Good middle ground                                |
| Fast               | 800         | 816              | Larger symbols, needs a steady hand               |
| Max                | 1400        | 1416             | Version-33 symbols, close range only, fastest     |
| Ultra              | 2000        | 2016             | Version-38 symbols, closest range, most per frame |

## 7. Completion

Receiver decompresses (if flagged), checks `SHA-256 == metadata sha256`.
Match → success state + download with original name/MIME. Mismatch → explicit
error, keep collecting (more frames cannot fix a hash mismatch of an already
"complete" decode, so the UI offers reset + continue-collecting).

## 8. Throughput model

Goodput ≈ `blockSize × fps / (1 + overhead)`. At the 12 fps default on Balanced:
`512 × 12 / 1.2 ≈ 5.1 KB/s` → 1 MiB ≈ 3.5 min; Max at 12 fps ≈ 14 KB/s.
Honest real-world range is
**5–30 KB/s** depending on preset, fps, device focus speed and steadiness.
The sender shows an estimated time from `K × 1.35 / fps`.

## Scaling: why there is no size cap (and what bounds you instead)

There is deliberately no sender-side file cap — only the 1 GiB protocol
safety bound, which exists to stop _malicious_ frames from forcing
gigabyte allocations on the receiver, not to limit legitimate files.
What actually bounds big transfers:

- **RAM ≈ 2–3× file size on both devices.** The sender holds the file plus
  chunk views (blocks alias the payload; only the padded tail is copied).
  The receiver holds resolved blocks plus a sliding window of at most
  65536 recent equations (older ones are pruned with their seeds — draws
  are i.i.d., so recent frames plus resolved blocks keep decoding
  convergent). Phones realistically top out around 100–300 MB; desktops
  go further.
- **Time.** At 5–20 KB/s, 100 MB needs 1.5–5 hours of steady scanning.
  The sender warns past 5 minutes and strongly past 200 MB.

## 9. Future extension: passphrase encryption

Reserved `version` bump (0x02) or a flag bit: sender derives a key with
PBKDF2/Argon2 → AES-GCM per transfer, encrypts the payload before chunking,
adds salt+nonce to the metadata frame. Decoder gains a passphrase prompt.
No wire-format change is needed for v1.
