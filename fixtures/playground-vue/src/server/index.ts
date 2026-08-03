import Fastify from 'fastify';
import { createServer } from '@taujs/server';

import config from '../../taujs.config.ts';
import { serviceRegistry } from './services/registry.ts';

const app = Fastify({ logger: false });

const { net } = await createServer({
  config,
  serviceRegistry,
  fastify: app,
  // Development is requested explicitly, the same question τjs asks itself: test, staging and an
  // unset variable are production, and debug records are a development facility.
  debug: process.env.NODE_ENV === 'development' ? { ssr: true } : false,
});

await app.listen({ host: net.host, port: net.port });
console.log(`playground-vue listening on http://${net.host}:${net.port}`);
