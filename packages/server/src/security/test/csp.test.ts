import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { generateNonce, createCSPHook, getRequestNonce, applyCSP } from '../csp';

import type { CSPDirectives } from '../csp';

describe('generateNonce', () => {
  it('generates a base64 nonce', () => {
    const nonce = generateNonce();

    expect(typeof nonce).toBe('string');
    expect(Buffer.from(nonce, 'base64').length).toBe(16);
  });
});

describe('generateNonce', () => {
  it('generates a base64 nonce', () => {
    const nonce = generateNonce();

    expect(typeof nonce).toBe('string');
    expect(Buffer.from(nonce, 'base64').length).toBe(16);
  });
});

describe('defaultGenerateCSP', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.doUnmock('../../utils');
    vi.resetModules();
  });

  it('adds nonce and defaults for production', async () => {
    process.env.NODE_ENV = 'production';

    vi.doMock('../../utils', () => ({
      isDevelopment: false,
    }));

    vi.resetModules();

    const { defaultGenerateCSP } = await import('../csp');

    const nonce = 'abc123';
    const directives: CSPDirectives = {
      'script-src': ["'self'"],
    };

    const result = defaultGenerateCSP(directives, nonce);

    expect(result).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(result).not.toContain('style-src');
    expect(result).not.toContain('connect-src');
  });

  it('adds ws:, http:, and unsafe-inline in dev', async () => {
    vi.doMock('../../utils', () => ({
      isDevelopment: true,
    }));

    vi.resetModules();

    const { defaultGenerateCSP } = await import('../csp');

    const nonce = 'abc123';
    const directives: CSPDirectives = {
      'script-src': ["'self'"],
    };
    const result = defaultGenerateCSP(directives, nonce);

    expect(result).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(result).toContain(`connect-src 'self' ws: http:`);
    expect(result).toContain(`style-src 'self' 'unsafe-inline'`);
  });

  it('does not duplicate nonce or connect/style values', async () => {
    vi.doMock('../../utils', () => ({
      isDevelopment: true,
    }));

    vi.resetModules();

    const { defaultGenerateCSP } = await import('../csp');

    const nonce = 'abc123';
    const directives: CSPDirectives = {
      'script-src': ["'self'", `'nonce-${nonce}'`],
      'connect-src': ['ws:', 'http:'],
      'style-src': ["'unsafe-inline'"],
    };
    const result = defaultGenerateCSP(directives, nonce);

    expect(result.match(/'nonce-abc123'/g)?.length).toBe(1);
    expect(result.match(/ws:/g)?.length).toBe(1);
    expect(result.match(/'unsafe-inline'/g)?.length).toBe(1);
  });
});
describe('cspHook', () => {
  const reply = {
    header: vi.fn(),
  };

  const done = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses default CSP and sets nonce on request', () => {
    const req: any = {};
    const hook = createCSPHook();
    hook(req, reply as any, done);

    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy', expect.stringContaining('script-src'));
    expect(req.nonce).toBeDefined();
    expect(done).toHaveBeenCalled();
  });

  it('calls exposeNonce if provided', () => {
    const exposeNonce = vi.fn();
    const req: any = {};
    const hook = createCSPHook({ exposeNonce });

    hook(req, reply as any, done);
    expect(exposeNonce).toHaveBeenCalledWith(req, expect.any(String));
    expect(req.nonce).toBeUndefined();
  });

  it('uses custom generateCSP if provided', () => {
    const generateCSP = vi.fn(() => 'custom-policy');
    const req: any = {};
    const hook = createCSPHook({ generateCSP });

    hook(req, reply as any, done);
    expect(generateCSP).toHaveBeenCalled();
    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy', 'custom-policy');
  });
});

describe('getRequestNonce', () => {
  it('returns the nonce from request', () => {
    const req = { nonce: 'xyz' };

    expect(getRequestNonce(req as any)).toBe('xyz');
  });

  it('returns undefined if nonce not present', () => {
    const req = {};

    expect(getRequestNonce(req as any)).toBeUndefined();
  });
});

describe('applyCSP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses default directives when security or csp is undefined', () => {
    const reply: any = { header: vi.fn(), request: {} };
    const result = applyCSP(undefined as any, reply);

    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy', expect.stringContaining('script-src'));
    expect(result).toBe(reply.request.nonce);

    vi.clearAllMocks();

    const result2 = applyCSP({} as any, reply);
    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy', expect.stringContaining('script-src'));
    expect(result2).toBe(reply.request.nonce);
  });

  it('sets CSP and nonce using defaults', () => {
    const reply: any = { header: vi.fn(), request: {} };
    const result = applyCSP({ csp: {} }, reply);

    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy', expect.stringContaining('script-src'));
    expect(reply.request.nonce).toBeDefined();
    expect(result).toBe(reply.request.nonce);
  });

  it('uses custom generateCSP', () => {
    const generateCSP = vi.fn(() => 'test-csp');
    const reply: any = { header: vi.fn(), request: {} };
    const result = applyCSP({ csp: { generateCSP } }, reply);

    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy', 'test-csp');
    expect(generateCSP).toHaveBeenCalled();
    expect(result).toBe(reply.request.nonce);
  });

  it('uses custom directives with default generator', () => {
    const directives: CSPDirectives = {
      'script-src': ["'self'", 'https://example.com'],
    };

    const reply: any = { header: vi.fn(), request: {} };
    const result = applyCSP({ csp: { directives } }, reply);

    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy', expect.stringContaining('https://example.com'));
    expect(result).toBe(reply.request.nonce);
  });
});
