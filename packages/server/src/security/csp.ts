import fp from 'fastify-plugin';
import crypto from 'crypto';

import { DEV_CSP_DIRECTIVES } from '../constants';
import { isDevelopment } from '../utils';

import type { FastifyPluginAsync, FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';

export interface CSPPluginOptions {
  directives?: CSPDirectives;
  generateCSP?: (directives: CSPDirectives, nonce: string) => string;
}

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
