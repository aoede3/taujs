import { resolveRouteDataCore } from '../core/routes/ResolveRouteData';
import { createRequestContext } from '../utils/Telemetry';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PathToRegExpParams } from '../core/config/types';
import type { Logs } from '../core/logging/types';
import type { RouteMatcher } from '../core/routes/DataRoutes';
import type { ServiceRegistry } from '../core/services/DataServices';

export async function resolveRouteData<
  Params extends PathToRegExpParams = PathToRegExpParams,
  R extends ServiceRegistry = ServiceRegistry,
  L extends Logs = Logs,
>(
  url: string,
  opts: {
    req: FastifyRequest;
    reply: FastifyReply;
    routeMatchers: RouteMatcher<Params>[];
    serviceRegistry: R;
    logger: L;
  },
): Promise<Record<string, unknown>> {
  const { req, reply, routeMatchers, serviceRegistry, logger } = opts;

  return resolveRouteDataCore<Params, R, L>(url, {
    routeMatchers,
    serviceRegistry,
    getCtx: () => createRequestContext(req, reply, logger),
  });
}
