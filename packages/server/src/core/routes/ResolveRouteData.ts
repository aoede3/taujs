import { matchRoute, fetchInitialData } from './DataRoutes';
import { AppError } from '../errors/AppError';

import type { RouteMatcher } from './DataRoutes';
import type { ServiceRegistry } from '../services/DataServices';
import type { RequestContext } from '../telemetry/Telemetry';
import type { Logs } from '../logging/types';
import type { PathToRegExpParams } from '../config/types';

/**
 * Resolve and execute a route's attr.data handler for the given URL.
 *
 * This is the shared logic used by both:
 * - HTML SSR/streaming (HandleRender)
 * - JSON data endpoint (/__taujs/route)
 *
 * Throws AppError if route not found or no data handler defined.
 */

export async function resolveRouteDataCore<
  Params extends PathToRegExpParams = PathToRegExpParams,
  R extends ServiceRegistry = ServiceRegistry,
  L extends Logs = Logs,
>(
  url: string,
  opts: {
    routeMatchers: RouteMatcher<Params>[];
    serviceRegistry: R;
    getCtx: () => RequestContext<L>;
  },
): Promise<Record<string, unknown>> {
  const match = matchRoute(url, opts.routeMatchers);

  if (!match) {
    throw AppError.notFound('route_not_found', { details: { url } });
  }

  const { route, params } = match;

  if (!route.attr?.data) {
    throw AppError.notFound('no_data_handler', {
      details: { url, path: route.path, appId: route.appId },
    });
  }

  const ctx = opts.getCtx();
  return fetchInitialData(route.attr, params, opts.serviceRegistry, ctx);
}
