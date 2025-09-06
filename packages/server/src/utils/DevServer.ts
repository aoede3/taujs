import path from 'node:path';

import pc from 'picocolors';

import { __dirname } from './System';
import { overrideCSSHMRConsoleError } from './Templates';
import { createLogger } from './Logger';

import type { FastifyInstance } from 'fastify';
import type { ViteDevServer } from 'vite';

export const setupDevServer = async (
  app: FastifyInstance,
  baseClientRoot: string,
  alias?: Record<string, string>,
  isDebug?: boolean,
): Promise<ViteDevServer> => {
  const logger = createLogger(isDebug ?? false);
  const { createServer } = await import('vite');

  const viteDevServer = await createServer({
    appType: 'custom',
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
        },
      },
    },
    mode: 'development',
    plugins: [
      ...(isDebug
        ? [
            {
              name: 'taujs-development-server-debug-logging',
              configureServer(server: ViteDevServer) {
                logger.log(pc.green('τjs development server debug started.'));

                server.middlewares.use((req, res, next) => {
                  logger.log(pc.cyan(`← rx: ${req.url}`));

                  res.on('finish', () => logger.log(pc.yellow(`→ tx: ${req.url}`)));

                  next();
                });
              },
            },
          ]
        : []),
    ],
    resolve: {
      alias: {
        '@client': path.resolve(baseClientRoot),
        '@server': path.resolve(__dirname),
        '@shared': path.resolve(__dirname, '../shared'),
        ...alias,
      },
    },
    root: baseClientRoot,
    server: {
      middlewareMode: true,
      hmr: {
        port: 5174,
      },
    },
  });

  overrideCSSHMRConsoleError();

  app.addHook('onRequest', async (request, reply) => {
    await new Promise<void>((resolve) => {
      viteDevServer.middlewares(request.raw, reply.raw, () => {
        if (!reply.sent) resolve();
      });
    });
  });

  return viteDevServer;
};
