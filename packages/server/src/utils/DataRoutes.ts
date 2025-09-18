import { match } from 'path-to-regexp';

import { callServiceMethod, isServiceDescriptor } from './DataServices';
import { ServiceError } from './ServiceError';

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

  try {
    const result = await dataHandler(params, ctx);

    if (isServiceDescriptor(result)) {
      const { serviceName, serviceMethod, args } = result;
      return callServiceMethodImpl(serviceRegistry, serviceName, serviceMethod, args ?? {}, ctx);
    }

    if (typeof result === 'object' && result !== null) {
      return result as Record<string, unknown>;
    }

    throw ServiceError.badRequest('Invalid result from attr.data - must return object or ServiceDescriptor');
  } catch (err) {
    if (ctx.logger) {
      ctx.logger.serviceError?.(err, {
        stage: 'fetchInitialData',
        params,
        route: attr,
      });
    }
    throw err;
  }
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
