import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createRequestContext } from '../Telemetry';

type Req = {
  headers: Record<string, any>;
  method?: string;
  url?: string;
  id?: any;
};

type Reply = {
  header: (k: string, v: string) => void;
};

describe('createRequestContext', () => {
  let reply: Reply;
  let headerSpy: ReturnType<typeof vi.fn<(k: string, v: string) => void>>;
  let baseLogger: any;

  beforeEach(() => {
    headerSpy = vi.fn<(k: string, v: string) => void>();
    reply = { header: headerSpy };
    baseLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('adopts String(req.id) and never reinterprets an inbound x-request-id (SC-09)', () => {
    const req: Req = {
      headers: { 'x-request-id': 'abc-123', host: 'localhost' },
      id: 'host-77',
      method: 'GET',
      url: '/ok',
    };

    const ctx = createRequestContext(req as any, reply as any, baseLogger);

    expect(ctx.requestId).toBe('host-77');
    expect(reply.header).toHaveBeenCalledWith('x-request-id', 'host-77');
    expect(ctx.logger).toBe(baseLogger);
    expect(ctx.headers).toEqual({
      'x-request-id': 'abc-123',
      host: 'localhost',
    });
  });

  it('carries req.url verbatim as ctx.url: path plus query string, no origin', () => {
    const req: Req = { headers: { host: 'localhost' }, id: 'r-1', method: 'GET', url: '/products?sort=price&after=abc' };

    const ctx = createRequestContext(req as any, reply as any, baseLogger);

    expect(ctx.url).toBe('/products?sort=price&after=abc');
  });

  it('a malformed inbound header is irrelevant: req.id is already the identity', () => {
    const req: Req = {
      headers: { 'x-request-id': '!!not-safe!!', host: 'localhost' },
      id: 'request-42',
      method: 'POST',
      url: '/fallback',
    };

    const ctx = createRequestContext(req as any, reply as any, baseLogger);

    expect(ctx.requestId).toBe('request-42');
    expect(reply.header).toHaveBeenCalledWith('x-request-id', 'request-42');
  });

  it('coerces a numeric req.id to its textual identity', () => {
    const req: Req = {
      headers: { host: 'num.test' },
      id: 7,
      method: 'GET',
      url: '/num',
    };

    const ctx = createRequestContext(req as any, reply as any, baseLogger);

    expect(ctx.requestId).toBe('7');
    expect(reply.header).toHaveBeenCalledWith('x-request-id', '7');
  });

  it('fails explicitly when a host violates the Fastify req.id contract - no parallel identity is invented', () => {
    const req: Req = {
      headers: { host: 'example.test' },
      method: 'PUT',
      url: '/gen',
    };

    expect(() => createRequestContext(req as any, reply as any, baseLogger)).toThrow(/SC-09: Fastify guarantees a string or number req\.id/);
    expect(headerSpy).not.toHaveBeenCalled();
  });

  it('uses logger.child when provided, binding correct "this" and bindings', () => {
    let childThis: any = null;
    const derivedLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const loggerWithChild = {
      ...baseLogger,
      child: vi.fn(function (this: any, bindings: Record<string, unknown>) {
        childThis = this;
        // One correlation identity: the Fastify-native `reqId` binding alone, in native type.
        expect(bindings).toEqual({
          reqId: 'req-child-1',
          url: '/child',
          method: 'GET',
        });
        return derivedLogger;
      }),
    };

    const req: Req = {
      headers: { host: 'child.test' },
      method: 'GET',
      url: '/child',
      id: 'req-child-1',
    };

    const ctx = createRequestContext(req as any, reply as any, loggerWithChild as any);

    expect(loggerWithChild.child).toHaveBeenCalledTimes(1);
    expect(childThis).toBe(loggerWithChild);
    expect(ctx.logger).toBe(derivedLogger);
  });

  it('uses an injected request-logger derivation seam when supplied', () => {
    const derivedLogger = { ...baseLogger, marker: 'derived' };
    const deriveLogger = vi.fn(() => derivedLogger);
    const req: Req = {
      headers: { host: 'factory.test' },
      method: 'PATCH',
      url: '/factory',
      id: 'req-factory-1',
    };

    const ctx = createRequestContext(req as any, reply as any, baseLogger, deriveLogger as any);

    expect(deriveLogger).toHaveBeenCalledWith({
      reqId: 'req-factory-1',
      url: '/factory',
      method: 'PATCH',
    });
    expect(ctx.logger).toBe(derivedLogger);
  });

  it('returns base logger unchanged when child is not a function', () => {
    const loggerNoChild = { ...baseLogger, child: undefined };

    const req: Req = {
      headers: { host: 'noch.test' },
      method: 'HEAD',
      url: '/no-child',
      id: 'id-no-child',
    };

    const ctx = createRequestContext(req as any, reply as any, loggerNoChild as any);

    expect(ctx.logger).toBe(loggerNoChild);
  });

  it('normalizes headers: arrays join with comma, undefined to empty string', () => {
    const req: Req = {
      headers: {
        host: 'norm.test',
        accept: ['text/html', 'application/xhtml+xml'],
        'x-empty': undefined,
        'x-one': 'solo',
      },
      method: 'GET',
      url: '/headers',
      id: 'hdr-1',
    };

    const ctx = createRequestContext(req as any, reply as any, baseLogger);

    expect(ctx.headers).toEqual({
      host: 'norm.test',
      accept: 'text/html,application/xhtml+xml',
      'x-empty': '',
      'x-one': 'solo',
    });
  });
});
