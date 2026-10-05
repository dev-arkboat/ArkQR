// "npm run dev:https" — LAN camera testing over self-signed HTTPS.
// Phones only expose getUserMedia on secure contexts, so plain-HTTP LAN
// testing cannot use the camera. This serves the app as https://<lan-ip>
// (accept the certificate warning once per device). Dev-only.
import { createServer } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

const server = await createServer({
  configFile: false,
  base: './',
  build: { target: 'es2022', outDir: 'dist' },
  worker: { format: 'es' },
  plugins: [basicSsl()],
  server: { host: true, port: 5173 },
});

await server.listen();
server.printUrls();
