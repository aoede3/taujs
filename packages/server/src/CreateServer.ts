import path from 'node:path';
import { performance } from 'node:perf_hooks';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import pc from 'picocolors';

import { extractBuildConfigs, extractRoutes } from './config';
import { CONTENT } from './constants';
import { verifyContracts, isAuthRequired, hasAuthenticate, isCSPDeclared } from './security/verifyMiddleware';
import { SSRServer } from './SSRServer';
import { createLogger, normaliseDebug } from './utils/Logger';

import { bannerPlugin } from './network/network';
import { resolveNet } from './network/cli';

import type { FastifyInstance, FastifyPluginAsync, FastifyPluginCallback } from 'fastify';
import type { TaujsConfig } from './config';
import type { NetResolved } from './network/cli';
import type { ServiceRegistry } from './utils/DataServices';
import type { DebugCategory, DebugConfig } from './utils/Logger';

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

type CreateServerResult = { app?: FastifyInstance; net: NetResolved };

export const createServer = async (opts: CreateServerOptions): Promise<CreateServerResult> => {
  const t0 = performance.now();
  const clientRoot = opts.clientRoot ?? path.resolve(process.cwd(), 'client');

  const app = opts.fastify ?? Fastify({ logger: false });
  await app.register(bannerPlugin, { debug: opts.isDebug });

  const logger = createLogger(opts.isDebug);
  const dbg = normaliseDebug(opts.isDebug);

  // 🔹 Resolve network once, up front
  const net = resolveNet(opts.config.server);

  // configs + routes
  const buildConfigs = extractBuildConfigs(opts.config);
  const { routes, apps, totalRoutes, durationMs, warnings } = extractRoutes(opts.config);

  console.log(pc.cyan(`${CONTENT.TAG} [config] Loaded ${buildConfigs.length} app(s)`));

  apps.forEach((a) => {
    if (dbg.routes) logger.log(`• ${a.appId}: ${a.routeCount} route(s)`);
  });

  console.log(pc.cyan(`${CONTENT.TAG} [routes] Prepared ${totalRoutes} route(s) in ${durationMs.toFixed(1)}ms`));

  warnings.forEach((w) => logger.warn(pc.yellow(`${CONTENT.TAG} [warn] ${w}`)));

  // contracts
  const results = verifyContracts(app, routes, [
    { key: 'auth', required: isAuthRequired, verify: hasAuthenticate, errorMessage: 'Routes require auth but Fastify is missing .authenticate decorator.' },
    { key: 'csp', required: isCSPDeclared, verify: () => true, errorMessage: 'Routes declare CSP but no CSP handler is registered.' },
  ]);

  results.forEach((r) => {
    const line = `${CONTENT.TAG} [${r.key}] ${r.message}`;

    if (r.status === 'error') {
      logger.error(pc.red(line));
    } else if (r.status === 'skipped') {
      logger.warn(pc.cyan(line));
    } else {
      console.log(pc.green(line));
    }
  });

  try {
    await app.register(SSRServer, {
      clientRoot,
      configs: buildConfigs,
      routes,
      serviceRegistry: opts.serviceRegistry,
      registerStaticAssets: opts.registerStaticAssets !== undefined ? opts.registerStaticAssets : { plugin: fastifyStatic },
      isDebug: opts.isDebug,
      alias: opts.alias,

      // 🔹 pass net to SSR so DevServer can set HMR host/port consistently
      devNet: { host: net.host, hmrPort: net.hmrPort }, // <— add this option to SSRServer options
    });
  } catch (err) {
    logger.serviceError(err, { step: 'register:SSRServer' });
  }

  const t1 = performance.now();
  console.log(`\n${pc.bgGreen(pc.black(` ${CONTENT.TAG} `))} configured in ${(t1 - t0).toFixed(0)}ms\n`);

  if (opts.fastify) return { net } as const; // caller already owns the instance

  return { app, net } as const; // we created it, so return it
};
