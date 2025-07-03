import crypto from 'crypto';

import { DEV_CSP_DIRECTIVES } from '../constants';

import type { HookHandlerDoneFunction, FastifyReply, FastifyRequest } from 'fastify';
import type { SSRServerOptions } from '../SSRServer';

export type CSPDirectives = Record<string, string[]>;

export interface CSPOptions {
  directives?: CSPDirectives;
  exposeNonce?: (req: FastifyRequest, nonce: string) => void;
  generateCSP?: (directives: CSPDirectives, nonce: string) => string;
}

export const defaultGenerateCSP = (directives: CSPDirectives, nonce: string): string => {
  const merged: CSPDirectives = { ...directives };

  merged['script-src'] = merged['script-src'] || ["'self'"];
  if (!merged['script-src'].some((v) => v.startsWith("'nonce-"))) merged['script-src'].push(`'nonce-${nonce}'`);

  if (process.env.NODE_ENV !== 'production') {
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

export const cspHook =
  (options: CSPOptions = {}) =>
  (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
    const nonce = generateNonce();

    const directives = options.directives ?? DEV_CSP_DIRECTIVES;
    const generate = options.generateCSP ?? defaultGenerateCSP;

    const cspHeader = generate(directives, nonce);

    reply.header('Content-Security-Policy', cspHeader);

    if (typeof options.exposeNonce === 'function') {
      options.exposeNonce(req, nonce);
    } else {
      req.nonce = nonce;
    }

    done();
  };

export const getRequestNonce = (req: FastifyRequest): string | undefined => (req as any).nonce;

export const applyCSP = (security: SSRServerOptions['security'], reply: FastifyReply): string | undefined => {
  if (!security?.csp) return;

  const nonce = generateNonce();
  const { directives = {}, generateCSP = defaultGenerateCSP } = security.csp;
  const header = generateCSP(directives, nonce);

  reply.header('Content-Security-Policy', header);
  reply.request.nonce = nonce;

  return nonce;
};
