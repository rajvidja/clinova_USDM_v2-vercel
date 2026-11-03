// Vercel serverless entry: the whole Express API runs as one function (see scripts/build-vercel.mjs).
// The function file system is read-only except /tmp, so the demo database lives there and is rebuilt on cold starts.
import type { IncomingMessage, ServerResponse } from 'node:http';

process.env.PROTOCOLIQ_DB ??= '/tmp/protocoliq/protocoliq.db';
process.env.PROTOCOLIQ_NO_LISTEN = '1';
process.env.PROTOCOLIQ_DEMO ??= '1';

const { app } = await import('./index.ts');

export default function handler(req: IncomingMessage, res: ServerResponse) {
  // Requests are routed here as /api/index?__path=<rest>; restore the original URL for Express routing.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rest = url.searchParams.get('__path');
  if (rest !== null) {
    url.searchParams.delete('__path');
    const query = url.searchParams.toString();
    req.url = `/api/${rest}${query ? `?${query}` : ''}`;
  }
  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
