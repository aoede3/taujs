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
import { AppError } from './logging/AppError';
import { toHttp } from './logging/utils';
import { createAuthHook } from './security/Auth';
import { cspPlugin } from './security/CSP';
import { isDevelopment } from './utils/System';
import { createMaps, loadAssets, processConfigs } from './utils/AssetManager';
import { setupDevServer } from './utils/DevServer';
import { handleRender } from './utils/HandleRender';
import { handleNotFound } from './utils/HandleNotFound';
import { createRouteMatchers } from './utils/DataRoutes';
import { cspReportPlugin } from './security/CSPReporting';
import { createLogger } from './logging/Logger';

import type { FastifyInstance, FastifyPluginAsync, FastifyPluginCallback } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { SSRServerOptions } from './types';

export { TEMPLATE };

export const SSRServer: FastifyPluginAsync<SSRServerOptions> = fp(
  async (app: FastifyInstance, opts: SSRServerOptions) => {
    const { alias, configs, routes, serviceRegistry, clientRoot: baseClientRoot, security } = opts;

    const logger = createLogger({
      debug: opts.debug,
      context: { component: 'ssr-server' },
      minLevel: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      includeContext: true,
    });

    const maps = createMaps();
    const processedConfigs = processConfigs(configs, baseClientRoot, TEMPLATE);
    const routeMatchers = createRouteMatchers(routes);
    let viteDevServer: ViteDevServer | undefined;

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
        debug: opts.debug,
        logger,
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

    if (security?.csp?.reporting) {
      app.register(cspReportPlugin, {
        path: security.csp.reporting.endpoint,
        debug: opts.debug,
        logger,
        onViolation: security.csp.reporting.onViolation,
      });
    }

    app.register(cspPlugin, {
      directives: opts.security?.csp?.directives,
      generateCSP: opts.security?.csp?.generateCSP,
      routeMatchers,
      debug: opts.debug,
    });

    if (isDevelopment) viteDevServer = await setupDevServer(app, baseClientRoot, alias, opts.debug, opts.devNet);

    app.addHook('onRequest', createAuthHook(routeMatchers, logger));

    app.get('/*', async (req, reply) => {
      await handleRender(req, reply, routeMatchers, processedConfigs, serviceRegistry, maps, {
        debug: opts.debug,
        logger,
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
          debug: opts.debug,
          logger,
        },
      );
    });

    app.setErrorHandler((err, req, reply) => {
      const e = AppError.from(err);

      logger.error(e.message, {
        kind: e.kind,
        httpStatus: e.httpStatus,
        ...(e.code && { code: e.code }),
        details: e.details,
        method: req.method,
        url: req.url,
        route: (req as any).routeOptions?.url,
        stack: e.stack,
      });

      const { status, body } = toHttp(e);

      if (!reply.raw.headersSent) {
        reply.status(status).send(body);
      } else {
        reply.raw.end();
      }
    });
  },
  { name: 'τjs-ssr-server' },
);
