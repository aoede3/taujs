import crypto from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import Fastify from 'fastify';
import pc from 'picocolors';

import {
  extractBuildConfigs,
  extractPathCoordinates,
  extractRoutes,
  extractSecurity,
  resolveHmrTransport,
  resolveIntrospectionAllowedHosts,
} from './core/config/Setup';
import { REGEX } from './core/constants';
import { normaliseError } from './core/errors/AppError';

import { CONTENT } from './constants';
import { createRuntimeLogger, type RuntimeLoggerSelection } from './logging/RuntimeLogger';
import { resolveNet } from './network/CLI';
import { bannerPlugin } from './network/Network';
import { verifyContracts, isAuthRequired, hasAuthenticate } from './security/VerifyMiddleware';
import { printConfigSummary, printContractReport, printSecuritySummary } from './Setup';
import { ssrServerPlugin } from './SSRServer';
import { isDevelopment, runtimeMode } from './System';

import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from './core/services/DataServices';
import type { BaseLogger, DebugConfig } from './core/logging/types';
import type { TaujsConfig } from './Config';
import type { NetResolved } from './network/CLI';
import type { StaticAssetsRegistration } from './utils/StaticAssets';

type CreateServerOptions = {
  config: TaujsConfig;
  serviceRegistry?: ServiceRegistry;
  clientRoot?: string;
  alias?: Record<string, string>;
  /**
   * Project root for relative declarative alias normalisation (RFC 0005 §3). Pass the SAME
   * directory `taujsBuild({ projectRoot })` receives (the scaffold uses `process.cwd()` for
   * both) so a relative `config.alias` resolves identically in dev and build. Defaults to
   * `process.cwd()`.
   */
  projectRoot?: string;
  fastify?: FastifyInstance;
  debug?: DebugConfig;
  logger?: BaseLogger;
  /**
   * Static assets in production: omit for the default `@fastify/static` registration, pass a
   * custom registration, or pass `false` to install no static plugin at all (CDN-owned assets).
   */
  staticAssets?: StaticAssetsRegistration;
  port?: number;
};

type CreateServerResult = {
  app?: FastifyInstance;
  net: NetResolved;
};

const resolveClientRoot = (userClientRoot?: string): string => {
  if (userClientRoot) return path.isAbsolute(userClientRoot) ? userClientRoot : path.resolve(process.cwd(), userClientRoot);

  const cwd = process.cwd();

  if (runtimeMode === 'production') return path.resolve(cwd, 'dist/client');

  return path.resolve(cwd, 'src/client');
};

