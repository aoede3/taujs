import path from 'node:path';
import { performance } from 'node:perf_hooks';

import Fastify from 'fastify';
import pc from 'picocolors';

import { extractBuildConfigs, extractRoutes, extractSecurity } from './core/config/Setup';
import { normaliseError } from './core/errors/AppError';

import { CONTENT } from './constants';
import { createLogger } from './logging/Logger';
import { resolveNet } from './network/CLI';
import { bannerPlugin } from './network/Network';
import { verifyContracts, isAuthRequired, hasAuthenticate } from './security/VerifyMiddleware';
import { printConfigSummary, printContractReport, printSecuritySummary } from './Setup';
import { SSRServer } from './SSRServer';
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
  staticAssets?: false | StaticAssetsRegistration;
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

  const app = opts.fastify ?? Fastify({ logger: false });
  const fastifyLogger = app.log && app.log.level && app.log.level !== 'silent' ? app.log : undefined;
  const logger = createLogger({
    debug: opts.debug,
    custom: opts.logger ?? fastifyLogger,
    minLevel: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    includeContext: true,
  });

  const net = resolveNet(opts.config.server);
  await app.register(bannerPlugin, {
    debug: opts.debug,
    hmr: { host: net.host, port: net.hmrPort },
  });

  const configs = extractBuildConfigs(opts.config);
  const { routes, apps, totalRoutes, durationMs } = extractRoutes(opts.config);
  const { security, durationMs: securityDuration, hasExplicitCSP } = extractSecurity(opts.config);

  printConfigSummary(logger, apps, configs.length, totalRoutes, durationMs);
  printSecuritySummary(logger, routes, security, hasExplicitCSP, securityDuration);

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
    await app.register(SSRServer, {
      clientRoot,
      configs,
      routes,
      serviceRegistry: opts.serviceRegistry,
      staticAssets: opts.staticAssets ?? false,
      debug: opts.debug,
      alias: opts.alias,
      projectRoot: opts.projectRoot,
      security,
      devNet: { host: net.host, hmrPort: net.hmrPort },
      taujsConfig: opts.config,
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

  // Structural gate (RFC security model §1): in production this branch never runs, so the
  // introspection emission code is never even loaded — absence, not a disabled flag.
  if (isDevelopment) {
    try {
      const { registerBootGraphEmission } = await import('./core/introspection/EmitGraph');
      registerBootGraphEmission(app, opts.config, opts.serviceRegistry, logger);
    } catch (err) {
      logger.warn({ component: 'introspection', error: normaliseError(err) }, 'Graph emission unavailable (non-fatal)');
    }
  }

  const t1 = performance.now();
  console.log(`\n${pc.bgGreen(pc.black(` ${CONTENT.TAG} `))} configured in ${(t1 - t0).toFixed(0)}ms\n`);

  if (opts.fastify) return { net } as const;
  return { app, net } as const;
};
