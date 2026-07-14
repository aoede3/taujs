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
import { AppError } from './core/errors/AppError';
import { createRouteMatchers } from './core/routes/DataRoutes';
import { isDevelopment } from './System';

import { printVitePluginSummary } from './Setup';
import { createLogger } from './logging/Logger';
import { toHttp } from './logging/utils';
import { createAuthHook } from './security/Auth';
import { cspPlugin } from './security/CSP';
import { cspReportPlugin } from './security/CSPReporting';
import { createMaps, loadAssets, processConfigs } from './utils/AssetManager';
import { setupDevServer } from './utils/DevServer';
import { resolveDevViteConfig } from './utils/ViteMergeEngine';
import { createRequestContext } from './utils/Telemetry';
import { handleRender } from './utils/HandleRender';
import { handleNotFound } from './utils/HandleNotFound';
import { registerStaticAssets } from './utils/StaticAssets';
import { composePlugins, pluginCollisionMessage, reservedPluginMessage } from './utils/VitePlugins';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { DevIntrospection } from './core/introspection/DevIntrospection';
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
    let introspection: DevIntrospection | undefined;

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
      { logger },
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
      // RFC 0005 §1 (VS4): resolve `config.vite` ONCE, with the discriminated `serve` context arm
      // (no `appId` - per-app dev servers are rejected by maintainer ruling). Resolution happens
      // HERE rather than inside the engine so the override's plugins can enter the same §5
      // composition rule as app plugins below, instead of bypassing dedupe via the engine's plain
      // append; the remaining admitted fields ride to the engine with plugins stripped.
      const devOverride = opts.taujsConfig?.vite;
      const resolvedDevOverride =
        typeof devOverride === 'function' ? devOverride({ command: 'serve', mode: 'development', isSSRBuild: false, clientRoot }) : devOverride;
      const { plugins: overridePlugins, ...devOverrideFields } = resolvedDevOverride ?? {};

      // RFC 0005 §5 (VS6): ONE composition rule for the shared dev server. Each app is a labelled
      // source (dedupe by plugin name, first occurrence wins), then the `config.vite` source.
      // Cross-app collisions and reserved-prefix drops are promoted from debug to WARN through the
      // shared reporter, so dev and build emit one format. `internal` is empty here: the sole dev
      // internal plugin (`τjs-development-server-debug-logging`) is appended LAST inside
      // setupDevServer, which holds the dev logger it closes over - its pinned-last position is the
      // same §5 contract composePlugins enforces for the reserved `internal` slot.
      const plugins = composePlugins({
        sources: [
          ...processedConfigs.map((c) => ({ source: c.appId, plugins: c.plugins })),
          ...(overridePlugins ? [{ source: 'config.vite', plugins: overridePlugins }] : []),
        ],
        internal: [],
        onCollision: (c) => logger.warn({ plugin: c.name, sources: c.sources, winner: c.winner }, pluginCollisionMessage(c)),
        onReservedPrefix: (d) => logger.warn({ plugin: d.name, source: d.source }, reservedPluginMessage(d)),
      });

      printVitePluginSummary(
        logger,
        processedConfigs.map((c) => ({
          appId: c.appId,
          plugins: (c.plugins ?? []).map((p) => (Array.isArray(p) ? `array(${p.length})` : ((p as any)?.name ?? typeof p))),
        })),
        plugins,
      );

      // The engine (DEV_PROFILE) merges the remaining admitted dev fields (define, css, esbuild,
      // logLevel, optimizeDeps, non-alias resolve) over the composed plugin list + scss default and
      // warns any protected field; `setupDevServer` then receives one resolved fragment rather than
      // a growing positional list. `taujsBuild({ vite })` is build-only and is NOT consulted here.
      const devViteConfig = resolveDevViteConfig({
        viteOverride: resolvedDevOverride ? devOverrideFields : undefined,
        clientRoot,
        appPlugins: plugins,
      });

      // RFC 0005 §3 (VS5): `alias` is the programmatic escape hatch (createServer option); the
      // declarative `config.alias` is layered UNDER it inside setupDevServer.
      viteDevServer = await setupDevServer({
        app,
        clientRoot,
        alias,
        declarativeAlias: opts.taujsConfig?.alias,
        debug: opts.debug,
        devNet: opts.devNet,
        viteConfig: devViteConfig,
      });

      // Structural gate (spec 03 invariant 1): recorder, dev files, and overlay endpoints
      // exist only when the dev Vite middleware exists, loaded via lazy dynamic import.
      // Failure is non-fatal.
      try {
        const { createDevIntrospection } = await import('./core/introspection/DevIntrospection');
        const { registerDevFiles } = await import('./core/introspection/DevFiles');
        const { registerIntrospectionEndpoints } = await import('./core/introspection/DevEndpoints');

        const redaction = opts.taujsConfig?.introspection?.redaction;
        introspection = createDevIntrospection({ logger, denyKeys: redaction?.denyKeys, replaceDefaultDenyKeys: redaction?.replaceDefaultDenyKeys });

        app.decorate('taujsIntrospection', introspection);
        registerDevFiles(app, introspection, logger);
        registerIntrospectionEndpoints(app, { introspection, taujsConfig: opts.taujsConfig, serviceRegistry, logger });
      } catch (err) {
        logger.warn({ component: 'introspection', error: (err as Error)?.message ?? String(err) }, 'Trace recording unavailable (non-fatal)');
      }
    }
    // Trace context first, deliberately before auth: every request — rendered, fallthrough,
    // asset-like — gets a traceId and the x-trace-id response header before route matching,
    // and auth logging can carry the traceId (P0B-01). In dev the request logger is teed
    // into the logs annex and the recorder rides the context (P0B-02).
    app.decorateRequest('taujsRequestContext', null);
    app.addHook('onRequest', async (req, reply) => {
      const requestContext = createRequestContext(req, reply, logger);
      if (introspection) {
        requestContext.logger = introspection.wrapRequestLogger(requestContext.logger, requestContext.traceId);
        requestContext.recorder = introspection.recorder;
      }
      req.taujsRequestContext = requestContext;
      requestContext.recorder?.requestStart({ traceId: requestContext.traceId, url: req.url, method: req.method });
    });
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
          viteDevServer,
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
