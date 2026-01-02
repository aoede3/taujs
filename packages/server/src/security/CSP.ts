import fp from 'fastify-plugin';
import crypto from 'crypto';

import { createRouteMatchers, matchRoute } from '../core/routes/DataRoutes';
import { isDevelopment } from '../System';
import { DEV_CSP_DIRECTIVES } from '../constants';
import { createLogger } from '../logging/Logger';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Route, PathToRegExpParams, RouteCSPConfig } from '../core/config/types';
import type { CommonRouteMatcher } from '../core/routes/DataRoutes';
import type { DebugConfig } from '../core/logging/types';

export type CSPPluginOptions = {
  directives?: CSPDirectives;
  generateCSP?: (directives: CSPDirectives, nonce: string, req?: FastifyRequest) => string;
  routes?: Route[];
  routeMatchers?: CommonRouteMatcher[];
  debug?: DebugConfig;
  reporting?: {
    reportOnly?: boolean;
  };
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
    const { generateCSP = defaultGenerateCSP, routes = [], routeMatchers, debug } = opts;
    const globalDirectives = opts.directives || DEV_CSP_DIRECTIVES;
    const matchers = routeMatchers || (routes.length > 0 ? createRouteMatchers(routes) : null);

    const logger = createLogger({
      debug,
      context: { component: 'csp-plugin' },
    });

    fastify.addHook('onRequest', (req, reply, done) => {
      const nonce = generateNonce();
      req.cspNonce = nonce;

      const headerNameFor = (routeCSP: RouteCSPConfig | false | undefined) =>
        (routeCSP && typeof routeCSP === 'object' && routeCSP.reportOnly) || opts.reporting?.reportOnly
          ? 'Content-Security-Policy-Report-Only'
          : 'Content-Security-Policy';

      let routeCSP: false | RouteCSPConfig | undefined;

      try {
        const routeMatch = findMatchingRoute(matchers, req.url);
        routeCSP = routeMatch?.route.attr?.middleware?.csp;

        if (routeCSP === false) {
          done();
          return;
        }

        let finalDirectives = globalDirectives;

        if (routeCSP && typeof routeCSP === 'object' && !routeCSP.disabled) {
          const routeDirectives =
            typeof routeCSP.directives === 'function'
              ? routeCSP.directives({
                  url: req.url,
                  params: routeMatch?.params || {},
                  headers: req.headers,
                  req,
                })
              : (routeCSP.directives ?? {});

          finalDirectives = routeCSP.mode === 'replace' ? routeDirectives : mergeDirectives(globalDirectives, routeDirectives);
        }

        const cspHeader = routeCSP?.generateCSP ? routeCSP.generateCSP(finalDirectives, nonce, req) : generateCSP(finalDirectives, nonce, req);

        reply.header(headerNameFor(routeCSP), cspHeader);
      } catch (error) {
        logger.error(
          {
            url: req.url,
            error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
          },
          'CSP plugin error',
        );

        const fallbackHeader = generateCSP(globalDirectives, nonce, req);
        reply.header(headerNameFor(routeCSP), fallbackHeader);
      }

      done();
    });
  },
  { name: 'taujs-csp-plugin' },
);
