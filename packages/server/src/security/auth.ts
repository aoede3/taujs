import { debugLog, createLogger } from '../utils/Logger';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DebugCategory } from '../utils/Logger';
import type { Route } from '../types';

export const createAuthHook = (routes: Route[], debug: Record<DebugCategory, boolean>) => {
  const logger = createLogger(debug);

  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
    const url = new URL(req.url, `http://${req.headers.host}`).pathname;
    const matched = routes.find((r) => r.path === url);
    const authConfig = matched?.attr?.middleware?.auth;

    if (!authConfig) {
      if (debug.auth) debugLog(logger, 'auth', '(none)', debug, req);

      return;
    }

    if (typeof req.server.authenticate !== 'function') {
      req.log.warn('Route requires auth but no "authenticate" decorator is defined on Fastify.');
      return reply.status(500).send('Server misconfiguration: auth decorator missing.');
    }

    try {
      debugLog(logger, 'auth', 'Invoking authenticate(...)', debug, req);
      await req.server.authenticate(req, reply);
      debugLog(logger, 'auth', 'Authentication successful', debug, req);
    } catch (err) {
      debugLog(logger, 'auth', 'Authentication failed', debug, req);
      return reply.send(err);
    }
  };
};
