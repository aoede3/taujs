import pkg from '../../../package.json';
import { RENDERTYPE } from '../constants';
import { extractSecurity } from '../config/Setup';
import { calculateSpecificity } from '../routes/DataRoutes';
import { getServiceMethodMetadata } from '../services/DataServices';
import { getServiceDataMetadata } from '../services/ServiceData';

import type { CoreTaujsConfig } from '../config/types';
import type { ServiceRegistry } from '../services/DataServices';

export type GraphSource = 'boot' | 'build';

export type GraphSchemaFlag = { declared: boolean; kind?: 'parse' | 'function' };

export type GraphWarningCode = 'routes.duplicate_path' | 'streaming.missing_meta' | 'render.defaulted' | 'csp.dev_directives' | 'fallthrough.unreachable';

export type GraphWarning = {
  code: GraphWarningCode;
  severity: 'error' | 'warn' | 'info';
  source: 'extract-routes' | 'security' | 'graph';
  routeId?: string;
  message?: string;
};

export type GraphRouteData = { kind: 'none' } | { kind: 'dynamic' } | { kind: 'service'; service: string; method: string };

export type GraphRouteCSP =
  { declared: false } | { declared: true; disabled: 'hard' | 'soft' } | { declared: true; mode: 'merge' | 'replace'; dynamic: boolean; reportOnly: boolean };

export type GraphRoute = {
  id: string;
  appId: string;
  path: string;
  render: { strategy: 'ssr' | 'streaming'; defaulted: boolean };
  hydrate: { enabled: boolean; defaulted: boolean };
  specificity: number;
  middleware: { auth: { declared: boolean }; csp: GraphRouteCSP };
  data: GraphRouteData;
};

export type GraphUsedBy = { routeId: string; appId: string; path: string };

export type GraphServiceMethod = { name: string; params: GraphSchemaFlag; result: GraphSchemaFlag; usedBy: GraphUsedBy[] };

export type GraphService = { name: string; methods: GraphServiceMethod[] };

export type RequestGraph = {
  schemaVersion: 1;
  taujs: { server: string };
  source: GraphSource;
  emittedAt: string;
  disclosure: 'conservative';
  apps: { appId: string; entryPoint: string; routeCount: number }[];
  routes: GraphRoute[];
  services: GraphService[] | null;
  security: { cspDefaultMode: 'merge' | 'replace'; reporting: boolean };
  fallthrough: { mode: 'spa'; appId: string; assetLike: 404; reachable: boolean };
  warnings: GraphWarning[];
};

// `source`/`emittedAt` are caller-supplied so this function owns no clock: same inputs,
// byte-identical graph (spec 02 emission rules).
export type CreateRequestGraphOptions = {
  source: GraphSource;
  emittedAt: string;
  serviceRegistry?: ServiceRegistry;
};

const isMatchAllWildcard = (path: string): boolean => path === '/*' || path === '*';

