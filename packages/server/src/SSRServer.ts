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
import { logResponseFailure } from './core/errors/ResponseFailureLog';
import { fastifyConfigForRoute, selectedRouteFrom } from './core/routes/FastifyRoutes';
import { isDevelopment, runtimeMode } from './System';

import { printVitePluginSummary } from './Setup';
import { createLogger } from './logging/Logger';
import { createRuntimeLogger, createRuntimeRequestLogger } from './logging/RuntimeLogger';
import { toHttp } from './logging/utils';
import { createAuthHook } from './security/Auth';
import { cspPlugin } from './security/CSP';
import { cspReportPlugin } from './security/CSPReporting';
import { createMaps, loadAssets, processConfigs } from './utils/AssetManager';
import { createRequestContext, getRequestContext } from './utils/Telemetry';
import { handleRender } from './utils/HandleRender';
import { handleNotFound } from './utils/HandleNotFound';
import { registerStaticAssets } from './utils/StaticAssets';
import { pluginCollisionMessage, reservedPluginMessage } from './utils/VitePlugins';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { DevIntrospection } from './core/introspection/DevIntrospection';
import type { SSRServerOptions } from './types';

export { TEMPLATE };

/**
 * RFC 0010: the one τjs body, installed into the one scope τjs owns.
 *
 * `callerOwnedHost` is never carried in plugin options - it is bound here by `ssrServerPlugin`,
 * which selects Fastify's own encapsulation switch from the same fact. That keeps the registration
 * form and the ownership behaviour from drifting apart.
 */
