import path from 'node:path';
import { performance } from 'node:perf_hooks';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import pc from 'picocolors';

import { extractBuildConfigs, extractRoutes, extractSecurity, printConfigSummary, printContractReport, printSecuritySummary } from './config';
import { CONTENT } from './constants';
import { bannerPlugin } from './network/network';
import { resolveNet } from './network/cli';
import { verifyContracts, isAuthRequired, hasAuthenticate, hasCSPSupport } from './security/verifyMiddleware';
import { SSRServer } from './SSRServer';
import { createLogger, Logger, type DebugCategory, type DebugConfig } from './utils/Logger';

import type { FastifyInstance, FastifyPluginAsync, FastifyPluginCallback } from 'fastify';
import type { TaujsConfig } from './config';
import type { NetResolved } from './network/cli';
import type { ServiceRegistry } from './utils/DataServices';

type StaticAssetsRegistration = {
  plugin: FastifyPluginCallback<any> | FastifyPluginAsync<any>;
  options?: Record<string, unknown>;
};

type CreateServerOptions = {
  config: TaujsConfig;
  serviceRegistry: ServiceRegistry;
  clientRoot?: string;
  alias?: Record<string, string>;
  fastify?: FastifyInstance;
  isDebug?: boolean | DebugConfig | ({ all: boolean } & Partial<Record<DebugCategory, boolean>>);
  registerStaticAssets?: false | StaticAssetsRegistration;
  port?: number;
};

type CreateServerResult = {
  app?: FastifyInstance;
  net: NetResolved;
};

// derive whether a specific debug category (e.g. "routes") is enabled
function isDebugCategoryEnabled(debug: CreateServerOptions['isDebug'], category: DebugCategory): boolean {
  if (!debug) return false;
  if (debug === true) return true;
  if (Array.isArray(debug)) return debug.includes(category);
  if (typeof debug === 'object') {
    if ('all' in debug && debug.all) return true;
    return Boolean((debug as Partial<Record<DebugCategory, boolean>>)[category]);
  }
  return false;
}

export const createServer = async (opts: CreateServerOptions): Promise<CreateServerResult> => {
  const t0 = performance.now();
  const clientRoot = opts.clientRoot ?? path.resolve(process.cwd(), 'client');
  const app = opts.fastify ?? Fastify({ logger: false });

  await app.register(bannerPlugin, { debug: opts.isDebug });

  // instantiate and configure the logger
  const logger = createLogger({
    debug: opts.isDebug, // can be true | "auth,routes,-vite" | your DebugConfig
    context: { service: 'taujs' },
    minLevel: 'info',
  });

  const net = resolveNet(opts.config.server);

  const configs = extractBuildConfigs(opts.config);
  const { routes, apps, totalRoutes, durationMs, warnings } = extractRoutes(opts.config);
  const { security, durationMs: securityDuration, hasExplicitCSP, summary } = extractSecurity(opts.config);

  // these helpers expect a "logger" with .log/.warn/.error;
  // map to our structured logger methods (log -> info)
  // const adapter: Logger = {
  //   log: (msg: string, meta?: unknown) => logger.info(msg, meta),
  //   warn: (msg: string, meta?: unknown) => logger.warn(msg, meta),
  //   error: (msg: string, meta?: unknown) => logger.error(msg, meta),
  // } as unknown as Logger;

  const routesDebug = isDebugCategoryEnabled(opts.isDebug, 'routes');

  // summaries
  printConfigSummary(logger, apps, routesDebug, configs.length, totalRoutes, durationMs, warnings);
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
        verify: hasCSPSupport,
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
      registerStaticAssets: opts.registerStaticAssets !== undefined ? opts.registerStaticAssets : { plugin: fastifyStatic },
      isDebug: opts.isDebug,
      alias: opts.alias,
      security,
      devNet: { host: net.host, hmrPort: net.hmrPort },
    });
  } catch (err) {
    logger.error('Failed to register SSRServer', {
      step: 'register:SSRServer',
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    });
  }

  const t1 = performance.now();
  logger.info(`\n${pc.bgGreen(pc.black(` ${CONTENT.TAG} `))} configured in ${(t1 - t0).toFixed(0)}ms\n`);

  if (opts.fastify) return { net } as const;
  return { app, net } as const;
};
