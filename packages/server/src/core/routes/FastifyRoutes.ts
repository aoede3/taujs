import type { FastifyRequest } from 'fastify';
import type { Route, RouteParams } from '../config/types';

const TAUJS_ROUTE = Symbol('taujs.route');

type TaujsFastifyRouteConfig = {
  [TAUJS_ROUTE]: Route;
};

export type SelectedPageRoute = {
  route: Route;
  params: RouteParams;
};

export const fastifyConfigForRoute = (route: Route): TaujsFastifyRouteConfig => ({
  [TAUJS_ROUTE]: route,
});

export const selectedRouteFrom = (req: FastifyRequest): SelectedPageRoute | null => {
  const config = req.routeOptions.config as unknown as Partial<TaujsFastifyRouteConfig>;
  const route = config[TAUJS_ROUTE];

  if (!route) return null;

  return {
    route,
    params: (req.params ?? {}) as RouteParams,
  };
};
