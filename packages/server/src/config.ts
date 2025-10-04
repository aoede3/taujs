/**
 * taujs [ τjs ] Orchestration System
 * (c) 2024-present Aoede Ltd
 * Author: John Smith
 *
 * Licensed under the MIT License — attribution appreciated.
 * Part of the taujs [ τjs ] system for declarative, build-time orchestration of microfrontend applications,
 * including CSR, SSR, streaming, and middleware composition.
 */

import { performance } from 'node:perf_hooks';

import { CONTENT } from './constants';

import type { ContractReport } from './security/VerifyMiddleware';
import type { FastifyRequest } from 'fastify';
import type { PluginOption } from 'vite';
import type { CSPDirectives } from './security/CSP';
import type { PathToRegExpParams, Route, RouteAttributes } from './types';
import type { DebugCategory, DebugConfig, Logger, Logs } from './logging/Logger';
import type { CSPViolationReport } from './security/CSPReporting';

export { defineServiceRegistry, defineService } from './utils/DataServices';

export type SecurityConfig = {
  csp?: {
    defaultMode?: 'merge' | 'replace';
    directives?: CSPDirectives;
    generateCSP?: (directives: CSPDirectives, nonce: string, req?: FastifyRequest) => string;
    reporting?: {
      endpoint: string;
      onViolation?: (report: CSPViolationReport, req: FastifyRequest) => void;
      reportOnly?: boolean;
    };
  };
};

export type ExtractSecurityResult = {
  security: SecurityConfig;
  durationMs: number;
  hasExplicitCSP: boolean;
  summary: {
    defaultMode: 'merge' | 'replace';
    hasReporting: boolean;
    reportOnly: boolean;
  };
};

export type AppRoute = Omit<Route<PathToRegExpParams>, 'appId'> & {
  attr?: RouteAttributes<PathToRegExpParams>;
};

export type AppConfig = {
  appId: string;
  entryPoint: string;
  plugins?: PluginOption[];
  routes?: AppRoute[];
};

export type TaujsConfig = {
  server?: {
    host?: string;
    port?: number;
    hmrPort?: number;
  };
  security?: SecurityConfig;
  apps: AppConfig[];
};

export type ExtractRoutesResult = {
  routes: Route<PathToRegExpParams>[];
  apps: { appId: string; routeCount: number }[];
  totalRoutes: number;
  durationMs: number;
  warnings: string[];
};

export const extractBuildConfigs = (config: { apps: { appId: string; entryPoint: string; plugins?: PluginOption[] }[] }): AppConfig[] => {
  return config.apps.map(({ appId, entryPoint, plugins }) => ({
    appId,
    entryPoint,
    plugins,
  }));
};

export const extractRoutes = (taujsConfig: TaujsConfig): ExtractRoutesResult => {
  const t0 = performance.now();
  const allRoutes: Route<PathToRegExpParams>[] = [];
  const apps: { appId: string; routeCount: number }[] = [];
  const warnings: string[] = [];
  const pathTracker = new Map<string, string[]>();

  for (const app of taujsConfig.apps) {
    const appRoutes = (app.routes ?? []).map((route) => {
      const fullRoute: Route<PathToRegExpParams> = { ...route, appId: app.appId };

      if (!pathTracker.has(route.path)) pathTracker.set(route.path, []);
      pathTracker.get(route.path)!.push(app.appId);

      return fullRoute;
    });

    apps.push({ appId: app.appId, routeCount: appRoutes.length });
    allRoutes.push(...appRoutes);
  }

  for (const [path, appIds] of pathTracker.entries()) {
    if (appIds.length > 1) warnings.push(`Route path "${path}" is declared in multiple apps: ${appIds.join(', ')}`);
  }

  const sortedRoutes = allRoutes.sort((a, b) => computeScore(b.path) - computeScore(a.path));
  const durationMs = performance.now() - t0;

  return {
    routes: sortedRoutes,
    apps,
    totalRoutes: allRoutes.length,
    durationMs,
    warnings,
  };
};

