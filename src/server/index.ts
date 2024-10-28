import path from 'node:path';

import Fastify from 'fastify';
import { SSRServer } from '@taujs/server';

import { serviceRegistry } from '@server/services';
import { __dirname } from '@server/utils';
import { routes } from '@shared/routes';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InitialRouteParams } from '@taujs/server';

const port = Number(process.env.PORT) || 5173;
const clientRoot = path.resolve(__dirname, '../client');

const startServer = async () => {
  try {
    const fastify = Fastify({
      logger: false,
    });

    void (await fastify.register(import('@fastify/compress'), {
      global: true,
    }));

    void (await fastify.register(import('@fastify/static'), {
      index: false,
      prefix: '/',
      root: clientRoot,
      wildcard: false,
    }));

    void (await fastify.register(SSRServer, {
      clientEntryClient: 'entry-client',
      clientEntryServer: 'entry-server',
      clientHtmlTemplate: 'index.html',
      clientRoot,
      routes,
      serviceRegistry,
    }));

    void fastify.get('/api/initial/:id?', (request: FastifyRequest<{ Params: InitialRouteParams }>, reply: FastifyReply) => {
      const { id } = request.params;

      if (id) {
        setTimeout(() => {
          reply.send({
            title: `taujs [ τjs ] - ${id}`,
            description: `HTTP API call response with - ${id}`,
          });
        }, 1000);
      } else {
        reply.send({ data: 'HTTP API call response with route meta' });
      }
    });

    void fastify.listen({ port }, (err, address) => {
      if (err) {
        fastify.log.error(err);
        process.exit(1);
      }
      console.log(`Server started at ${address}`);
    });
  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
};

startServer();
