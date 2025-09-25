import fp from 'fastify-plugin';
import crypto from 'crypto';

import { DEV_CSP_DIRECTIVES } from '../constants';
import { isDevelopment } from '../utils/System';

import type { FastifyPluginAsync, FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import type { RouteCSPConfig } from '../types';

export type CSPPluginOptions = {
  directives?: CSPDirectives;
  generateCSP?: (directives: CSPDirectives, nonce: string) => string;
};

export type CSPDirectives = Record<string, string[]>;

export const defaultGenerateCSP = (directives: CSPDirectives, nonce: string): string => {
  const merged: CSPDirectives = { ...directives };

  merged['script-src'] = merged['script-src'] || ["'self'"];
  if (!merged['script-src'].some((v) => v.startsWith("'nonce-"))) merged['script-src'].push(`'nonce-${nonce}'`);

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

export const cspPlugin: FastifyPluginAsync<CSPPluginOptions> = fp(
  async (fastify, opts: CSPPluginOptions) => {
    fastify.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
      const nonce = generateNonce();

      req.cspNonce = nonce;

      const directives = opts.directives ?? DEV_CSP_DIRECTIVES;
      const generate = opts.generateCSP ?? defaultGenerateCSP;
      const cspHeader = generate(directives, nonce);

      reply.header('Content-Security-Policy', cspHeader);

      done();
    });
  },
  {
    name: 'taujs-csp-plugin',
  },
);

export const mergeDirectives = (base: CSPDirectives, add: CSPDirectives): CSPDirectives => {
  const out: CSPDirectives = { ...base };
  for (const [k, vals] of Object.entries(add)) {
    const existing = out[k] ?? [];
    out[k] = Array.from(new Set([...existing, ...vals]));
  }
  return out;
};

export const resolveRouteDirectives = (
  routeCsp: RouteCSPConfig,
  req: FastifyRequest,
  params: Record<string, string>,
  globalDirectives?: CSPDirectives,
): CSPDirectives | null => {
  if (routeCsp.disabled) return null;

  const local =
    typeof routeCsp.directives === 'function' ? routeCsp.directives({ url: req.url, params, headers: req.headers, req }) : (routeCsp.directives ?? {});

  return routeCsp.mode === 'replace' ? local : mergeDirectives(globalDirectives ?? {}, local);
};

export const buildCSPHeader = (
  effective: CSPDirectives | null,
  req: FastifyRequest,
  opts: {
    globalGenerate?: (d: CSPDirectives, nonce: string) => string;
    routeGenerate?: RouteCSPConfig['generateCSP'];
  },
): { name: 'Content-Security-Policy'; value: string } | null => {
  if (!effective) return null;

  const nonce = (req as any).cspNonce ?? generateNonce();
  const gen =
    opts.routeGenerate ??
    (opts.globalGenerate ? (d: CSPDirectives, n: string) => opts.globalGenerate!(d, n) : (d: CSPDirectives, n: string) => defaultGenerateCSP(d, n));

  return { name: 'Content-Security-Policy', value: gen(effective, nonce, req) };
};
