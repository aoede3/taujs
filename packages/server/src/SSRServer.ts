/**
 * taujs [ τjs ] Orchestration System
 * (c) 2024-present Aoede Ltd
 * Author: John Smith
 *
 * Licensed under the MIT License — attribution appreciated.
 * Part of the taujs [ τjs ] system for declarative, build-time orchestration of microfrontend applications,
 * including CSR, SSR, streaming, and middleware composition.
 */

import fp from 'fastify-plugin';

import { TEMPLATE } from './constants';
import { createAuthHook } from './security/auth';
import { cspPlugin } from './security/csp';
import { __dirname, isDevelopment } from './utils/System';
import { createMaps, loadAssets, processConfigs } from './utils/AssetManager';
import { setupDevServer } from './utils/DevServer';
import { handleRender } from './utils/HandleRender';
import { handleNotFound } from './utils/HandleNotFound';
import { createRouteMatchers } from './utils/DataRoutes';
import { createLogger, normaliseDebug } from './utils/Logger';
import { isServiceError, ServiceError } from './utils/ServiceError';

import type { FastifyInstance, FastifyPluginAsync, FastifyPluginCallback } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { SSRServerOptions } from './types';

export { TEMPLATE };

export const SSRServer: FastifyPluginAsync<SSRServerOptions> = fp(
  async (app: FastifyInstance, opts: SSRServerOptions) => {
    const { alias, configs, routes, serviceRegistry, clientRoot: baseClientRoot } = opts;

    const debugConfig = normaliseDebug(opts.isDebug);

    const maps = createMaps();
    const processedConfigs = processConfigs(configs, baseClientRoot, TEMPLATE);
    const routeMatchers = createRouteMatchers(routes);
    let viteDevServer: ViteDevServer;

    await loadAssets(
      processedConfigs,
      baseClientRoot,
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      {
        debug: opts.isDebug,
        logger: opts.logger,
      },
    );

    if (opts.registerStaticAssets && typeof opts.registerStaticAssets === 'object') {
      const { plugin, options } = opts.registerStaticAssets;
      await app.register(plugin as FastifyPluginCallback<any>, {
        root: baseClientRoot,
        prefix: '/',
        index: false,
        wildcard: false,
        ...(options ?? {}),
      });
    }

    app.register(cspPlugin, {
      directives: opts.security?.csp?.directives,
      generateCSP: opts.security?.csp?.generateCSP,
    });

    if (isDevelopment) viteDevServer = await setupDevServer(app, baseClientRoot, alias, opts.isDebug, opts.devNet);

    app.addHook('onRequest', createAuthHook(routes, debugConfig));

    app.get('/*', async (req, reply) => {
      await handleRender(req, reply, routeMatchers, processedConfigs, serviceRegistry, maps, {
        debug: debugConfig,
        logger: opts.logger,
        viteDevServer,
      });
    });

    app.setNotFoundHandler(async (req, reply) => {
      await handleNotFound(
        req,
        reply,
        processedConfigs,
        {
          cssLinks: maps.cssLinks,
          bootstrapModules: maps.bootstrapModules,
          templates: maps.templates,
        },
        {
          debug: opts.isDebug,
          logger: opts.logger,
        },
      );
    });

    app.setErrorHandler((err, req, reply) => {
      const serviceErr = isServiceError(err) ? err : ServiceError.infra((err as any)?.message ?? 'Unhandled error', { cause: err });

      const ctx = {
        url: req.url,
        method: req.method,
        route: (req as any).routeOptions?.url,
        headers: req.headers,
      };

      const logger = createLogger(opts.isDebug, opts.logger);
      logger.serviceError(serviceErr, ctx);

      if (!reply.raw.headersSent) {
        reply.status(serviceErr.httpStatus).send(serviceErr.safeMessage);
      } else {
        reply.raw.end();
      }
    });
  },
  { name: 'τjs-ssr-server' },
);
