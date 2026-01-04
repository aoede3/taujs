import path from 'node:path';

import { CONTENT } from '../constants';
import { createLogger } from '../logging/Logger';
import { __dirname } from '../System';
import { overrideCSSHMRConsoleError } from './Templates';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { PluginOption, ViteDevServer } from 'vite';
import type { DebugConfig } from '../core/logging/types';

export const setupDevServer = async (
  app: FastifyInstance,
  baseClientRoot: string,
  alias?: Record<string, string>,
  debug?: DebugConfig,
  devNet?: { host: string; hmrPort: number },
  plugins: PluginOption[] = [],
): Promise<ViteDevServer> => {
  const logger = createLogger({
    context: { service: 'setupDevServer' },
    debug,
    minLevel: 'debug',
  });

  const host = devNet?.host ?? process.env.HOST?.trim() ?? process.env.FASTIFY_ADDRESS?.trim() ?? 'localhost';
  const hmrPort = devNet?.hmrPort ?? (Number(process.env.HMR_PORT) || 5174);

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
      ...plugins,
      ...(debug
        ? [
            {
              name: 'τjs-development-server-debug-logging',
              configureServer(server: ViteDevServer) {
                logger.debug('vite', `${CONTENT.TAG} Development server debug started`);

                server.middlewares.use((req: IncomingMessage, res: ServerResponse, next) => {
                  logger.debug(
                    'vite',
                    {
                      method: req.method,
                      url: req.url,
                      host: req.headers.host,
                      ua: req.headers['user-agent'],
                    },
                    '← rx',
                  );

                  res.on('finish', () => {
                    logger.debug(
                      'vite',
                      {
                        method: req.method,
                        url: req.url,
                        statusCode: res.statusCode,
                      },
                      '→ tx',
                    );
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
        clientPort: hmrPort,
        host: host !== 'localhost' ? host : undefined,
        port: hmrPort,
        protocol: 'ws',
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
