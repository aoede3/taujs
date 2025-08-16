import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';

import { cspPlugin, defaultGenerateCSP, generateNonce, type CSPDirectives } from '../csp'; // adjust path as needed

import type { FastifyRequest } from 'fastify';

let isDevelopmentValue = true;

vi.mock('../../utils', () => ({
  get isDevelopment() {
    return isDevelopmentValue;
  },
}));

describe('cspPlugin', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(() => {
    fastify = Fastify();
  });

  it('attaches nonce and sets CSP header with default options', async () => {
    await fastify.register(cspPlugin);

    fastify.get('/', (req: { cspNonce: unknown }, reply: { send: (arg0: { nonce: unknown }) => void }) => {
      reply.send({ nonce: req.cspNonce });
    });

    const res = await fastify.inject({ method: 'GET', url: '/' });

    const header = res.headers['content-security-policy'];
    const body = res.json();

    expect(header).toContain(`'nonce-${body.nonce}'`);
    expect(header).toContain('script-src');
    expect(body.nonce).toBeDefined();
  });

  it('uses custom directives and generator if provided', async () => {
    const generateCSP = vi.fn(() => 'custom-csp-header');

    await fastify.register(cspPlugin, {
      directives: { 'default-src': ["'self'"] },
      generateCSP,
    });

    fastify.get('/', (_req: FastifyRequest, reply: { send: () => void }) => {
      reply.send();
    });

    const res = await fastify.inject({ method: 'GET', url: '/' });

    expect(res.headers['content-security-policy']).toBe('custom-csp-header');
    expect(generateCSP).toHaveBeenCalledWith({ 'default-src': ["'self'"] }, expect.any(String));
  });
});

describe('defaultGenerateCSP', () => {
  it('adds nonce and dev fallbacks to script-src, connect-src, and style-src', async () => {
    isDevelopmentValue = true;

    const { defaultGenerateCSP } = await import('../csp');

    const nonce = 'test-nonce';
    const input = {
      'script-src': ["'self'"],
      'connect-src': ["'self'"],
      'style-src': ["'self'"],
    };

    const output = defaultGenerateCSP(input, nonce);

    expect(output).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(output).toContain(`connect-src 'self' ws: http:`);
    expect(output).toContain(`style-src 'self' 'unsafe-inline'`);
  });

  it('adds script-src if missing', () => {
    const output = defaultGenerateCSP({}, 'abc123');
    expect(output).toContain(`script-src 'self' 'nonce-abc123'`);
  });

  it('does not add nonce if already present', () => {
    const input: CSPDirectives = {
      'script-src': ["'self'", "'nonce-already-there'"],
    };

    const output = defaultGenerateCSP(input, 'ignored');

    expect(output).toContain(`'nonce-already-there'`);
    expect(output).not.toContain(`'nonce-ignored'`);
  });
});

describe('generateNonce', () => {
  it('generates a 16-byte base64 string', () => {
    const nonce = generateNonce();
    const buffer = Buffer.from(nonce, 'base64');
    expect(buffer.length).toBe(16);
  });
});
