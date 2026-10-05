# ArkQR Production Guide

Deploying ArkQR is deploying static files. There is no server component, no
environment variable, no database, no serverless function. Any host that can
serve files over **HTTPS** works.

## 1. What you deploy

`npm run build` produces `dist/`:

```
dist/
  index.html            # app shell (references everything relatively)
  sw.js                 # offline service worker
  manifest.webmanifest  # PWA manifest
  icon.svg / icon-192.png / icon-512.png
  assets/
    index-<hash>.js     # app (SEND/RECEIVE UI, protocol)
    index-<hash>.css
    encode.worker-<hash>.js   # loaded only in SEND
    decode.worker-<hash>.js   # loaded only in RECEIVE
```

Notes that matter for hosting:

- All URLs are **relative** (`base: './'`), so the app works from a domain
  root (`https://example.com/`) or a sub-path (`https://user.github.io/arkqr/`).
  The service worker and manifest use relative scope, so installability and
  offline mode follow wherever you deploy.
- Filenames contain content hashes **except** `index.html`, `sw.js` and
  `manifest.webmanifest` — that split drives the caching rules in §5.
- Camera access (`getUserMedia`) requires a **secure context**: HTTPS in
  production, or `localhost` for local testing. Plain `http://` LAN URLs get
  no camera API at all (the app says so explicitly, and offers photo-scan).

## 2. Pre-flight checklist

```sh
npm ci
npm run lint && npm run typecheck && npm run test
npm run build
npx serve dist            # or: npx vite preview --port 4173
```

Open the local URL, open DevTools → Application, and confirm: service worker
registered, manifest parsed, icons load. Then run the §8 verification.

## 3. Host guides

### GitHub Pages (project site)

1. Build: `npm run build`.
2. Publish `dist/` to the `gh-pages` branch:
   ```sh
   npx gh-pages -d dist
   ```
   (One-off fetch; no dependency added to the project.)
3. Repo → Settings → Pages → Deploy from branch → `gh-pages` / root.
4. Result: `https://<user>.github.io/<repo>/` over HTTPS. Camera works.

Custom domain: add it under Settings → Pages (enforces HTTPS automatically).

### Netlify

- **Git:** New site from Git → build command `npm run build`, publish
  directory `dist`. No functions, no redirects needed.
- **Drag & drop:** `npm run build`, then drop `dist/` on
  <https://app.netlify.com/drop>.
- Cache headers ship with the repo: `public/_headers` is copied to `dist/_headers`
  and applied automatically (immutable hashed assets; never cache `sw.js`,
  `index.html`, `manifest.webmanifest`).

### Vercel

- **Git:** Import project → Framework Preset “Vite” (build `npm run build`,
  output `dist`). The root `vercel.json` in this repo sets the output
  directory and the same cache headers as Netlify.
- **CLI:** `npx vercel --prod` (first run asks for the same settings).

### Cloudflare Pages

- Dashboard → Pages → Upload assets (`dist/` after `npm run build`), or
  connect Git (build `npm run build`, output `dist`).
- Cloudflare honors `dist/_headers` (same file as Netlify) for cache rules.
- HTTPS is automatic on `*.pages.dev` and custom domains.

### Any static server (nginx / Caddy / Apache)

Serve `dist/` over HTTPS with these rules:

| Path                                             | Cache-Control                         |
| ------------------------------------------------ | ------------------------------------- |
| `/assets/*` (hashed)                             | `public, max-age=31536000, immutable` |
| `/sw.js`, `/index.html`, `/manifest.webmanifest` | `no-cache`                            |
| everything else                                  | default / short                       |

No URL rewrites are required (single page, no router). Do **not** add
`Cross-Origin-Opener/Embedder-Policy` isolation headers — ArkQR needs none
(no `SharedArrayBuffer`), and misconfigured COOP/COEP breaks nothing but
buys nothing either.

**nginx** (inside your `server { … }`, after TLS):

```nginx
root /var/www/arkqr/dist;
location /assets/ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}
location = /sw.js         { add_header Cache-Control "no-cache"; }
location = /index.html    { add_header Cache-Control "no-cache"; }
location = /manifest.webmanifest { add_header Cache-Control "no-cache"; }
```

**Caddy** (`Caddyfile` — automatic HTTPS included):

