import { match } from 'path-to-regexp';

import { callServiceMethod, ensureServiceCaller, isServiceDescriptor } from '../services/DataServices';
import { AppError } from '../errors/AppError';

import type { MatchFunction, Key } from 'path-to-regexp';
import type { ServiceContext, ServiceRegistry } from '../services/DataServices';
import type { Logs } from '../logging/types';
import type { Route, RouteAttributes, PathToRegExpParams, RequestServiceContext } from '../config/types';
import type { RequestContext } from '../telemetry/Telemetry';

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
      score += 1;
      if (/[?+*]$/.test(segment)) score -= 0.5;
    } else if (segment === '*') {
      score += 0.1;
    } else {
      score += 10;
    }
  }

  score += segments.length * 0.1;

  return score;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

export const createRouteMatchers = <Params extends PathToRegExpParams>(routes: Route<Params>[]): RouteMatcher<Params>[] => {
  const sortedRoutes = [...routes].sort((a, b) => calculateSpecificity(b.path) - calculateSpecificity(a.path));

  return sortedRoutes.map((route) => {
    const matcher = match<Params>(route.path, { decode: safeDecode });
    const specificity = calculateSpecificity(route.path);
    const keys: Key[] = [];

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

export const fetchInitialData = async <Params extends PathToRegExpParams, R extends ServiceRegistry, L extends Logs = Logs>(
  attr: RouteAttributes<Params> | undefined,
  params: Params,
  serviceRegistry: R,
  ctx: RequestContext<L>,
  callServiceMethodImpl: CallServiceOn<R> = callServiceMethod as CallServiceOn<R>,
): Promise<Record<string, unknown>> => {
  const dataHandler = attr?.data;
  if (!dataHandler || typeof dataHandler !== 'function') return {};

  const ctxForData: RequestServiceContext<L> = {
    ...ctx,
    headers: ctx.headers ?? {},
  } as const;

  ensureServiceCaller(serviceRegistry, ctxForData);

  try {
    const result = await dataHandler(params, ctxForData);

    if (isServiceDescriptor(result)) {
      const { serviceName, serviceMethod, args } = result;

      return callServiceMethodImpl(serviceRegistry, serviceName, serviceMethod, args ?? {}, ctxForData);
    }

    if (isPlainObject(result)) return result;

    throw AppError.badRequest('attr.data must return a plain object or a ServiceDescriptor');
  } catch (err: unknown) {
    let e = AppError.from(err);

    const msg = String((err as any)?.message ?? '');
    const looksLikeHtml = /<!DOCTYPE/i.test(msg) || /<html/i.test(msg) || /Unexpected token <.*JSON/i.test(msg);

    if (looksLikeHtml) {
      const prevDetails = (e as any).details && typeof (e as any).details === 'object' ? (e as any).details : {};
      e = AppError.internal('attr.data expected JSON but received HTML. Likely cause: API route missing or returning HTML.', err, {
        ...prevDetails,
        hint: 'api-missing-or-content-type',
        suggestion: 'Register api route so it returns JSON, or return a ServiceDescriptor from attr.data and use the ServiceRegistry.',
        logged: true,
      });
    }
    const level: 'warn' | 'error' = e.kind === 'domain' || e.kind === 'validation' || e.kind === 'auth' ? 'warn' : 'error';

    const meta: Record<string, unknown> = {
      component: 'fetch-initial-data',
      kind: e.kind,
      httpStatus: e.httpStatus,
      ...(e.code ? { code: e.code } : {}),
      ...(e.details ? { details: e.details } : {}),
      ...(params ? { params } : {}),
      traceId: ctx.traceId,
    };

    ctx.logger?.[level](meta, e.message);

    throw e;
  }
};
