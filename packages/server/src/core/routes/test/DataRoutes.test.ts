// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { calculateSpecificity, fetchHeadData, fetchInitialData } from '../DataRoutes';
import { AppError } from '../../errors/AppError';

describe('calculateSpecificity', () => {
  it('keeps the existing deterministic introspection score', () => {
    expect(calculateSpecificity('/users/edit')).toBeGreaterThan(calculateSpecificity('/users/:id'));
    expect(calculateSpecificity('/users/:id')).toBeGreaterThan(calculateSpecificity('/*'));
    expect(calculateSpecificity('/a/:id')).toBeGreaterThan(calculateSpecificity('/a/:id*'));
  });
});

describe('fetchInitialData', () => {
  const registry = {
    svc: {
      greet: {
        handler: vi.fn(async (p: any) => ({ message: `hi ${p.name}` })),
      },
    },
  } as any;

  let logger: any;

  beforeEach(() => {
    logger = {
      error: vi.fn(),
      warn: vi.fn(),
    };
  });

  // mkCtx depends on the logger set in beforeEach, so define it here
  const mkCtx = (overrides: Partial<{ traceId: string; headers: Record<string, string>; logger: any }> = {}) => ({
    traceId: 'test-trace',
    headers: {},
    logger,
    ...overrides,
  });

  it('returns {} when no data handler or not a function', async () => {
    const out1 = await fetchInitialData(undefined as any, {} as any, registry, mkCtx());
    expect(out1).toEqual({});

    const out2 = await fetchInitialData({ data: null } as any, {} as any, registry, mkCtx());
    expect(out2).toEqual({});
  });

  it('returns plain object from data handler', async () => {
    const attr = { data: vi.fn(async () => ({ a: 1, b: 2 })) } as any;
    const out = await fetchInitialData(attr, {} as any, registry, mkCtx());
    expect(out).toEqual({ a: 1, b: 2 });
  });

  it('dispatches ServiceDescriptor via callServiceMethodImpl', async () => {
    const attr = {
      data: vi.fn(async () => ({ serviceName: 'svc', serviceMethod: 'greet', args: { name: 'Ada' } })),
    } as any;

    const impl = vi.fn(async () => ({ message: 'hi Ada' }));

    const out = await fetchInitialData(attr, {} as any, registry, mkCtx(), impl as any);
    expect(impl).toHaveBeenCalledWith(registry, 'svc', 'greet', { name: 'Ada' }, expect.any(Object));
    expect(out).toEqual({ message: 'hi Ada' });
  });

  it('throws badRequest for non-object non-descriptor returns', async () => {
    const attr = { data: vi.fn(async () => 42 as any) } as any;
    await expect(fetchInitialData(attr, {} as any, registry, mkCtx())).rejects.toThrow(/attr\.data must return a plain object or a ServiceDescriptor/);
  });

  it('logs warn for domain/validation/auth errors and rethrows', async () => {
    const attr = {
      data: vi.fn(async () => {
        throw AppError.badRequest('nope', { x: 1 }, 'E_BAD');
      }),
    } as any;

    await expect(fetchInitialData(attr, {} as any, registry, mkCtx({ traceId: 't1' }))).rejects.toThrow(/nope/);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'fetch-initial-data',
        kind: 'validation',
        httpStatus: 400,
        code: 'E_BAD',
        details: { x: 1 },
        traceId: 't1',
      }),
      'nope',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs error for infra/upstream/etc errors and rethrows', async () => {
    const attr = {
      data: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as any;

    await expect(fetchInitialData(attr, {} as any, registry, mkCtx({ traceId: 't2' }))).rejects.toThrow(/boom/);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'fetch-initial-data',
        kind: 'infra',
        httpStatus: 500,
        traceId: 't2',
      }),
      'boom',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('normalises ctx.headers to an object', async () => {
    const spy = vi.fn(async (_params, ctx) => ({
      gotHeaders: !!ctx.headers && typeof ctx.headers === 'object',
    }));
    const attr = { data: spy } as any;

    const out1 = await fetchInitialData(
      attr,
      {} as any,
      registry,
      { ...mkCtx(), headers: undefined } as any, // intentionally invalid to cover normalisation
    );
    expect(out1).toEqual({ gotHeaders: true });

    const out2 = await fetchInitialData(attr, {} as any, registry, mkCtx({ headers: { a: 'b' } }));
    expect(out2).toEqual({ gotHeaders: true });
  });

  it('uses {} when ServiceDescriptor.args is undefined (covers args ?? {}) and passes ctx through', async () => {
    const attr = {
      data: vi.fn(async () => ({ serviceName: 'svc', serviceMethod: 'greet' /* no args */ })),
    } as any;

    const impl = vi.fn(async (_registry, _svc, _method, args, ctx) => {
      expect(args).toEqual({});
      expect(ctx.traceId).toBe('zzz');
      return { ok: true };
    });

    const out = await fetchInitialData(
      attr,
      {} as any,
      { svc: { greet: { handler: vi.fn(async () => ({})) } } } as any,
      mkCtx({ traceId: 'zzz', logger: {} as any }),
      impl as any,
    );

    expect(impl).toHaveBeenCalledWith(
      expect.any(Object), // registry
      'svc',
      'greet',
      {}, // <-- args ?? {} covered
      expect.objectContaining({ traceId: 'zzz' }), // ctx passed through
    );
    expect(out).toEqual({ ok: true });
  });

  it('includes params in meta when params is truthy (e.g., an object)', async () => {
    const attr = {
      data: vi.fn(async () => {
        throw AppError.badRequest('nope');
      }),
    } as any;

    await expect(fetchInitialData(attr, { p: 1 } as any, {} as any, mkCtx({ traceId: 'pp1' }))).rejects.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'fetch-initial-data',
        kind: 'validation',
        httpStatus: 400,
        traceId: 'pp1',
        params: { p: 1 },
      }),
      'nope',
    );
  });

  it('omits params in meta when params is falsy (covers ": {}" branch)', async () => {
    const attr = {
      data: vi.fn(async () => {
        throw new Error('boom2');
      }),
    } as any;

    await expect(fetchInitialData(attr, undefined as any, {} as any, mkCtx({ traceId: 'pp2' }))).rejects.toThrow('boom2');

    const [meta, msg] = (logger.error as any).mock.calls.pop()!;
    expect(meta).toEqual(
      expect.not.objectContaining({
        params: expect.anything(),
      }),
    );
    expect(msg).toBe('boom2');
  });

  it('falls back to empty message when err.message is undefined (covers ?.message ?? "")', async () => {
    const attr = {
      data: vi.fn(async () => {
        throw { notMessage: 'nope' } as any;
      }),
    } as any;

    await expect(fetchInitialData(attr, {} as any, {} as any, mkCtx({ traceId: 'no-msg' }))).rejects.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'fetch-initial-data',
        kind: 'infra',
        httpStatus: 500,
        traceId: 'no-msg',
      }),
      expect.any(String),
    );
    const [meta] = (logger.error as any).mock.calls.pop();
    expect(meta.details?.hint).toBeUndefined();
    expect(meta.details?.logged).toBeUndefined();
  });

  it('HTML heuristic: merges existing object details and adds hint/suggestion/logged', async () => {
    const base = AppError.internal('<!DOCTYPE html>', undefined, { prev: true });

    const attr = {
      data: vi.fn(async () => {
        throw base;
      }),
    } as any;

    await expect(fetchInitialData(attr, { a: 1 } as any, {} as any, mkCtx({ traceId: 'html-obj' }))).rejects.toThrow(/expected JSON but received HTML/i);

    expect(logger.error).toHaveBeenCalled();
    const [meta, msg] = (logger.error as any).mock.calls.pop();

    expect(msg).toMatch(/expected JSON but received HTML/i);
    expect(meta.details).toEqual(
      expect.objectContaining({
        prev: true,
        hint: 'api-missing-or-content-type',
        suggestion: expect.stringMatching(/ServiceDescriptor/i),
        logged: true,
      }),
    );
  });

  it('HTML heuristic: ignores non-object previous details and still adds hint/suggestion/logged', async () => {
    const base = AppError.internal('<html>', undefined, 'oops' as any);

    const attr = {
      data: vi.fn(async () => {
        throw base;
      }),
    } as any;

    await expect(fetchInitialData(attr, {} as any, {} as any, mkCtx({ traceId: 'html-nonobj' }))).rejects.toThrow(/expected JSON but received HTML/i);

    const [meta] = (logger.error as any).mock.calls.pop();
    expect(meta.details).toEqual(
      expect.objectContaining({
        hint: 'api-missing-or-content-type',
        suggestion: expect.any(String),
        logged: true,
      }),
    );
    expect(meta.details.prev).toBeUndefined();
  });

  it('HTML heuristic: triggers on "Unexpected token < ... JSON" parser shape', async () => {
    const attr = {
      data: vi.fn(async () => {
        throw new Error('Unexpected token < in JSON at position 0');
      }),
    } as any;

    await expect(fetchInitialData(attr, {} as any, {} as any, mkCtx({ traceId: 'html-unexp' }))).rejects.toThrow(/expected JSON but received HTML/i);

    const [meta] = (logger.error as any).mock.calls.pop();
    expect(meta.details).toEqual(
      expect.objectContaining({
        hint: 'api-missing-or-content-type',
        logged: true,
      }),
    );
  });
});

