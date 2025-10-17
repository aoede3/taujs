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
  let headerSpy: ReturnType<typeof vi.fn>;
  let baseLogger: any;

  beforeEach(() => {
    headerSpy = vi.fn();
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

  it('uses x-trace-id header when present and SAFE_TRACE matches', () => {
    const req: Req = {
      headers: { 'x-trace-id': 'abc-123', host: 'localhost' },
      method: 'GET',
      url: '/ok',
    };

    const ctx = createRequestContext(req as any, reply as any, baseLogger);

    expect(ctx.traceId).toBe('abc-123');
    expect(reply.header).toHaveBeenCalledWith('x-trace-id', 'abc-123');
    expect(ctx.logger).toBe(baseLogger);
    expect(ctx.headers).toEqual({
      'x-trace-id': 'abc-123',
      host: 'localhost',
    });
  });

  it('falls back to req.id when x-trace-id is invalid', () => {
    const req: Req = {
      headers: { 'x-trace-id': '!!not-safe!!', host: 'localhost' },
      id: 'request-42',
      method: 'POST',
      url: '/fallback',
    };

    const ctx = createRequestContext(req as any, reply as any, baseLogger);

    expect(ctx.traceId).toBe('request-42');
    expect(reply.header).toHaveBeenCalledWith('x-trace-id', 'request-42');
  });

  it('falls back to crypto.randomUUID when no valid header and no req.id', () => {
    const req: Req = {
      headers: { host: 'example.test' },
      method: 'PUT',
      url: '/gen',
    };

    const ctx = createRequestContext(req as any, reply as any, baseLogger);

    const setTraceId = headerSpy.mock.calls.find((c) => c[0] === 'x-trace-id')?.[1] as string;

    expect(setTraceId).toBeDefined();
    expect(ctx.traceId).toBe(setTraceId);

    expect(ctx.traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('uses logger.child when provided, binding correct "this" and bindings', () => {
    let childThis: any = null;
    const derivedLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const loggerWithChild = {
      ...baseLogger,
      child: vi.fn(function (this: any, bindings: Record<string, unknown>) {
        childThis = this;
        expect(bindings).toEqual(
          expect.objectContaining({
            traceId: expect.any(String),
            url: '/child',
            method: 'GET',
          }),
        );
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
