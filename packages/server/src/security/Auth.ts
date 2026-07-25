import { selectedRouteFrom } from '../core/routes/FastifyRoutes';
import { getRequestContext } from '../utils/Telemetry';

import type { FastifyRequest, FastifyReply, onRequestHookHandler } from 'fastify';
import type { Logs } from '../core/logging/types';

export const createAuthHook = (logger: Logs): onRequestHookHandler => {
  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
    const requestLogger = getRequestContext(req)?.logger ?? logger;
    const selected = selectedRouteFrom(req);
    if (!selected) return;

    const { route } = selected;
    const url = new URL(req.url, `http://${req.headers.host}`).pathname;
    const authConfig = route.attr?.middleware?.auth;

    // Boundary (taujs.dev/guides/authentication): Fastify selects the route and taujs
    // surfaces the auth metadata below, and invokes the authenticate decorator.
    // roles / strategy / redirect are metadata for that decorator to read and
    // enforce - taujs deliberately does not interpret them.

    // Decorate auth request with route metadata
    req.routeMeta = {
      path: route.path,
      appId: route.appId,
      attr: {
        middleware: {
          auth: route.attr?.middleware?.auth,
        },
        render: route.attr?.render,
      },
    };

    if (!authConfig) {
      requestLogger.debug('auth', { method: req.method, url: req.url }, '(none)');
      return;
    }

    if (typeof req.server.authenticate !== 'function') {
      requestLogger.warn(
        {
          path: url,
          appId: route.appId,
        },
        'Route requires auth but Fastify authenticate decorator is missing',
      );
      return reply.status(500).send('Server misconfiguration: auth decorator missing.');
    }

    try {
      requestLogger.debug('auth', { method: req.method, url: req.url }, 'Invoking authenticate(...)');

      await req.server.authenticate(req, reply);

      // The documented handshake allows the decorator to reject without
      // throwing (reply.code(401).send(); return;) - that is not a success.
      if (reply.sent) {
        requestLogger.debug('auth', { method: req.method, url: req.url }, 'Authentication handled by decorator (reply already sent)');
        return;
      }

      requestLogger.debug('auth', { method: req.method, url: req.url }, 'Authentication successful');
    } catch (err) {
      requestLogger.debug('auth', { method: req.method, url: req.url }, 'Authentication failed');

      return reply.send(err);
    }
  };
};