export const createServer = async (opts: CreateServerOptions): Promise<CreateServerResult> => {
  const t0 = performance.now();
  const clientRoot = resolveClientRoot(opts.clientRoot);

  // RFC 0012 (PR-1 review): the two installation-level addressing coordinates, validated at
  // FUNCTION ENTRY - invalid configuration must fail before any host state exists, so neither a
  // τjs-created Fastify instance nor a caller-host registration (banner) happens first. Build
  // validates identically via taujsBuild. Defaults ('' / '') are today's behaviour.
  const { mountPrefix, publicBasePath } = extractPathCoordinates(opts.config);

  // RFC 0010: the one internal ownership fact. Supplying a Fastify instance means the caller owns
  // the server and τjs owns only an encapsulated scope within it; omitting one means τjs created
  // the server and provides the complete experience. Derived here, never a public option, and never
  // threaded through plugin options - it selects the registration form below, so the form and the
  // behaviour cannot drift apart.
  const callerOwnedHost = opts.fastify !== undefined;

  // RFC 0013: resolve the development HMR transport at FUNCTION ENTRY, for the same reason the
  // addressing coordinates are - an unsupported ownership/transport combination must fail before
  // any host state exists, never after Vite has installed an upgrade listener. The ownership
  // rejection is DEVELOPMENT-only: production installs no HMR facility, so a Mode-B production
  // deployment sharing one configuration must still boot.
  const hmrTransport = resolveHmrTransport(opts.config, callerOwnedHost, isDevelopment);

  // Post-freeze ruling 2026-08-08 (introspection host admission): resolved at FUNCTION ENTRY in
  // EVERY mode for the same reason the coordinates above are - an invalid declaration must fail
  // before any host state exists, and production must reject the typo a shared configuration
  // would otherwise hide, even though the surface it admits is structurally dev-absent.
  const introspectionAllowedHosts = resolveIntrospectionAllowedHosts(opts.config);

  // SC-09 ruling 4: on a τjs-created host, request identity aligns at Fastify construction - the
  // one place τjs legitimately owns that policy. A single valid inbound `x-request-id` becomes
  // `req.id`; anything else gets a UUID (repeated headers arrive as an array and fail the string
  // guard). `requestIdHeader` must stay unset: on Fastify 5.10 it short-circuits `genReqId` and
  // would adopt the header without this validation. A supplied host is never touched - the caller
  // owns correlation policy there, and τjs adopts whatever `req.id` it produced.
  const app =
    opts.fastify ??
    Fastify({
      logger: false,
      genReqId(rawReq) {
        const incoming = rawReq.headers['x-request-id'];

        return typeof incoming === 'string' && REGEX.SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
      },
    });
  const fastifyLogger = app.log && app.log.level && app.log.level !== 'silent' ? app.log : undefined;
  const runtimeLogger: RuntimeLoggerSelection = {
    source: opts.logger ? 'explicit' : fastifyLogger ? 'fastify' : 'fallback',
    debug: opts.debug,
    custom: opts.logger ?? fastifyLogger,
    minLevel: runtimeMode === 'production' ? 'info' : 'debug',
  };
  const logger = createRuntimeLogger(runtimeLogger, {
    includeContext: true,
  });

  const net = resolveNet(opts.config.server);

  // RFC 0010: the banner is τjs-created-host presentation. A caller-owned host receives no banner
  // decoration and no `onReady` hook; its boot summaries still reach the resolved logger below.
  if (!callerOwnedHost) {
    await app.register(bannerPlugin, {
      debug: opts.debug,
      logger,
      hmr: { host: net.host, port: net.hmrPort },
    });
  }

  const configs = extractBuildConfigs(opts.config);
  const { routes, apps, totalRoutes, durationMs } = extractRoutes(opts.config);
  const { security, durationMs: securityDuration, hasExplicitCSP } = extractSecurity(opts.config);

  printConfigSummary(logger, apps, configs.length, totalRoutes, durationMs);
  printSecuritySummary(logger, routes, security, hasExplicitCSP, securityDuration);

  // RFC 0010: ownership is derived, never configured, so the boot summary has to say which side of
  // the thesis this process is on. Without it a caller cannot tell from the logs why their 404s,
  // CSP or correlation headers changed.
  //
  // RFC 0010 Q5: a caller-owned host gets no τjs not-found shell, so the line reports whether the
  // opt-in - a declared terminal `/*` page - is in force. RFC 0012: a mounted created host's
  // shell is confined to its subtree, so the created arm is mount-aware rather than claiming a
  // whole-server shell unconditionally.
  const terminalWildcard = routes.some((route) => route.path === '/*');
  const mounted = mountPrefix !== '';

  const ownershipMessage = callerOwnedHost
    ? `${CONTENT.TAG} [ownership] Fastify supplied by caller - τjs owns its declared routes in an encapsulated scope; host errors, not-found, CSP and request identity remain yours. ${
        terminalWildcard
          ? "Terminal '/*' τjs page declared: it owns GET paths not claimed by a more-specific route within the τjs scope, including API-like and asset-like paths"
          : "No terminal '/*' τjs page declared: your routes and not-found policy own all remaining GET paths"
      }`
    : `${CONTENT.TAG} [ownership] Fastify created by τjs - ${
        mounted ? 'shell confined to the mounted subtree, an ordinary 404 outside it' : 'whole-server shell'
      }, CSP and request identity`;

  logger.info({ component: 'ownership', callerOwnedHost, mounted, terminalWildcard }, ownershipMessage);

  // RFC 0012: mounting is boot-visible for the same reason ownership is - without this line a
  // reader cannot tell from the logs why every τjs URL moved.
  if (mountPrefix !== '' || publicBasePath !== '') {
    logger.info(
      { component: 'addressing', mountPrefix, publicBasePath },
      `${CONTENT.TAG} [addressing] mounted at '${mountPrefix || '/'}', emitting under '${publicBasePath || '/'}'`,
    );
  }

  // RFC security model §2: relaxing the loopback guard must shout in the boot summary —
  // exact text, not a debug line.
  if (isDevelopment && opts.config.introspection?.allowNonLoopback) {
    logger.warn({ component: 'introspection' }, 'τjs introspection overlay exposed to non-loopback clients. For trusted dev networks only.');
  }

  // Post-freeze ruling 2026-08-08: admitting extra hostnames shouts for the same reason -
  // wording FROZEN at review; the resolved hosts travel as structured metadata, never
  // interpolated text. Development-only, like the surface the declaration admits.
  if (isDevelopment && introspectionAllowedHosts.size > 0) {
    logger.warn(
      { component: 'introspection', allowedHosts: [...introspectionAllowedHosts] },
      'τjs introspection overlay admits additional hostnames. Ensure any rewriting proxy validates the browser-facing Host; otherwise use a trusted development network only.',
    );
  }

  const report = verifyContracts(
    app,
    routes,
    [
      {
        key: 'auth',
        required: (rts) => rts.some(isAuthRequired),
        verify: hasAuthenticate,
        errorMessage: 'Routes require auth but Fastify is missing .authenticate decorator.',
      },
      {
        key: 'csp',
        required: () => true,
        verify: () => true,
        errorMessage: 'CSP plugin failed to register.',
      },
    ],
    security,
  );

  printContractReport(logger, report);

  try {
    // RFC 0012: the mount is Fastify's own scope-prefix primitive on the one τjs registration.
    // `mounted` flips the plugin to its encapsulated form on a τjs-created host too - fastify-plugin
    // ignores `prefix` when it breaks encapsulation, and an encapsulated prefixed scope is also what
    // CONFINES the created-host shell to the mounted subtree (prefix-keyed not-found).
    await app.register(ssrServerPlugin({ callerOwnedHost, mounted: mountPrefix !== '' }), {
      prefix: mountPrefix || undefined,
      publicBasePath,
      hmrTransport,
      clientRoot,
      configs,
      routes,
      serviceRegistry: opts.serviceRegistry,
      // Passed through verbatim: `undefined` requests the default production registration and
      // explicit `false` is the opt-out, so coalescing here would erase the distinction.
      staticAssets: opts.staticAssets,
      debug: opts.debug,
      runtimeLogger,
      alias: opts.alias,
      projectRoot: opts.projectRoot,
      security,
      devNet: { host: net.host, hmrPort: net.hmrPort },
      taujsConfig: opts.config,
      introspectionAllowedHosts,
      // RFC 0010: the single caller-root exception, and the only value that reaches the plugin from
      // the caller's instance. Vite must observe development URLs Fastify did not route, which only
      // a root-level hook sees. Withheld unless the caller owns the host AND we are in development,
      // so production never receives the handle at all.
      viteRequestHookOwner: callerOwnedHost && isDevelopment ? app : undefined,
    });
  } catch (err) {
    logger.error(
      {
        step: 'register:SSRServer',
        error: normaliseError(err),
      },
      'Failed to register SSRServer',
    );

    // Boot must fail loudly: continuing here would return a server with no
    // routes that "starts" cleanly and 404s everything.
    throw err;
  }

  // RFC 0010: boot-graph emission moved into the owned scope alongside the dev files and recorder,
  // so it has one owner rather than a second registration site here. Its structural gate is
  // unchanged: it lives inside the `isDevelopment` branch of the SSR plugin behind a lazy dynamic
  // import, so in production the emission code is never loaded.

  const t1 = performance.now();

  // RFC 0010: presentation, not a log record. A caller-owned host receives no direct PRESENTATION
  // output. Its boot and error records still travel through the resolved logger, and when neither an
  // explicit logger nor an active Fastify logger exists that resolved logger is the released console
  // fallback - which writes to the console by design. The distinction is mediated records versus
  // unmediated presentation, not silence.
  if (!callerOwnedHost) console.log(`\n${pc.bgGreen(pc.black(` ${CONTENT.TAG} `))} configured in ${(t1 - t0).toFixed(0)}ms\n`);

  if (opts.fastify) return { net } as const;
  return { app, net } as const;
};
