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
import { hasAuthenticate, isAuthRequired, verifyContracts } from './security/verifyMiddleware';
import { __dirname, isDevelopment } from './utils/System';
import { createMaps, loadAssets, processConfigs } from './utils/AssetManager';
import { setupDevServer } from './utils/DevServer';
import { handleRender } from './utils/HandleRender';
import { handleNotFound } from './utils/HandleNotFound';
import { createRouteMatchers } from './utils/DataRoutes';

import type { FastifyInstance, FastifyPluginAsync, FastifyPluginCallback } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { SSRServerOptions } from './types';

export { TEMPLATE };

export const SSRServer: FastifyPluginAsync<SSRServerOptions> = fp(
  async (app: FastifyInstance, opts: SSRServerOptions) => {
    const { alias, configs, routes, serviceRegistry, isDebug, clientRoot: baseClientRoot } = opts;
    const maps = createMaps();
    const processedConfigs = processConfigs(configs, baseClientRoot, TEMPLATE);
    const routeMatchers = createRouteMatchers(opts.routes);
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
    );

    verifyContracts(
      app,
      routes,
      [
        {
          key: 'auth',
          required: isAuthRequired,
          verify: hasAuthenticate,
          errorMessage: 'Routes require auth but Fastify instance is missing `.authenticate` decorator.',
        },
      ],
      opts.isDebug,
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

    app.addHook('onRequest', createAuthHook(routeMatchers));

    if (isDevelopment) viteDevServer = await setupDevServer(app, baseClientRoot, alias, isDebug);

    app.get('/*', async (req, reply) => {
      await handleRender(req, reply, routeMatchers, processedConfigs, serviceRegistry, maps, viteDevServer);
    });

    app.setNotFoundHandler(async (req, reply) => {
      await handleNotFound(req, reply, processedConfigs, {
        cssLinks: maps.cssLinks,
        bootstrapModules: maps.bootstrapModules,
        templates: maps.templates,
      });
    });
  },
  { name: 'taujs-ssr-server' },
);
