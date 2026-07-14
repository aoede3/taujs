import path from 'node:path';

import { CONTENT } from '../constants';
import { createLogger } from '../logging/Logger';
import { overrideCSSHMRConsoleError } from './Templates';
import { findFormerlyDiscoveredViteConfig, formerlyDiscoveredViteConfigWarning } from './ViteConfigDiscovery';

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

  // Migration detection: with configFile: false pinned below, Vite no longer probes the client
  // base root that it used to search on τjs's behalf. Warn if a vite.config.* still sits there,
  // so its silent behaviour loss is visible. Project-root files were never read and are exempt.
  const discovered = findFormerlyDiscoveredViteConfig(baseClientRoot);
  if (discovered) logger.warn({ file: discovered }, formerlyDiscoveredViteConfigWarning(discovered));

  const { createServer } = await import('vite');

  const viteDevServer = await createServer({
    appType: 'custom',
    configFile: false,
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
        '@server': path.resolve(baseClientRoot, '../server'),
        '@shared': path.resolve(baseClientRoot, '../shared'),
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
