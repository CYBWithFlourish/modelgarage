// src/server.mjs
import { pathToFileURL } from 'node:url';
import { startLocalServer } from '../shared/http.mjs';
import { getSdk } from '../shared/qvac.mjs';
import { createMatchmaker } from './service.mjs';

// Lazily create a single matchmaker instance shared across invocations
let matchmakerInstance = null;
function getMatchmaker() {
  if (!matchmakerInstance) {
    matchmakerInstance = createMatchmaker({ getSdk });
  }
  return matchmakerInstance;
}

// Read the request body (Vercel Node runtime does NOT auto-parse JSON)
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

// Default export required by Vercel: must be a function
export default async function handler(req, res) {
  const matchmaker = getMatchmaker();
  const { method } = req;
  const pathname = (req.url || '').split('?')[0];

  try {
    if (method === 'GET' && pathname === '/api/status') {
      res.status(200).json(await matchmaker.status());
      return;
    }

    if (method === 'POST' && pathname === '/api/assess') {
      const body = await readBody(req);
      res.status(200).json(await matchmaker.assess(body));
      return;
    }

    if (method === 'POST' && pathname === '/api/load') {
      const body = await readBody(req);
      res.status(200).json(await matchmaker.load(body));
      return;
    }

    if (method === 'POST' && pathname === '/api/cancel') {
      res.status(200).json(await matchmaker.cancel());
      return;
    }

    res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
}

// Kept for local development only (running `node src/server.mjs`)
export function startMatchmaker() {
  const matchmaker = getMatchmaker();
  const server = startLocalServer({
    name: 'ModelGarage',
    port: 4323,
    publicDir: new URL('./public/', import.meta.url),
    routes: {
      'GET /api/status': async () => matchmaker.status(),
      'POST /api/assess': async ({ body }) => matchmaker.assess(body),
      'POST /api/load': async ({ body }) => matchmaker.load(body),
      'POST /api/cancel': async () => matchmaker.cancel(),
    },
  });

  const shutdown = async () => {
    server.close();
    if (matchmaker.status().active?.kind === 'load') {
      await matchmaker.cancel().catch(() => {});
    }
    const sdk = await getSdk().catch(() => null);
    if (sdk) await sdk.close().catch(() => {});
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);

  return server;
}

// Only start the long-running server when run directly (local dev)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMatchmaker();
}
