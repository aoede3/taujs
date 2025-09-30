import { match, pathToRegexp } from 'path-to-regexp';

import { callServiceMethod, isServiceDescriptor } from './DataServices';
import { ServiceError } from './ServiceError';

import type { MatchFunction, Key } from 'path-to-regexp';
import type { ServiceContext, ServiceRegistry } from './DataServices';
import type { Route, RouteAttributes, PathToRegExpParams } from '../types';

type RequestCtx = ServiceContext & { headers?: Record<string, string> };

type CallServiceOn<R extends ServiceRegistry> = (
  registry: R,
  serviceName: string,
  methodName: string,
  params: Record<string, unknown>,
  ctx: ServiceContext,
) => Promise<Record<string, unknown>>;

export type RouteMatcher<Params extends PathToRegExpParams> = {
  route: Route<Params>;
  matcher: MatchFunction<Params>;
  keys: Key[];
  specificity: number;
};

export type CommonRouteMatcher = RouteMatcher<PathToRegExpParams>;

export interface RouteMatch<Params extends PathToRegExpParams = PathToRegExpParams> {
  route: Route<Params>;
  params: Params;
  keys: Key[];
}

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const cleanPath = (path: string): string => {
  if (!path) return '/';
  const basePart = path.split('?')[0];
  const base = basePart ? basePart.split('#')[0] : '/';
  return base || '/';
};

const calculateSpecificity = (path: string): number => {
  let score = 0;
  const segments = path.split('/').filter(Boolean);

  for (const segment of segments) {
    if (segment.startsWith(':')) {
      // Parameter segments are less specific
      score += 1;
      // Optional params, repeats, wildcards are even less specific
      if (/[?+*]$/.test(segment)) score -= 0.5;
    } else if (segment === '*') {
      // Wildcard segments are least specific
      score += 0.1;
    } else {
      // Static segments are most specific
      score += 10;
    }
  }

  // Longer paths are generally more specific
  score += segments.length * 0.1;

  return score;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

export const createRouteMatchers = <Params extends PathToRegExpParams>(routes: Route<Params>[]): RouteMatcher<Params>[] => {
  const sortedRoutes = [...routes].sort((a, b) => calculateSpecificity(b.path) - calculateSpecificity(a.path));

  return sortedRoutes.map((route) => {
    const result = pathToRegexp(route.path);
    const keys = result.keys || [];
    const matcher = match<Params>(route.path, { decode: safeDecode });
    const specificity = calculateSpecificity(route.path);

    return { route, matcher, keys, specificity };
  });
};

export const matchRoute = <Params extends PathToRegExpParams>(url: string, routeMatchers: RouteMatcher<Params>[]): RouteMatch<Params> | null => {
  const path = cleanPath(url);

  for (const { route, matcher, keys } of routeMatchers) {
    const match = matcher(path);
    if (match) {
      return {
        route,
        params: match.params as Params,
        keys,
      };
    }
  }

  return null;
};

export const extractRouteParams = <Params extends PathToRegExpParams = PathToRegExpParams>(path: string, routePath: string): Params | null => {
  const cleanedPath = cleanPath(path);
  const matcher = match<Params>(routePath, { decode: safeDecode });
  const result = matcher(cleanedPath);

  return result ? (result.params as Params) : null;
};

export const getRouteStats = <Params extends PathToRegExpParams>(routeMatchers: RouteMatcher<Params>[]) => {
  return {
    totalRoutes: routeMatchers.length,
    averageSpecificity: routeMatchers.reduce((sum, rm) => sum + rm.specificity, 0) / routeMatchers.length,
    routesByApp: routeMatchers.reduce<Record<string, number>>((acc, { route }) => {
      const appId = route.appId || 'unknown';
      acc[appId] = (acc[appId] || 0) + 1;

      return acc;
    }, {}),
    routesWithCSP: routeMatchers.filter(({ route }) => route.attr?.middleware?.csp !== undefined).length,
    routesWithAuth: routeMatchers.filter(({ route }) => route.attr?.middleware?.auth !== undefined).length,
    mostSpecific: routeMatchers[0]?.route.path || 'none',
    leastSpecific: routeMatchers[routeMatchers.length - 1]?.route.path || 'none',
  };
};

export const matchAllRoutes = <Params extends PathToRegExpParams>(url: string, routeMatchers: RouteMatcher<Params>[]): RouteMatch<Params>[] => {
  const path = cleanPath(url);
  const matches: RouteMatch<Params>[] = [];

  for (const { route, matcher, keys } of routeMatchers) {
    const match = matcher(path);
    if (match) {
      matches.push({
        route,
        params: match.params as Params,
        keys,
      });
    }
  }

  return matches;
};

export const fetchInitialData = async <Params extends PathToRegExpParams, R extends ServiceRegistry>(
  attr: RouteAttributes<Params> | undefined,
  params: Params,
  serviceRegistry: R,
  ctx: RequestCtx = { headers: {} },
  callServiceMethodImpl: CallServiceOn<R> = callServiceMethod as CallServiceOn<R>,
): Promise<Record<string, unknown>> => {
  const dataHandler = attr?.data;
  if (!dataHandler || typeof dataHandler !== 'function') return {};

  try {
    const result = await dataHandler(params, {
      ...ctx,
      headers: ctx.headers ?? {},
    });

    if (isServiceDescriptor(result)) {
      const { serviceName, serviceMethod, args } = result;

      return callServiceMethodImpl(serviceRegistry, serviceName, serviceMethod, args ?? {}, ctx);
    }

    if (isPlainObject(result)) return result;

    throw ServiceError.badRequest('attr.data must return a plain object or a ServiceDescriptor');
  } catch (err: unknown) {
    const log = ctx.logger?.child({
      component: 'fetch-initial-data',
      stage: 'fetchInitialData',
    });

    if (err instanceof ServiceError) {
      log?.error('ServiceError during fetchInitialData', {
        params,
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
          kind: (err as any).kind,
          code: (err as any).code,
        },
      });
      throw err;
    }

    const wrapped = ServiceError.infra('Failed to fetch initial data', {
      cause: err,
    });

    log?.error('Unexpected error during fetchInitialData', {
      params,
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    });

    throw wrapped;
  }
};
