import path from 'node:path';

import Fastify from 'fastify';
import { SSRServer } from '@taujs/server';

import { serviceRegistry } from '@server/services';
import { __dirname } from '@server/utils';
import { routes } from '@shared/routes';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InitialRouteParams } from '@taujs/server';

const port = Number(process.env.PORT) || 5173;

const startServer = async () => {
  try {
    const fastify = Fastify({
      logger: false,
    });

    void (await fastify.register(import('@fastify/compress'), {
      global: true,
    }));

    void (await fastify.register(SSRServer, {
      clientEntryClient: 'entry-client',
      clientEntryServer: 'entry-server',
      clientHtmlTemplate: 'index.html',
      clientRoot: path.resolve(__dirname, '../client'),
      routes,
      serviceRegistry,
    }));

    void fastify.get('/api/initial/:id?', (request: FastifyRequest<{ Params: InitialRouteParams }>, reply: FastifyReply) => {
      const { id } = request.params;

      if (id) {
        setTimeout(() => {
          reply.send({ hello: `world GET api call with id ${id}` });
        }, 5500);
      } else {
        reply.send({ hello: 'world' });
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
