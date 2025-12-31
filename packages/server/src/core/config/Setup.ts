import { performance } from 'node:perf_hooks';

import type { PathToRegExpParams, Route, CoreAppConfig, CoreSecurityConfig, CoreTaujsConfig } from './types';

export type ExtractSecurityResult<S extends CoreSecurityConfig = CoreSecurityConfig> = {
  security: S;
  durationMs: number;
  hasExplicitCSP: boolean;
  summary: {
    mode: 'explicit' | 'dev-defaults';
    defaultMode: 'merge' | 'replace';
    hasReporting: boolean;
    reportOnly: boolean;
  };
};

export type ExtractRoutesResult = {
  routes: Route<PathToRegExpParams>[];
  apps: { appId: string; routeCount: number }[];
  totalRoutes: number;
  durationMs: number;
  warnings: string[];
};

export const extractBuildConfigs = <A extends CoreAppConfig = CoreAppConfig>(config: { apps: readonly A[] }): A[] => {
  return config.apps.map(({ appId, entryPoint, plugins }) => ({ appId, entryPoint, plugins })) as A[];
};

export const extractRoutes = (taujsConfig: CoreTaujsConfig): ExtractRoutesResult => {
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

export const extractSecurity = <S extends CoreSecurityConfig = CoreSecurityConfig>(
  taujsConfig: CoreTaujsConfig & { security?: S },
): ExtractSecurityResult<S> => {
  const t0 = performance.now();
  const user = (taujsConfig.security ?? {}) as S;
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

  const security = { csp: normalisedCsp } as S;

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

const computeScore = (path: string): number => {
  return path
    .split('/')
    .filter(Boolean)
    .reduce((score, segment) => score + (segment.startsWith(':') ? 1 : 10), 0);
};
