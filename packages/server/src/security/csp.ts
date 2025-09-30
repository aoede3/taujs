import fp from 'fastify-plugin';
import crypto from 'crypto';

import { DEV_CSP_DIRECTIVES } from '../constants';
import { isDevelopment } from '../utils/System';
import { createRouteMatchers, matchRoute } from '../utils/DataRoutes';
import { Logger } from '../utils/Logger';

import type { FastifyPluginAsync, FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import type { Route, PathToRegExpParams } from '../types';
import type { CommonRouteMatcher } from '../utils/DataRoutes';
import type { DebugConfig } from '../utils/Logger';

export type CSPPluginOptions = {
  directives?: CSPDirectives;
  generateCSP?: (directives: CSPDirectives, nonce: string, req?: FastifyRequest) => string;
  routes?: Route[];
  routeMatchers?: CommonRouteMatcher[];
  isDebug?: DebugConfig;
};

export type CSPDirectives = Record<string, string[]>;

export const defaultGenerateCSP = (directives: CSPDirectives, nonce: string, req?: FastifyRequest): string => {
  const merged: CSPDirectives = { ...directives };

  merged['script-src'] = merged['script-src'] || ["'self'"];
  if (!merged['script-src'].some((v) => v.startsWith("'nonce-"))) {
    merged['script-src'].push(`'nonce-${nonce}'`);
  }

  if (isDevelopment) {
    const connect = merged['connect-src'] || ["'self'"];
    if (!connect.includes('ws:')) connect.push('ws:');
    if (!connect.includes('http:')) connect.push('http:');
    merged['connect-src'] = connect;

    const style = merged['style-src'] || ["'self'"];
    if (!style.includes("'unsafe-inline'")) style.push("'unsafe-inline'");
    merged['style-src'] = style;
  }

  return Object.entries(merged)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');
};

export const generateNonce = (): string => crypto.randomBytes(16).toString('base64');

const mergeDirectives = (base: CSPDirectives, override: CSPDirectives): CSPDirectives => {
  const merged: CSPDirectives = { ...base };

  for (const [directive, values] of Object.entries(override)) {
    if (merged[directive]) {
      merged[directive] = [...new Set([...merged[directive], ...values])];
    } else {
      merged[directive] = [...values];
    }
  }

  return merged;
};

const findMatchingRoute = (routeMatchers: CommonRouteMatcher[] | null, path: string): { route: Route; params: PathToRegExpParams } | null => {
  if (!routeMatchers) return null;

  const match = matchRoute(path, routeMatchers);
  return match ? { route: match.route, params: match.params } : null;
};

export const cspPlugin: FastifyPluginAsync<CSPPluginOptions> = fp(
  async (fastify, opts: CSPPluginOptions) => {
    const { generateCSP = defaultGenerateCSP, routes = [], routeMatchers, isDebug } = opts;
    const globalDirectives = opts.directives || DEV_CSP_DIRECTIVES;
    const matchers = routeMatchers || (routes.length > 0 ? createRouteMatchers(routes) : null);

    // New Logger: instance + optional debug config + scoped child
    const baseLogger = new Logger();
    if (isDebug !== undefined) baseLogger.configure(isDebug);
    const logger = baseLogger.child({ component: 'csp-plugin' });

    fastify.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
      const nonce = generateNonce();
      req.cspNonce = nonce;

      try {
        const routeMatch = findMatchingRoute(matchers, req.url);
        const routeCSP = routeMatch?.route.attr?.middleware?.csp;

        if (routeCSP === false) {
          // CSP disabled for this route; do nothing.
          done();
          return;
        }

        let finalDirectives = globalDirectives;

        // Handle route-specific CSP configuration
        if (routeCSP && typeof routeCSP === 'object') {
          if (!routeCSP.disabled) {
            let routeDirectives: CSPDirectives;

            // Handle function-based directives with extracted params
            if (typeof routeCSP.directives === 'function') {
              const params = routeMatch?.params || {};

              routeDirectives = routeCSP.directives({
                url: req.url,
                params,
                headers: req.headers,
                req,
              });
            } else {
              routeDirectives = routeCSP.directives || {};
            }

            if (routeCSP.mode === 'replace') {
              finalDirectives = routeDirectives;
            } else {
              finalDirectives = mergeDirectives(globalDirectives, routeDirectives);
            }
          }
        }

        let cspHeader: string;
        if (routeCSP?.generateCSP) {
          cspHeader = routeCSP.generateCSP(finalDirectives, nonce, req);
        } else {
          cspHeader = generateCSP(finalDirectives, nonce, req);
        }

        reply.header('Content-Security-Policy', cspHeader);
      } catch (error) {
        // Log error but don't fail the request - fall back to global CSP
        logger.error('CSP plugin error', {
          url: req.url,
          error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
        });
        const fallbackHeader = generateCSP(globalDirectives, nonce, req);
        reply.header('Content-Security-Policy', fallbackHeader);
      }

      done();
    });
  },
  { name: 'taujs-csp-plugin' },
);
