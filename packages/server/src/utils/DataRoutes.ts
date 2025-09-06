import { match } from 'path-to-regexp';

import { callServiceMethod, isServiceDescriptor } from './DataServices';

import type { MatchFunction } from 'path-to-regexp';
import type { ServiceContext, ServiceRegistry } from './DataServices';
import type { Route, RouteAttributes } from '../types';

type RequestCtx = ServiceContext & { headers: Record<string, string> };

type CallServiceOn<R extends ServiceRegistry> = (
  registry: R,
  serviceName: string,
  methodName: string,
  params: Record<string, unknown>,
  ctx: ServiceContext,
) => Promise<Record<string, unknown>>;

export type RouteMatcher<Params extends object> = {
  route: Route<Params>;
  matcher: MatchFunction<Params>;
};

export const fetchInitialData = async <Params extends Partial<Record<string, string | string[]>>, R extends ServiceRegistry>(
  attr: RouteAttributes<Params> | undefined,
  params: Params,
  serviceRegistry: R,
  ctx: RequestCtx = { headers: {} },
  callServiceMethodImpl: CallServiceOn<R> = callServiceMethod as CallServiceOn<R>,
): Promise<Record<string, unknown>> => {
  const dataHandler = attr?.data;
  if (!dataHandler || typeof dataHandler !== 'function') return {};

  const result = await dataHandler(params, ctx);

  if (isServiceDescriptor(result)) {
    const { serviceName, serviceMethod, args } = result;

    return callServiceMethodImpl(serviceRegistry, serviceName, serviceMethod, args ?? {}, ctx);
  }

  if (typeof result === 'object' && result !== null) return result as Record<string, unknown>;

  throw new Error('Invalid result from attr.data');
};

export const createRouteMatchers = <Params extends object>(routes: Route<Params>[]): RouteMatcher<Params>[] => {
  return routes.map((route) => ({
    route,
    matcher: match(route.path, {
      decode: decodeURIComponent,
    }),
  }));
};

export const matchRoute = <Params extends object>(url: string, memoizedMatchers: RouteMatcher<Params>[]) => {
  for (const { route, matcher } of memoizedMatchers) {
    const matched = matcher(url);

    if (matched) return { route, params: matched.params };
  }

  return null;
};
