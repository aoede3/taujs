import { matchRoute, fetchInitialData } from './DataRoutes';
import { createRequestContext } from './Telemetry';
import { AppError } from '../logging/AppError';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RouteMatcher } from './DataRoutes';
import type { ServiceRegistry } from './DataServices';
import type { Logs } from '../logging/Logger';

/**
 * Resolve and execute a route's attr.data handler for the given URL.
 *
 * This is the shared logic used by both:
 * - HTML SSR/streaming (HandleRender)
 * - JSON data endpoint (/__taujs/route)
 *
 * Throws AppError if route not found or no data handler defined.
 */
export async function resolveRouteData(
  url: string,
  opts: {
    req: FastifyRequest;
    reply: FastifyReply;
    routeMatchers: RouteMatcher<any>[];
    serviceRegistry: ServiceRegistry;
    logger: Logs;
  },
): Promise<Record<string, unknown>> {
  const { req, reply, routeMatchers, serviceRegistry, logger } = opts;

  const match = matchRoute(url, routeMatchers);

  if (!match) {
    throw AppError.notFound('route_not_found', {
      details: { url },
    });
  }

  const { route, params } = match;
  const attr = route.attr;

  if (!attr?.data) {
    throw AppError.notFound('no_data_handler', {
      details: {
        url,
        path: route.path,
        appId: route.appId,
      },
    });
  }

  const ctx = createRequestContext(req, reply, logger);

  return fetchInitialData(attr, params, serviceRegistry, ctx);
}