export const extractSecurity = (taujsConfig: TaujsConfig): ExtractSecurityResult => {
  const t0 = performance.now();
  const user = taujsConfig.security ?? {};
  const userCsp = user.csp;

  const hasExplicitCSP = !!userCsp;

  const normalisedCsp = userCsp
    ? {
        defaultMode: userCsp.defaultMode ?? 'merge',
        directives: userCsp.directives,
        generateCSP: userCsp.generateCSP,
        reporting: userCsp.reporting
          ? {
              endpoint: userCsp.reporting.endpoint,
              onViolation: userCsp.reporting.onViolation,
              reportOnly: userCsp.reporting.reportOnly ?? false,
            }
          : undefined,
      }
    : undefined;

  const security: SecurityConfig = { csp: normalisedCsp };

  const summary = {
    mode: hasExplicitCSP ? ('explicit' as const) : ('dev-defaults' as const),
    defaultMode: normalisedCsp?.defaultMode ?? 'merge',
    hasReporting: !!normalisedCsp?.reporting?.endpoint,
    reportOnly: !!normalisedCsp?.reporting?.reportOnly,
  };

  const durationMs = performance.now() - t0;

  return {
    security,
    durationMs,
    hasExplicitCSP,
    summary,
  };
};

export type SecurityStartupLine = {
  hasExplicitCSP: boolean;
  securityDurationMs: number;
  defaultMode: 'merge' | 'replace';
  hasReporting: boolean;
  reportOnly: boolean;
};

export function printConfigSummary(
  logger: Logger,
  apps: { appId: string; routeCount: number }[],
  configsCount: number,
  totalRoutes: number,
  durationMs: number,
  warnings: string[],
) {
  logger.info(`${CONTENT.TAG} [config] Loaded ${configsCount} app(s), ${totalRoutes} route(s) in ${durationMs.toFixed(1)}ms`);

  apps.forEach((a) => logger.debug('routes', `• ${a.appId}: ${a.routeCount} route(s)`));

  warnings.forEach((w) => logger.warn(`${CONTENT.TAG} [warn] ${w}`));
}

export function printSecuritySummary(logger: Logger, routes: Route[], security: SecurityConfig, hasExplicitCSP: boolean, securityDurationMs: number) {
  const total = routes.length;
  const disabled = routes.filter((r) => r.attr?.middleware?.csp === false).length;
  const custom = routes.filter((r) => {
    const v = r.attr?.middleware?.csp;
    return v !== undefined && v !== false;
  }).length;
  const enabled = total - disabled;

  const hasReporting = !!security.csp?.reporting?.endpoint;
  const mode = security.csp?.defaultMode ?? 'merge';

  let status = 'configured';
  let detail = '';

  if (hasExplicitCSP) {
    detail = `explicit, mode=${mode}`;
    if (hasReporting) detail += ', reporting';
    if (custom > 0) detail += `, ${custom} route override(s)`;
  } else {
    if (process.env.NODE_ENV === 'production') {
      logger.warn('(consider explicit config for production)');
    }
  }

  logger.info(`${CONTENT.TAG} [security] CSP ${status} (${enabled}/${total} routes) in ${securityDurationMs.toFixed(1)}ms`);
}

export function printContractReport(logger: Logger, report: ContractReport) {
  for (const r of report.items) {
    const line = `${CONTENT.TAG} [${r.key}] ${r.message}`;

    if (r.status === 'error') {
      logger.error(line);
    } else if (r.status === 'warning') {
      logger.warn(line);
    } else if (r.status === 'skipped') {
      logger.debug(r.key as DebugCategory, line);
    } else {
      logger.info(line);
    }
  }
}

const computeScore = (path: string): number => {
  return path
    .split('/')
    .filter(Boolean)
    .reduce((score, segment) => score + (segment.startsWith(':') ? 1 : 10), 0);
};

export function createConfig<T extends TaujsConfig>(config: T): T {
  if (!config.apps || config.apps.length === 0) throw new Error('At least one app must be configured');

  return config;
}
