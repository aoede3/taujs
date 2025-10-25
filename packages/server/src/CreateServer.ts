import path from 'node:path';
import { performance } from 'node:perf_hooks';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import pc from 'picocolors';

import { extractBuildConfigs, extractRoutes, extractSecurity, printConfigSummary, printContractReport, printSecuritySummary } from './Setup';
import { CONTENT } from './constants';
import { bannerPlugin } from './network/Network';
import { resolveNet } from './network/CLI';
import { verifyContracts, isAuthRequired, hasAuthenticate } from './security/VerifyMiddleware';
import { SSRServer } from './SSRServer';
import { normaliseError } from './logging/AppError';
import { createLogger } from './logging/Logger';

import type { FastifyInstance } from 'fastify';
import type { TaujsConfig } from './Config';
import type { BaseLogger, DebugConfig } from './logging/Logger';
import type { NetResolved } from './network/CLI';
import type { ServiceRegistry } from './utils/DataServices';
import type { StaticAssetsRegistration } from './utils/StaticAssets';

type CreateServerOptions = {
  config: TaujsConfig;
  serviceRegistry: ServiceRegistry;
  clientRoot?: string;
  alias?: Record<string, string>;
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

export const createServer = async (opts: CreateServerOptions): Promise<CreateServerResult> => {
  const t0 = performance.now();
  const clientRoot = opts.clientRoot ?? path.resolve(process.cwd(), 'client');
  const app = opts.fastify ?? Fastify({ logger: false });

  const net = resolveNet(opts.config.server);
  await app.register(bannerPlugin, {
    debug: opts.debug,
    hmr: { host: net.host, port: net.hmrPort },
  });

  const logger = createLogger({
    debug: opts.debug,
    custom: opts.logger,
    minLevel: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    includeContext: true,
  });

  const configs = extractBuildConfigs(opts.config);
  const { routes, apps, totalRoutes, durationMs, warnings } = extractRoutes(opts.config);
  const { security, durationMs: securityDuration, hasExplicitCSP } = extractSecurity(opts.config);

  printConfigSummary(logger, apps, configs.length, totalRoutes, durationMs, warnings);
  printSecuritySummary(logger, routes, security, hasExplicitCSP, securityDuration);

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
      staticAssets: opts.staticAssets !== undefined ? opts.staticAssets : { plugin: fastifyStatic },
      debug: opts.debug,
      alias: opts.alias,
      security,
      devNet: { host: net.host, hmrPort: net.hmrPort },
    });
  } catch (err) {
    logger.error(
      {
        step: 'register:SSRServer',
        error: normaliseError(err),
      },
      'Failed to register SSRServer',
    );
  }

  const t1 = performance.now();
  console.log(`\n${pc.bgGreen(pc.black(` ${CONTENT.TAG} `))} configured in ${(t1 - t0).toFixed(0)}ms\n`);

  if (opts.fastify) return { net } as const;
  return { app, net } as const;
};