describe('fetchHeadData (RFC 0004 H1)', () => {
  const registry = {
    svc: {
      head: { handler: vi.fn(async () => ({ t: 'x' })) },
    },
  } as any;

  const mkCtx = () => ({ traceId: 'test-trace', headers: {}, logger: { error: vi.fn(), warn: vi.fn() } });

  it('returns undefined when the route declares no head', async () => {
    expect(await fetchHeadData(undefined as any, {} as any, registry, mkCtx() as any)).toBeUndefined();
    expect(await fetchHeadData({ render: 'ssr' } as any, {} as any, registry, mkCtx() as any)).toBeUndefined();
    expect(await fetchHeadData({ head: { data: null } } as any, {} as any, registry, mkCtx() as any)).toBeUndefined();
  });

  it('returns a plain object from the head handler', async () => {
    const attr = { head: { data: vi.fn(async () => ({ title: 'T' })) } } as any;
    expect(await fetchHeadData(attr, {} as any, registry, mkCtx() as any)).toEqual({ title: 'T' });
  });

  it('dispatches a ServiceDescriptor via callServiceMethodImpl', async () => {
    const attr = {
      head: { data: vi.fn(async () => ({ serviceName: 'svc', serviceMethod: 'head', args: { id: '1' } })) },
    } as any;
    const impl = vi.fn(async () => ({ title: 'from-service' }));

    const out = await fetchHeadData(attr, {} as any, registry, mkCtx() as any, impl as any);
    expect(impl).toHaveBeenCalledWith(registry, 'svc', 'head', { id: '1' }, expect.any(Object));
    expect(out).toEqual({ title: 'from-service' });
  });

  it('throws badRequest for non-object non-descriptor returns', async () => {
    const attr = { head: { data: vi.fn(async () => 42 as any) } } as any;
    await expect(fetchHeadData(attr, {} as any, registry, mkCtx() as any)).rejects.toThrow(
      /attr\.head\.data must return a plain object or a ServiceDescriptor/,
    );
  });

  it('propagates raw rejections unclassified - the caller owns the taxonomy', async () => {
    const boom = new Error('head boom');
    const attr = { head: { data: vi.fn(async () => Promise.reject(boom)) } } as any;
    await expect(fetchHeadData(attr, {} as any, registry, mkCtx() as any)).rejects.toBe(boom);
  });
});
