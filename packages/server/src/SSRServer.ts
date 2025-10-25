/**
 * τjs [ taujs ] Orchestration System
 * (c) 2024-present Aoede Ltd
 * Author: John Smith
 *
 * Licensed under the MIT License - attribution appreciated.
 * Part of the τjs [ taujs ] system for declarative, build-time orchestration of microfrontend applications,
 * including CSR, SSR, streaming, and middleware composition.
 */

import fp from 'fastify-plugin';

import { TEMPLATE } from './constants';
import { AppError } from './logging/AppError';
import { createLogger } from './logging/Logger';
import { toHttp } from './logging/utils';
import { createAuthHook } from './security/Auth';
import { cspPlugin } from './security/CSP';
import { cspReportPlugin } from './security/CSPReporting';
import { createMaps, loadAssets, processConfigs } from './utils/AssetManager';
import { setupDevServer } from './utils/DevServer';
import { handleRender } from './utils/HandleRender';
import { handleNotFound } from './utils/HandleNotFound';
import { createRouteMatchers } from './utils/DataRoutes';
import { registerStaticAssets } from './utils/StaticAssets';
import { isDevelopment } from './utils/System';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
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
      singleLine: true,
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

    if (opts.staticAssets) await registerStaticAssets(app, baseClientRoot, opts.staticAssets);

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

      const alreadyLogged = !!(e as any)?.details && (e as any).details && (e as any).details.logged;

      if (!alreadyLogged) {
        logger.error(
          {
            kind: e.kind,
            httpStatus: e.httpStatus,
            ...(e.code ? { code: e.code } : {}),
            ...(e.details ? { details: e.details } : {}),
            method: req.method,
            url: req.url,
            route: (req as any).routeOptions?.url,
            stack: e.stack,
          },
          e.message,
        );
      }

      if (!reply.raw.headersSent) {
        const { status, body } = toHttp(e);
        reply.status(status).send(body);
      } else {
        reply.raw.end();
      }
    });
  },
  { name: 'τjs-ssr-server' },
);
