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
      logger.debug('auth', { method: req.method, url: req.url }, '(none)');
      return;
    }

    if (typeof req.server.authenticate !== 'function') {
      logger.warn(
        {
          path: url,
          appId: route.appId,
        },
        'Route requires auth but Fastify authenticate decorator is missing',
      );
      return reply.status(500).send('Server misconfiguration: auth decorator missing.');
    }

    try {
      logger.debug('auth', { method: req.method, url: req.url }, 'Invoking authenticate(...)');

      await req.server.authenticate(req, reply);

      logger.debug('auth', { method: req.method, url: req.url }, 'Authentication successful');
    } catch (err) {
      logger.debug('auth', { method: req.method, url: req.url }, 'Authentication failed');

      return reply.send(err);
    }
  };
};
