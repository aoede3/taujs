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
import { isDevelopment } from './utils/System';
import { createMaps, loadAssets, processConfigs } from './utils/AssetManager';
import { setupDevServer } from './utils/DevServer';
import { handleRender } from './utils/HandleRender';
import { handleNotFound } from './utils/HandleNotFound';
import { createRouteMatchers } from './utils/DataRoutes';
import { isServiceError, ServiceError } from './utils/ServiceError';
import { cspReportPlugin } from './utils/Reporting';
import { Logger } from './utils/Logger';

import type { FastifyInstance, FastifyPluginAsync, FastifyPluginCallback } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { SSRServerOptions } from './types';

export { TEMPLATE };

export const SSRServer: FastifyPluginAsync<SSRServerOptions> = fp(
  async (app: FastifyInstance, opts: SSRServerOptions) => {
    const { alias, configs, routes, serviceRegistry, clientRoot: baseClientRoot, security } = opts;

    // Establish a base logger and apply any debug configuration
    const baseLogger = opts.logger ?? new Logger();
    if (opts.isDebug !== undefined) baseLogger.configure(opts.isDebug);
    const logger = baseLogger.child({ component: 'SSRServer' });

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
        debug: opts.isDebug,
        logger: baseLogger,
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
        isDebug: opts.isDebug,
        logger: baseLogger,
        onViolation: security.csp.reporting.onViolation,
      });
    }

    app.register(cspPlugin, {
      directives: opts.security?.csp?.directives,
      generateCSP: opts.security?.csp?.generateCSP,
      routeMatchers,
      isDebug: opts.isDebug,
    });

    if (isDevelopment) {
      viteDevServer = await setupDevServer(app, baseClientRoot, alias, opts.isDebug, opts.devNet);
    }

    app.addHook('onRequest', createAuthHook(routes, baseLogger, opts.isDebug));

    app.get('/*', async (req, reply) => {
      await handleRender(req, reply, routeMatchers, processedConfigs, serviceRegistry, maps, {
        debug: opts.isDebug,
        logger: baseLogger,
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
          logger: baseLogger,
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

      // Proper message + meta (do not pass Error as the first arg)
      logger.error('Request failed', {
        error: serviceErr.message,
        safeMessage: serviceErr.safeMessage,
        httpStatus: serviceErr.httpStatus,
        code: (serviceErr as any).code, // if your ServiceError exposes a code
        details: (serviceErr as any).details,
        ...ctx,
      });

      if (!reply.raw.headersSent) {
        reply.status(serviceErr.httpStatus).send(serviceErr.safeMessage);
      } else {
        reply.raw.end();
      }
    });
  },
  { name: 'τjs-ssr-server' },
);
