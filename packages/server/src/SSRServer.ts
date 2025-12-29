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
import { printVitePluginSummary } from './Setup';
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
import { resolveRouteData } from './utils/ResolveRouteData';
import { registerStaticAssets } from './utils/StaticAssets';
import { isDevelopment } from './utils/System';
import { mergePlugins } from './utils/VitePlugins';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { SSRServerOptions } from './types';

export { TEMPLATE };

export const SSRServer: FastifyPluginAsync<SSRServerOptions> = fp(
  async (app: FastifyInstance, opts: SSRServerOptions) => {
    const { alias, configs, routes, serviceRegistry = {}, clientRoot, security } = opts;

    const logger = createLogger({
      debug: opts.debug,
      context: { component: 'ssr-server' },
      minLevel: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      includeContext: true,
      singleLine: true,
    });

    const maps = createMaps();
    const processedConfigs = processConfigs(configs, clientRoot, TEMPLATE);
    const routeMatchers = createRouteMatchers(routes);
    let viteDevServer: ViteDevServer | undefined;

    await loadAssets(
      processedConfigs,
      clientRoot,
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

    if (!isDevelopment && !opts.staticAssets) {
      const fastifyStatic = await import('@fastify/static');

      await registerStaticAssets(app, clientRoot, { plugin: fastifyStatic.default });
    }

    if (opts.staticAssets) await registerStaticAssets(app, clientRoot, opts.staticAssets);

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

    if (isDevelopment) {
      const plugins = mergePlugins({
        internal: [],
        apps: processedConfigs,
      });

      printVitePluginSummary(
        logger,
        processedConfigs.map((c) => ({
          appId: c.appId,
          plugins: (c.plugins ?? []).map((p) => (Array.isArray(p) ? `array(${p.length})` : ((p as any)?.name ?? typeof p))),
        })),
        plugins,
      );

      viteDevServer = await setupDevServer(app, clientRoot, alias, opts.debug, opts.devNet, plugins);
    }
    app.addHook('onRequest', createAuthHook(routeMatchers, logger));

    // NOTE: this route is still subject to the global onRequest auth hook.
    // It intentionally uses the same security surface as HTML routes.
    app.get('/__taujs/route', async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      const url = typeof query.url === 'string' ? query.url : '';

      if (!url) {
        throw AppError.badRequest('url query param required', {
          details: { query },
        });
      }

      const data = await resolveRouteData(url, {
        req,
        reply,
        routeMatchers,
        serviceRegistry,
        logger,
      });

      return reply.status(200).send({ data });
    });

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
