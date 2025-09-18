import path from 'node:path';

import pc from 'picocolors';

import { __dirname } from './System';
import { overrideCSSHMRConsoleError } from './Templates';
import { createLogger, debugLog } from './Logger';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { DebugConfig } from './Logger';

export const setupDevServer = async (
  app: FastifyInstance,
  baseClientRoot: string,
  alias?: Record<string, string>,
  isDebug?: DebugConfig,
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
              name: 'τjs-development-server-debug-logging',
              configureServer(server: ViteDevServer) {
                logger.log(pc.green('τjs development server debug started.'));

                server.middlewares.use((req: IncomingMessage, res: ServerResponse, next) => {
                  debugLog(logger, 'trx', '← rx', isDebug, req);

                  res.on('finish', () => {
                    debugLog(logger, 'trx', '→ tx', isDebug, req);
                  });

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
