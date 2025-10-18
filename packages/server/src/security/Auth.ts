import { matchRoute } from '../utils/DataRoutes';

import type { FastifyRequest, FastifyReply, onRequestHookHandler } from 'fastify';
import type { PathToRegExpParams } from '../types';
import type { RouteMatcher } from '../utils/DataRoutes';
import type { Logger } from '../logging/Logger';

export const createAuthHook = (routeMatchers: RouteMatcher<PathToRegExpParams>[], logger: Logger): onRequestHookHandler => {
  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
    const url = new URL(req.url, `http://${req.headers.host}`).pathname;

    const match = matchRoute(url, routeMatchers);

    if (!match) return;

    const { route } = match;
    const authConfig = route.attr?.middleware?.auth;

    if (!authConfig) {
      logger.debug('auth', '(none)', { method: req.method, url: req.url });
      return;
    }

    if (typeof req.server.authenticate !== 'function') {
      logger.warn('Route requires auth but Fastify authenticate decorator is missing', {
        path: url,
        appId: route.appId,
      });
      return reply.status(500).send('Server misconfiguration: auth decorator missing.');
    }

    try {
      logger.debug('auth', 'Invoking authenticate(...)', { method: req.method, url: req.url });

      await req.server.authenticate(req, reply);

      logger.debug('auth', 'Authentication successful', { method: req.method, url: req.url });
    } catch (err) {
      logger.debug('auth', 'Authentication failed', { method: req.method, url: req.url });

      return reply.send(err);
    }
  };
};