```caddy
arkqr.example.com {
  root * /var/www/arkqr/dist
  file_server
  header /assets/* Cache-Control "public, max-age=31536000, immutable"
  header /sw.js Cache-Control "no-cache"
  header /index.html Cache-Control "no-cache"
  header /manifest.webmanifest Cache-Control "no-cache"
}
```

**Apache** (`.htaccess` in `dist/`, requires `mod_headers` + `mod_expires`):

```apache
<FilesMatch "^sw\.js$|index\.html$|manifest\.webmanifest$">
  Header set Cache-Control "no-cache"
</FilesMatch>
<FilesMatch "\.(js|css|png|svg)$">
  Header set Cache-Control "public, max-age=31536000, immutable"
</FilesMatch>
```

> The `FilesMatch` above over-caches `icon.svg` (unhashed) for simplicity;
> bump its name or accept a stale icon for up to a year after a rebrand.
> App JS/CSS/workers are always hashed and safe.

### LAN / self-hosted preview (phone-to-phone testing)

`npm run dev` is HTTP: fine on the **same** machine (`localhost` is secure),
useless for a phone camera. Instead:

```sh
npm run dev:https
```

Serves self-signed HTTPS on all interfaces. Open the printed
`https://192.168.x.x:5173` on both phones, accept the certificate warning
once per device, and test the full transfer. Production-equivalent except
for the cert warning.

## 4. Custom domains

Any host above + your DNS:

- Point DNS (CNAME / apex) per the host's docs; HTTPS is provisioned
  automatically everywhere listed (Let's Encrypt).
- After switching domains, bump the `CACHE` name in `public/sw.js`
  (e.g. `arkqr-v2`) so clients drop the old shell on next visit.
- No code changes: relative URLs adapt to any domain or sub-path.

## 5. Post-deploy verification (do this on the real URL)

1. **Shell:** load the page, DevTools → Application → Service worker active;
   go offline (DevTools → Network → Offline) and reload — app still works.
2. **Camera:** RECEIVE → capability list shows secure context + camera OK;
   Start camera shows a live preview.
3. **Acceptance transfer:** SEND a ~1 MB file from phone A; RECEIVE on phone
   B; expect the SHA-256 success state and a byte-identical download.
4. **Mid-stream join:** start B's camera after A has streamed for a while —
   transfer still completes (metadata repeats every 10 frames).
5. **Interruption:** cover B's camera briefly — transfer still completes
   (fountain codes tolerate loss).
6. **Photo fallback:** with the camera off, screenshot A's QR and load it via
   “Scan from photo” — frames register in the counters.
7. **Video export (desktop):** record 10 s, download, confirm a `.webm`/`.mp4`.

## 6. Updates & rollback

- Deploy = replace the static files. Clients pick up the new shell on next
  online visit (navigation is network-first with cache fallback).
- If a release misbehaves, redeploy the previous `dist/` (keep it: tag
  releases in git — the build is reproducible from `npm ci && npm run build`).
- Service worker: the cache name (`arkqr-v1` in `public/sw.js`) versions the
  offline shell; old caches are purged on activate. Bump it when shipping
  breaking shell changes (new filenames, manifest edits).

## 7. Troubleshooting

| Symptom                               | Cause → fix                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| “Camera needs HTTPS” on your URL      | Served over plain HTTP → put TLS in front (all hosts above do it by default).                                       |
| Camera works on desktop, not on phone | Phone reached the site via `http://` IP → use the HTTPS host or `npm run dev:https`.                                |
| Permission denied, no prompt          | Permission was denied earlier → site settings (lock icon) → allow camera → reload.                                  |
| Stale app after deploy                | `sw.js`/`index.html` cached → check §5 headers; hard reload once; confirm new hashes in `dist/assets`.              |
| 404 on a sub-path install             | Served from a file path that doesn't exist → only `/` and `/index.html` are real; link those.                       |
| PWA “not installable”                 | Needs HTTPS + manifest + 192/512 px icons + SW — all ship in `dist/`; check DevTools → Application → Manifest.      |
| Video export missing/slow             | `MediaRecorder`/VP9 support varies (Safari → MP4 fallback is automatic); record on desktop Chrome for best results. |

## 8. Privacy note for operators

Hosting ArkQR gives you **zero** access to transferred files — there is
nothing to log, and nothing should be logged. If you add analytics or logging
to your deployment, say so publicly; the default build phones home to
nowhere (CSP `connect-src 'self'`, no fetch calls in the codebase).