const installOwnedScope = async (scope: FastifyInstance, opts: SSRServerOptions, callerOwnedHost: boolean): Promise<void> => {
  const { alias, configs, routes, serviceRegistry = {}, clientRoot, security, publicBasePath = '', hmrTransport = 'fixed-port' } = opts;

  const logger = opts.runtimeLogger
    ? createRuntimeLogger(opts.runtimeLogger, {
        context: { component: 'ssr-server' },
        includeContext: true,
        singleLine: true,
      })
    : createLogger({
        debug: opts.debug,
        context: { component: 'ssr-server' },
        minLevel: runtimeMode === 'production' ? 'info' : 'debug',
        includeContext: true,
        singleLine: true,
      });

  const maps = createMaps();

  const processedConfigs = processConfigs(configs, clientRoot, TEMPLATE);
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
    { logger, publicBasePath },
  );

  // Tri-state contract: `undefined` installs the default production registration, explicit
  // `false` installs no static plugin (CDN-owned assets), and a registration object/array is
  // honoured below. `=== undefined` keeps `false` out of this branch.
  if (!isDevelopment && opts.staticAssets === undefined) {
    const fastifyStatic = await import('@fastify/static');

    await registerStaticAssets(scope, clientRoot, { plugin: fastifyStatic.default });
  }

  if (opts.staticAssets) await registerStaticAssets(scope, clientRoot, opts.staticAssets);

  if (security?.csp?.reporting) {
    scope.register(cspReportPlugin, {
      path: security.csp.reporting.endpoint,
      debug: opts.debug,
      logger,
      runtimeLogger: opts.runtimeLogger,
      onViolation: security.csp.reporting.onViolation,
    });
  }

  scope.register(cspPlugin, {
    directives: opts.security?.csp?.directives,
    generateCSP: opts.security?.csp?.generateCSP,
    debug: opts.debug,
    logger,
    runtimeLogger: opts.runtimeLogger,
  });

  if (isDevelopment) {
    // Development-only modules load here, never statically: OwnershipPrepass reaches `vite` at
    // module scope, and the production module graph must not resolve the Vite toolchain.
    const { setupDevServer } = await import('./utils/DevServer');
    const { resolveDevViteConfig } = await import('./utils/ViteMergeEngine');
    const { assembleDevPluginChain } = await import('./utils/OwnershipPrepass');

    // RFC 0005 §1 (VS4): resolve `config.vite` ONCE, with the discriminated `serve` context arm
    // (no `appId` - per-app dev servers are rejected by maintainer ruling). Resolution happens
    // HERE rather than inside the engine so the override's plugins can enter the same §5
    // composition rule as app plugins below, instead of bypassing dedupe via the engine's plain
    // append; the remaining admitted fields ride to the engine with plugins stripped.
    const devOverride = opts.taujsConfig?.vite;
    const resolvedDevOverride =
      typeof devOverride === 'function' ? devOverride({ command: 'serve', mode: 'development', isSSRBuild: false, clientRoot }) : devOverride;
    const { plugins: overridePlugins, ...devOverrideFields } = resolvedDevOverride ?? {};

    // ESC-1 (RFC 0006) - GLOBAL ownership preparation over ALL apps + the §5 dev composition, in the
    // ONE ordering `assembleDevPluginChain` owns (phase 1 prepareOwnership -> phase 2
    // assembleManagedSources instantiating EVERY active key + a fresh fail-closed diagnostic + the
    // tagged-raw-compiler hard error -> composePlugins). Host-owned managed sources are PREPENDED
    // (diagnostic first within the `enforce:'pre'` tier), then each app is a labelled source of its
    // RAW plugins (managed contributions removed), then the resolved `config.vite` source. Cross-app
    // collisions and reserved-prefix drops are promoted from debug to WARN through the shared reporter
    // so dev and build emit one format. `internal` is empty here: the sole dev internal plugin
    // (`τjs-development-server-debug-logging`) is appended LAST inside setupDevServer, which holds the
    // dev logger it closes over - the same §5 contract composePlugins enforces for `internal`. The
    // integration fixture drives this SAME function (via a test-only source alias), so its evidence
    // exercises the real ordering rather than a hand-rolled copy. A no-op when no managed contribution
    // is declared.
    const { plugins, ownership } = await assembleDevPluginChain({
      apps: processedConfigs.map((c) => ({ appId: c.appId, appRoot: c.clientRoot, plugins: c.plugins, renderer: c.renderer })),
      projectRoot: opts.projectRoot ?? process.cwd(),
      overridePlugins,
      onCollision: (c) => logger.warn({ plugin: c.name, sources: c.sources, winner: c.winner }, pluginCollisionMessage(c)),
      onReservedPrefix: (d) => logger.warn({ plugin: d.name, source: d.source }, reservedPluginMessage(d)),
    });
    const rawOf = (appId: string) => ownership.rawByApp.get(appId) ?? [];

    printVitePluginSummary(
      logger,
      processedConfigs.map((c) => ({
        appId: c.appId,
        plugins: rawOf(c.appId).map((p) => (Array.isArray(p) ? `array(${p.length})` : ((p as any)?.name ?? typeof p))),
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
      app: scope,
      // RFC 0010: the single caller-root exception. Supplied only for embedded development, so
      // the delegating hook can observe URLs Fastify did not route to a τjs route. Undefined on
      // every other path, where the hook lands on the owned scope exactly as before.
      viteRequestHookOwner: opts.viteRequestHookOwner,
      clientRoot,
      alias,
      declarativeAlias: opts.taujsConfig?.alias,
      projectRoot: opts.projectRoot,
      debug: opts.debug,
      logger,
      devNet: opts.devNet,
      viteConfig: devViteConfig,
      // RFC 0012 (PR 2): reception stays single-sourced from Fastify - the register-time
      // prefix IS `scope.prefix` on the encapsulated registration; emission is the validated
      // coordinate threaded from createServer.
      mountPrefix: scope.prefix || '',
      publicBasePath,
      hmrTransport,
    });

    // RFC 0010: τjs creates the Vite server, so τjs closes it. Guarded because `onClose` can be
    // reached more than once when a caller closes an instance that is already closing.
    const ownedViteDevServer = viteDevServer;
    let viteClosed = false;
    scope.addHook('onClose', async () => {
      if (viteClosed) return;
      viteClosed = true;
      await ownedViteDevServer.close();
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

      scope.decorate('taujsIntrospection', introspection);
      registerDevFiles(scope, introspection, logger);
      registerIntrospectionEndpoints(scope, {
        introspection,
        taujsConfig: opts.taujsConfig,
        allowedHosts: opts.introspectionAllowedHosts,
        serviceRegistry,
        logger,
      });
    } catch (err) {
      logger.warn({ component: 'introspection', error: (err as Error)?.message ?? String(err) }, 'Episode recording unavailable (non-fatal)');
    }

    // RFC 0010: boot-graph emission belongs to whichever scope τjs owns, so it has the same owner
    // as the dev files and recorder above rather than a second site in `createServer`. The hook is
    // `onListen`, which fires for an encapsulated child when the host binds. Non-fatal.
    if (opts.taujsConfig) {
      try {
        const { registerBootGraphEmission } = await import('./core/introspection/EmitGraph');

        registerBootGraphEmission(scope, opts.taujsConfig, serviceRegistry, logger);
      } catch (err) {
        logger.warn({ component: 'introspection', error: (err as Error)?.message ?? String(err) }, 'Graph emission unavailable (non-fatal)');
      }
    }
  }
  // Request context first, deliberately before auth: every request - rendered, fallthrough,
  // asset-like - gets a requestId and the x-request-id response header before auth,
  // and auth logging can carry the requestId (P0B-01). In dev the request logger is teed
  // into the logs annex and the recorder rides the context (P0B-02).
  scope.decorateRequest('taujsRequestContext', null);
  scope.addHook('onRequest', async (req, reply) => {
    const requestContext = createRequestContext(
      req,
      reply,
      logger,
      opts.runtimeLogger ? (bindings) => createRuntimeRequestLogger(opts.runtimeLogger!, req, { component: 'ssr-server', ...bindings }) : undefined,
    );
    if (introspection) {
      requestContext.logger = introspection.wrapRequestLogger(requestContext.logger, requestContext.requestId);
      requestContext.recorder = introspection.recorder;
    }
    req.taujsRequestContext = requestContext;
    requestContext.recorder?.requestStart({ requestId: requestContext.requestId, url: req.url, method: req.method });
  });
  scope.addHook('onRequest', createAuthHook(logger));

  for (const route of routes) {
    scope.get(route.path, { config: fastifyConfigForRoute(route) }, async (req, reply) => {
      const selectedRoute = selectedRouteFrom(req);
      if (!selectedRoute) throw AppError.internal(`Fastify selected route "${route.path}" without its τjs route identity`);

      // The streaming strategy returns a COLD document stream as the Fastify payload, so the
      // handler must return what `handleRender` returns.
      //
      // `handleRender` does NOT send, and nothing is ever "in flight": the document only renders if
      // Fastify is handed it. Resolving `undefined` instead makes Fastify send an empty response
      // ITSELF - `wrap-thenable` sees an unsent reply whose headers have not gone out and calls
      // `reply.send(undefined)` - so the client gets a clean, empty 200 and the renderer never
      // starts. That is ONE response, not a second one; the hijacked transport was safe here only
      // because `wrap-thenable` returns early for a hijacked reply.
      return await handleRender(req, reply, selectedRoute, processedConfigs, serviceRegistry, maps, {
        debug: opts.debug,
        logger,
        viteDevServer,
        publicBasePath,
      });
    });
  }

  // RFC 0010 (Q5): the implicit application shell is a τjs-created-host convenience only. Fastify
  // keys not-found handlers by PREFIX, not scope, so an unprefixed child registering one either
  // collides with a caller handler at boot or silently becomes the 404 owner for the whole server
  // when the caller has none. A caller-owned host keeps its own not-found policy; a shell there
  // requires an explicitly declared terminal wildcard page route.
  if (!callerOwnedHost) {
    scope.setNotFoundHandler(async (req, reply) => {
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
          publicBasePath,
        },
      );
    });
  }

  // Scoped, not route-local: on a caller-owned host this belongs to the encapsulated child, so τjs
  // pages, static, CSP reporting and introspection all convert errors the τjs way while the
  // caller's own handler stays authoritative for the caller's routes. On a τjs-created host the
  // owned scope IS the root, preserving today's whole-server behaviour.
  scope.setErrorHandler((err, req, reply) => {
    let e: AppError;
    try {
      e = AppError.from(err);
    } catch {
      e = AppError.internal('Internal error');
    }

    logResponseFailure({
      terminal: 'fastify',
      logger: getRequestContext(req)?.logger ?? logger,
      error: e,
      method: req.method,
      url: req.url,
      route: (req as any).routeOptions?.url,
    });

    if (!reply.raw.headersSent) {
      const { status, body } = toHttp(e);
      // `toHttp` ALWAYS produces a structured body, so its media type must not depend on whatever
      // representation the abandoned response happened to declare. A streaming response declares
      // `text/html` up front - Fastify copies that onto the raw response before pulling the
      // document - so without this an error body would be sent under a text/html declaration and
      // Fastify would throw `FST_ERR_REP_INVALID_PAYLOAD_TYPE` instead of answering.
      reply.status(status).type('application/json').send(body);
    } else {
      reply.raw.end();
    }
  });
};

