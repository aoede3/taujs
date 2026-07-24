import { now } from '../telemetry/Telemetry';

import type { RouteParams, Route, CoreAppConfig, CoreSecurityConfig, CoreTaujsConfig } from './types';

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
  routes: Route<RouteParams>[];
  apps: { appId: string; routeCount: number }[];
  totalRoutes: number;
  durationMs: number;
  warnings: string[];
};

export const extractBuildConfigs = <A extends CoreAppConfig = CoreAppConfig>(config: { apps: readonly A[] }): A[] => {
  // Renderer v1: `renderer` is picked alongside {appId, entryPoint, plugins} so the app's contribution
  // survives into the build carriage (it is dropped if omitted from this projection).
  return config.apps.map(({ appId, entryPoint, plugins, renderer }) => ({ appId, entryPoint, plugins, renderer })) as A[];
};

// This is deliberately a migration lint, not a second route parser. Fastify remains the only
// authority for valid route syntax. These are stale path-to-regexp forms that Fastify may accept
// as literals (or with materially different semantics), allowing a formerly live route to die
// silently after the native-route migration.
const assertNoLegacyRouteSyntax = (path: string, appId: string): void => {
  // Fastify regexp constraints may legitimately contain quantifiers such as `(^\\d{4})`.
  // Only braces outside a regexp constraint are path-to-regexp optional-group syntax.
  let regexpDepth = 0;
  let hasOptionalGroup = false;
  for (let i = 0; i < path.length; i += 1) {
    const char = path[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '(') {
      regexpDepth += 1;
      continue;
    }
    if (char === ')') {
      regexpDepth = Math.max(0, regexpDepth - 1);
      continue;
    }
    if (regexpDepth === 0 && (char === '{' || char === '}')) {
      hasOptionalGroup = true;
      break;
    }
  }

  const hasNamedWildcard = /(^|\/)\*[A-Za-z0-9_]/.test(path);
  const hasLegacyParameterModifier = /:[A-Za-z0-9_]+[+*](?=\/|$)/.test(path);
  const hasNonTerminalOptionalParameter = /:[A-Za-z0-9_]+\?(?=\/)/.test(path);

  if (hasOptionalGroup || hasNamedWildcard || hasLegacyParameterModifier || hasNonTerminalOptionalParameter) {
    throw new Error(
      `Route "${path}" (app "${appId}") uses legacy path-to-regexp syntax. ` +
        'Route paths now use Fastify syntax; use a terminal "/*" wildcard, a terminal optional parameter, or declare explicit routes.',
    );
  }
};

export const extractRoutes = (taujsConfig: CoreTaujsConfig): ExtractRoutesResult => {
  const t0 = now();
  const allRoutes: Route<RouteParams>[] = [];
  const apps: { appId: string; routeCount: number }[] = [];
  // Retained in the extraction/report shape for compatibility with the existing boot summary.
  // Route ambiguity now fails closed, so this migration currently emits no warning-only cases.
  const warnings: string[] = [];
  const pathTracker = new Map<string, string[]>();

  for (const app of taujsConfig.apps) {
    const appRoutes = (app.routes ?? []).map((route) => {
      assertNoLegacyRouteSyntax(route.path, app.appId);

      // RFC 0004 (H1): validate `attr.head` at BOOT - misconfiguration fails fast, before any
      // request depends on it. `timeoutMs` must be POSITIVE FINITE (ruling 3: the head blocks
      // the shell, so there is deliberately no 0/Infinity wait-forever sentinel).
      const head = (route.attr as { head?: { data?: unknown; timeoutMs?: unknown; optional?: unknown } } | undefined)?.head;
      if (head !== undefined) {
        const at = `Route "${route.path}" (app "${app.appId}")`;
        if (typeof head.data !== 'function') throw new Error(`${at}: attr.head.data must be a function (a data handler or serviceData(...) sugar)`);
        if (head.timeoutMs !== undefined && !(typeof head.timeoutMs === 'number' && Number.isFinite(head.timeoutMs) && head.timeoutMs > 0)) {
          throw new Error(`${at}: attr.head.timeoutMs must be a positive finite number of milliseconds (received ${String(head.timeoutMs)})`);
        }
        if (head.optional !== undefined && typeof head.optional !== 'boolean') {
          throw new Error(`${at}: attr.head.optional must be a boolean (received ${String(head.optional)})`);
        }
      }

      const fullRoute: Route<RouteParams> = { ...route, appId: app.appId };

      if (!pathTracker.has(route.path)) pathTracker.set(route.path, []);
      pathTracker.get(route.path)!.push(app.appId);

      return fullRoute;
    });

    apps.push({ appId: app.appId, routeCount: appRoutes.length });
    allRoutes.push(...appRoutes);
  }

  for (const [path, appIds] of pathTracker.entries()) {
    if (appIds.length > 1) {
      throw new Error(`Route path "${path}" is declared more than once by: ${appIds.join(', ')}`);
    }
  }
  const durationMs = now() - t0;

  return {
    routes: allRoutes,
    apps,
    totalRoutes: allRoutes.length,
    durationMs,
    warnings,
  };
};

export const extractSecurity = <S extends CoreSecurityConfig = CoreSecurityConfig>(
  taujsConfig: CoreTaujsConfig & { security?: S },
): ExtractSecurityResult<S> => {
  const t0 = now();
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

  const durationMs = now() - t0;

  return {
    security,
    durationMs,
    hasExplicitCSP,
    summary,
  };
};
