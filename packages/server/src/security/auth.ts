import type { FastifyRequest, FastifyReply } from 'fastify';

import { Logger, type DebugConfig, type Logs } from '../utils/Logger';
import type { Route } from '../types';

/**
 * Create an auth hook that uses the shared Logger instance.
 * Optionally pass a DebugConfig to adjust category flags for this instance.
 */
export const createAuthHook = (routes: Route[], baseLogger: Logs, isDebug?: DebugConfig) => {
  // If the caller supplied a debug config, apply it to the provided logger
  if (isDebug !== undefined) {
    baseLogger.configure(isDebug);
  }

  // Child logger with component context
  const logger = baseLogger.child({ component: 'auth-hook' });

  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
    const url = new URL(req.url, `http://${req.headers.host}`).pathname;
    const matched = routes.find((r) => r.path === url);
    const authConfig = matched?.attr?.middleware?.auth;

    if (!authConfig) {
      // Category-aware debug; only emits if 'auth' is enabled via configure(...)
      logger.info('(none)', { method: req.method, url: req.url, ip: req.ip });
      return;
    }

    if (typeof req.server.authenticate !== 'function') {
      logger.warn('Route requires auth but Fastify authenticate decorator is missing', { path: url });
      return reply.status(500).send('Server misconfiguration: auth decorator missing.');
    }

    try {
      logger.info('Invoking authenticate(...)', { method: req.method, url: req.url, ip: req.ip });
      await req.server.authenticate(req, reply);
      logger.info('Authentication successful', { method: req.method, url: req.url, ip: req.ip });
    } catch (err) {
      logger.info('Authentication failed', { method: req.method, url: req.url, ip: req.ip });
      return reply.send(err);
    }
  };
};