/**
 * RFC 0010: one plugin, two registration forms.
 *
 * The ownership fact drives `fastify-plugin`'s own `encapsulate` switch, so the code reads as the
 * ruled thesis: a caller-supplied instance gets an encapsulated child, and an instance τjs created
 * gets the complete experience installed at its root. Both forms are wrapped, so the plugin is named
 * in the host's plugin tree either way - registration is visible, policy is not.
 *
 * RFC 0012: `mounted` also selects the encapsulated form. fastify-plugin ignores a register-time
 * `prefix` when it breaks encapsulation, so a MOUNTED τjs-created host must encapsulate for the
 * scope-prefix primitive to apply at all - and that same prefixed scope is what confines the
 * created-host shell (prefix-keyed not-found) to the mounted subtree, with an ordinary 404 outside.
 * Unmounted created hosts keep today's root installation byte-for-byte.
 */
export const ssrServerPlugin = ({ callerOwnedHost, mounted = false }: { callerOwnedHost: boolean; mounted?: boolean }): FastifyPluginAsync<SSRServerOptions> =>
  fp(async (scope: FastifyInstance, opts: SSRServerOptions) => installOwnedScope(scope, opts, callerOwnedHost), {
    name: 'τjs-ssr-server',
    encapsulate: callerOwnedHost || mounted,
  });
