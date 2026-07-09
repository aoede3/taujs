import Fastify from 'fastify';
import { createServer } from '@taujs/server';

import config from '../../taujs.config.ts';
import { serviceRegistry } from './services/registry.ts';

const app = Fastify({ logger: false });

// /admin declares middleware.auth, so boot-time contract verification requires the
// authenticate decorator. Playground policy: a `x-playground-user: admin` header passes.
app.decorate('authenticate', async (req: { headers: Record<string, unknown> }) => {
  if (req.headers['x-playground-user'] !== 'admin') {
    throw Object.assign(new Error('Unauthorised'), { statusCode: 401 });
  }
});

const { net } = await createServer({
  config,
  serviceRegistry,
  fastify: app,
  debug: process.env.NODE_ENV !== 'production' ? { ssr: true } : false,
});

await app.listen({ host: net.host, port: net.port });
console.log(`playground listening on http://${net.host}:${net.port}`);
