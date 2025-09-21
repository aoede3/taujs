// @taujs/server/CreateServer.ts
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import pc from 'picocolors';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { extractBuildConfigs, extractRoutes } from './config';
import { verifyContracts, isAuthRequired, hasAuthenticate, isCSPDeclared } from './security/verifyMiddleware';
import { SSRServer } from './SSRServer';

import type { FastifyInstance, FastifyPluginAsync, FastifyPluginCallback } from 'fastify';
import type { TaujsConfig } from './config';
import type { ServiceRegistry } from './utils/DataServices';
import type { DebugCategory, DebugConfig } from './utils/Logger';

export type CreateServerOptions = {
  config: TaujsConfig;
  serviceRegistry: ServiceRegistry;
  clientRoot?: string;
  alias?: Record<string, string>;
  fastify?: FastifyInstance;
  isDebug?: DebugConfig | ({ all: boolean } & Partial<Record<DebugCategory, boolean>>);
  registerStaticAssets?:
    | false
    | {
        plugin: FastifyPluginCallback<any> | FastifyPluginAsync<any>;
        options?: Record<string, unknown>;
      };
};

export const createServer = async (opts: CreateServerOptions): Promise<FastifyInstance> => {
  const t0 = performance.now();
  const clientRoot = opts.clientRoot ?? path.resolve(process.cwd(), 'client');

  // use provided instance or create a new one — we DO NOT listen here
  const app = opts.fastify ?? Fastify({ logger: false });

  // configs + routes
  const buildConfigs = extractBuildConfigs(opts.config);
  const { routes, apps, totalRoutes, durationMs, warnings } = extractRoutes(opts.config);

  console.log(pc.cyan(`[τjs] [config] Loaded ${buildConfigs.length} app(s)`));
  apps.forEach((a) => console.log(pc.gray(` • ${a.appId}: ${a.routeCount} route(s)`)));
  console.log(pc.cyan(`[τjs] [routes] Prepared ${totalRoutes} route(s) in ${durationMs.toFixed(1)}ms`));
  warnings.forEach((w) => console.warn(pc.yellow(`[τjs] [warn] ${w}`)));

  // contracts
  const results = verifyContracts(app, routes, [
    { key: 'auth', required: isAuthRequired, verify: hasAuthenticate, errorMessage: 'Routes require auth but Fastify is missing `.authenticate` decorator.' },
    { key: 'csp', required: isCSPDeclared, verify: () => true, errorMessage: 'Routes declare CSP but no CSP handler is registered.' },
  ]);
  results.forEach((r) => {
    const color = r.status === 'error' ? pc.red : r.status === 'skipped' ? pc.cyan : pc.green;
    console.log(color(`[τjs] [${r.key}] ${r.message}`));
  });

  await app.register(SSRServer, {
    clientRoot,
    configs: buildConfigs,
    routes,
    serviceRegistry: opts.serviceRegistry,
    registerStaticAssets: opts.registerStaticAssets !== undefined ? opts.registerStaticAssets : { plugin: fastifyStatic },
    isDebug: opts.isDebug,
    alias: opts.alias,
  });

  const t1 = performance.now();
  console.log('\n' + pc.bgGreen(pc.black(' τjs ')) + ` configured in ${(t1 - t0).toFixed(0)}ms\n`);

  return app;
};
