import { pathToFileURL } from 'node:url';
import { startLocalServer } from '../shared/http.mjs';
import { getSdk } from '../shared/qvac.mjs';
import { createMatchmaker } from './service.mjs';

export function startMatchmaker() {
  const matchmaker = createMatchmaker({ getSdk });
  const server = startLocalServer({
    name: 'ModelGarage', port: 4323, publicDir: new URL('./public/', import.meta.url),
    routes: {
      'GET /api/status': async () => matchmaker.status(),
      'POST /api/assess': async ({ body }) => matchmaker.assess(body),
      'POST /api/load': async ({ body }) => matchmaker.load(body),
      'POST /api/cancel': async () => matchmaker.cancel()
    }
  });
  const shutdown = async () => {
    server.close();
    if (matchmaker.status().active?.kind === 'load') await matchmaker.cancel().catch(() => {});
    const sdk = await getSdk().catch(() => null);
    if (sdk) await sdk.close().catch(() => {});
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startMatchmaker();
