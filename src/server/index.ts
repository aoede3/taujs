import path from 'node:path';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createServer } from '@taujs/server';

import { serviceRegistry } from '@server/services';
import { __dirname } from '@server/utils';
import config from '../../taujs.config.js';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InitialRouteParams } from '@taujs/server';

const clientRoot = path.resolve(__dirname, '../client');

const startServer = async () => {
  try {
    const fastify = Fastify({ logger: false });

    void (await fastify.register(import('@fastify/compress'), { global: true }));

    const { net } = await createServer({
      fastify,
      clientRoot,
      config,
      serviceRegistry,
      registerStaticAssets: {
        plugin: fastifyStatic,
      },
      debug: { all: false, ssr: true },
    });

    void fastify.get('/api/initial/:id?', (request: FastifyRequest<{ Params: InitialRouteParams }>, reply: FastifyReply) => {
      const { id } = request.params;

      if (id) {
        setTimeout(() => {
          reply.send({
            title: `τjs [taujs] - ${id}`,
            description: `HTTP API call response with - ${id}`,
          });
        }, 1000);
      } else {
        reply.send({ data: 'HTTP API call response with route meta' });
      }
    });

    void fastify.listen(
      {
        port: net.port,
        host: net.host,
      },
      (err, _address) => {
        if (err) {
          fastify.log.error(err);
          process.exit(1);
        }
        // console.log(`Server started at ${address}`);
      },
    );
  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
};

startServer();
