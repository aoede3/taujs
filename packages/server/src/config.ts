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

import type { PluginOption } from 'vite';
import type { PathToRegExpParams, Route, RouteAttributes } from './types';

export { defineServiceRegistry, defineService } from './utils/DataServices';

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
  server?: { host?: string; port?: number; hmrPort?: number };
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
    if (appIds.length > 1) {
      warnings.push(`Route path "${path}" is declared in multiple apps: ${appIds.join(', ')}`);
    }
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
