import type { FastifyInstance } from 'fastify';

import { debugLog, createLogger } from '../utils/Logger';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Route } from '../SSRServer';

export function createAuthHook(routes: Route[], isDebug?: boolean) {
  const logger = createLogger(Boolean(isDebug));

  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
    const url = new URL(req.url, `http://${req.headers.host}`).pathname;
    const matched = routes.find((r) => r.path === url);
    const authConfig = matched?.attr?.middleware?.auth;

    if (!authConfig?.required) {
      debugLog(logger, 'Auth not required for route', req);
      return;
    }

    if (typeof req.server.authenticate !== 'function') {
      req.log.warn('Route requires auth but no "authenticate" decorator is defined on Fastify.');
      return reply.status(500).send('Server misconfiguration: auth decorator missing.');
    }

    try {
      debugLog(logger, 'Invoking authenticate(...)', req);
      await req.server.authenticate(req, reply);
      debugLog(logger, 'Authentication successful', req);
    } catch (err) {
      debugLog(logger, 'Authentication failed', req);
      return reply.send(err);
    }
  };
}
