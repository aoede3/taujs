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

import pc from 'picocolors';

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
  apps: AppConfig[];
};

export const extractBuildConfigs = (config: { apps: { appId: string; entryPoint: string; plugins?: PluginOption[] }[] }): AppConfig[] => {
  return config.apps.map(({ appId, entryPoint, plugins }) => ({
    appId,
    entryPoint,
    plugins,
  }));
};

export const extractRoutes = (taujsConfig: TaujsConfig): Route<PathToRegExpParams>[] => {
  console.log(pc.bold('Preparing τjs [taujs]'));
  const t0 = performance.now();

  try {
    const allRoutes: Route<PathToRegExpParams>[] = [];
    const pathTracker = new Map<string, string[]>();
    let totalRoutes = 0;

    for (const app of taujsConfig.apps) {
      const appRoutes = (app.routes ?? []).map((route) => {
        const fullRoute: Route<PathToRegExpParams> = { ...route, appId: app.appId };

        if (!pathTracker.has(route.path)) pathTracker.set(route.path, []);
        pathTracker.get(route.path)!.push(app.appId);

        return fullRoute;
      });

      console.log(pc.gray(` • ${app.appId}: ${appRoutes.length} route(s)`));

      allRoutes.push(...appRoutes);
      totalRoutes += appRoutes.length;
    }

    for (const [path, appIds] of pathTracker.entries()) {
      if (appIds.length > 1) console.warn(pc.yellow(`⚠️ Route path "${path}" is declared in multiple apps: ${appIds.join(', ')} – order may affect matching`));
    }

    const sortedRoutes = allRoutes.sort((a, b) => computeScore(b.path) - computeScore(a.path));
    const t1 = performance.now();

    console.log(pc.green(`Prepared ${totalRoutes} route(s) in ${(t1 - t0).toFixed(1)}ms`));

    return sortedRoutes;
  } catch (err) {
    console.log(pc.red('Failed to prepare routes'));
    throw err;
  }
};

const computeScore = (path: string): number => {
  return path
    .split('/')
    .filter(Boolean)
    .reduce((score, segment) => score + (segment.startsWith(':') ? 1 : 10), 0);
};
