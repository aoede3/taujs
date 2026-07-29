import path from 'node:path';
import { performance } from 'node:perf_hooks';

import Fastify from 'fastify';
import pc from 'picocolors';

import { extractBuildConfigs, extractRoutes, extractSecurity } from './core/config/Setup';
import { normaliseError } from './core/errors/AppError';

import { CONTENT } from './constants';
import { createRuntimeLogger, type RuntimeLoggerSelection } from './logging/RuntimeLogger';
import { resolveNet } from './network/CLI';
import { bannerPlugin } from './network/Network';
import { verifyContracts, isAuthRequired, hasAuthenticate } from './security/VerifyMiddleware';
import { printConfigSummary, printContractReport, printSecuritySummary } from './Setup';
import { ssrServerPlugin } from './SSRServer';
import { isDevelopment } from './System';

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

  if (process.env.NODE_ENV === 'production') return path.resolve(cwd, 'dist/client');

  return path.resolve(cwd, 'src/client');
};

export const createServer = async (opts: CreateServerOptions): Promise<CreateServerResult> => {
  const t0 = performance.now();
  const clientRoot = resolveClientRoot(opts.clientRoot);

  // RFC 0010: the one internal ownership fact. Supplying a Fastify instance means the caller owns
  // the server and τjs owns only an encapsulated scope within it; omitting one means τjs created
  // the server and provides the complete experience. Derived here, never a public option, and never
  // threaded through plugin options - it selects the registration form below, so the form and the
  // behaviour cannot drift apart.
  const callerOwnedHost = opts.fastify !== undefined;

  const app = opts.fastify ?? Fastify({ logger: false });
  const fastifyLogger = app.log && app.log.level && app.log.level !== 'silent' ? app.log : undefined;
  const runtimeLogger: RuntimeLoggerSelection = {
    source: opts.logger ? 'explicit' : fastifyLogger ? 'fastify' : 'fallback',
    debug: opts.debug,
    custom: opts.logger ?? fastifyLogger,
    minLevel: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
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
  // CSP or trace headers changed.
  logger.info(
    { component: 'ownership', callerOwnedHost },
    callerOwnedHost
      ? `${CONTENT.TAG} [ownership] Fastify supplied by caller - τjs owns its declared routes in an encapsulated scope; host errors, not-found, CSP and trace remain yours`
      : `${CONTENT.TAG} [ownership] Fastify created by τjs - whole-server shell, CSP and trace`,
  );

  // RFC security model §2: relaxing the loopback guard must shout in the boot summary —
  // exact text, not a debug line.
  if (isDevelopment && opts.config.introspection?.allowNonLoopback) {
    logger.warn({ component: 'introspection' }, 'τjs introspection overlay exposed to non-loopback clients. For trusted dev networks only.');
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
    await app.register(ssrServerPlugin({ callerOwnedHost }), {
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