// Pure, deterministic, no I/O. Serialises the resolved config into spec 02 schema v1 —
// nothing here executes data handlers or touches a server instance; declared route → service
// edges come only from the P0A-01/P0A-02 metadata accessors.
export function createRequestGraph(config: CoreTaujsConfig, options: CreateRequestGraphOptions): RequestGraph {
  const firstApp = config.apps[0];
  if (!firstApp) throw new Error('At least one app must be configured');

  const warnings: GraphWarning[] = [];

  const apps = config.apps.map((app) => ({
    appId: app.appId,
    entryPoint: app.entryPoint,
    routeCount: app.routes?.length ?? 0,
  }));

  // Same duplicate semantics as extractRoutes' pathTracker (Setup.ts): the exact path
  // string declared more than once, across or within apps.
  const pathTracker = new Map<string, string[]>();
  const routes: GraphRoute[] = [];

  for (const app of config.apps) {
    for (const route of app.routes ?? []) {
      const attr = route.attr;
      const id = `${app.appId}:${route.path}`;

      if (!pathTracker.has(route.path)) pathTracker.set(route.path, []);
      pathTracker.get(route.path)!.push(app.appId);

      // Effective values mirror the runtime defaults: HandleRender.ts `attr?.render ??
      // RENDERTYPE.ssr` and `attr?.hydrate !== false`.
      const strategy = attr?.render ?? RENDERTYPE.ssr;
      const renderDefaulted = attr?.render === undefined;

      const csp = attr?.middleware?.csp;
      const cspBlock: GraphRouteCSP =
        csp === undefined
          ? { declared: false }
          : csp === false
            ? { declared: true, disabled: 'hard' }
            : csp.disabled
              ? { declared: true, disabled: 'soft' }
              : {
                  declared: true,
                  // Effective per-route mode: CSP.ts applies 'replace' only when explicit,
                  // otherwise merges — the global defaultMode does not participate here.
                  mode: csp.mode === 'replace' ? 'replace' : 'merge',
                  dynamic: typeof csp.directives === 'function',
                  reportOnly: Boolean(csp.reportOnly),
                };

      // Mirrors fetchInitialData's own guard: a non-function `data` is ignored at runtime.
      const dataHandler = attr?.data;
      let data: GraphRouteData = { kind: 'none' };
      if (dataHandler && typeof dataHandler === 'function') {
        const meta = getServiceDataMetadata(dataHandler);
        data = meta ? { kind: 'service', service: meta.serviceName, method: meta.serviceMethod } : { kind: 'dynamic' };
      }

      routes.push({
        id,
        appId: app.appId,
        path: route.path,
        render: { strategy, defaulted: renderDefaulted },
        hydrate: { enabled: attr?.hydrate !== false, defaulted: attr?.hydrate === undefined },
        specificity: calculateSpecificity(route.path),
        middleware: { auth: { declared: Boolean(attr?.middleware?.auth) }, csp: cspBlock },
        data,
      });

      if (renderDefaulted) {
        warnings.push({
          code: 'render.defaulted',
          severity: 'warn',
          source: 'extract-routes',
          routeId: id,
          message: `Route "${route.path}" declares no render strategy; runtime default "${RENDERTYPE.ssr}" applies`,
        });
      }

      if (strategy === RENDERTYPE.streaming && !attr?.meta) {
        warnings.push({
          code: 'streaming.missing_meta',
          severity: 'error',
          source: 'extract-routes',
          routeId: id,
          message: `Streaming route "${route.path}" has no meta`,
        });
      }
    }
  }

  routes.sort((a, b) => a.appId.localeCompare(b.appId) || b.specificity - a.specificity || a.path.localeCompare(b.path));

  for (const [path, appIds] of pathTracker.entries()) {
    if (appIds.length > 1) {
      warnings.push({
        code: 'routes.duplicate_path',
        severity: 'error',
        source: 'extract-routes',
        message: `Route path "${path}" is declared in multiple apps: ${appIds.join(', ')}`,
      });
    }
  }

  let services: GraphService[] | null = null;
  if (options.serviceRegistry) {
    services = Object.entries(options.serviceRegistry)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([serviceName, definition]) => ({
        name: serviceName,
        methods: Object.entries(definition)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([methodName, method]) => {
            // undefined metadata (hand-rolled registry, frozen handler) is an honest gap:
            // no schema is visibly declared.
            const meta = getServiceMethodMetadata(method);

            return {
              name: methodName,
              params: { ...(meta?.params ?? { declared: false }) },
              result: { ...(meta?.result ?? { declared: false }) },
              usedBy: routes
                .filter((r) => r.data.kind === 'service' && r.data.service === serviceName && r.data.method === methodName)
                .map((r) => ({ routeId: r.id, appId: r.appId, path: r.path })),
            };
          }),
      }));
  }

  const { hasExplicitCSP, summary } = extractSecurity(config);
  const security = { cspDefaultMode: summary.defaultMode, reporting: summary.hasReporting };

  if (!hasExplicitCSP) {
    warnings.push({
      code: 'csp.dev_directives',
      severity: 'warn',
      source: 'security',
      message: 'No security.csp configured; development default CSP directives apply',
    });
  }

  const wildcardRoute = routes.find((r) => isMatchAllWildcard(r.path));
  const fallthrough = {
    mode: 'spa' as const,
    appId: firstApp.appId,
    assetLike: 404 as const,
    reachable: !wildcardRoute,
  };

  if (wildcardRoute) {
    warnings.push({
      code: 'fallthrough.unreachable',
      severity: 'info',
      source: 'graph',
      routeId: wildcardRoute.id,
      message: `Route "${wildcardRoute.path}" matches all page URLs (app-shell pattern); fallthrough is unreachable`,
    });
  }

  warnings.sort((a, b) => a.code.localeCompare(b.code) || (a.routeId ?? '').localeCompare(b.routeId ?? '') || (a.message ?? '').localeCompare(b.message ?? ''));

  return {
    schemaVersion: 1,
    taujs: { server: pkg.version },
    source: options.source,
    emittedAt: options.emittedAt,
    disclosure: 'conservative',
    apps,
    routes,
    services,
    security,
    fallthrough,
    warnings,
  };
}
