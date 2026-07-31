// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { calculateSpecificity, fetchHeadData, fetchInitialData } from '../DataRoutes';
import { AppError } from '../../errors/AppError';
import { InitialDataFailure } from '../../errors/InitialDataFailure';

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
  const mkCtx = (overrides: Partial<{ requestId: string; headers: Record<string, string>; logger: any }> = {}) => ({
    requestId: 'test-episode',
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

  it('classifies expected and unexpected failures without logging', async () => {
    const expected = { data: vi.fn(async () => Promise.reject(AppError.badRequest('nope', { x: 1 }, 'E_BAD'))) } as any;
    const unexpected = { data: vi.fn(async () => Promise.reject(new Error('boom'))) } as any;

    const expectedFailure = await fetchInitialData(expected, { id: '1' } as any, registry, mkCtx()).catch((error) => error);
    const unexpectedFailure = await fetchInitialData(unexpected, {} as any, registry, mkCtx()).catch((error) => error);

    expect(expectedFailure).toBeInstanceOf(InitialDataFailure);
    expect(expectedFailure).toMatchObject({ origin: 'attr.data', kind: 'validation', httpStatus: 400, code: 'E_BAD', details: { x: 1 }, params: { id: '1' } });
    expect(unexpectedFailure).toBeInstanceOf(InitialDataFailure);
    expect(unexpectedFailure).toMatchObject({ kind: 'infra', httpStatus: 500 });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
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
      expect(ctx.requestId).toBe('zzz');
      return { ok: true };
    });

    const out = await fetchInitialData(
      attr,
      {} as any,
      { svc: { greet: { handler: vi.fn(async () => ({})) } } } as any,
      mkCtx({ requestId: 'zzz', logger: {} as any }),
      impl as any,
    );

    expect(impl).toHaveBeenCalledWith(
      expect.any(Object), // registry
      'svc',
      'greet',
      {}, // <-- args ?? {} covered
      expect.objectContaining({ requestId: 'zzz' }), // ctx passed through
    );
    expect(out).toEqual({ ok: true });
  });

  it('retains params on the classified failure', async () => {
    const attr = { data: vi.fn(async () => Promise.reject(AppError.badRequest('nope'))) } as any;
    const failure = await fetchInitialData(attr, { p: 1 } as any, {} as any, mkCtx()).catch((error) => error);

    expect(failure).toBeInstanceOf(InitialDataFailure);
    expect(failure.params).toEqual({ p: 1 });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('classifies a hostile value without logging', async () => {
    const attr = { data: vi.fn(async () => Promise.reject({ notMessage: 'nope' })) } as any;
    const failure = await fetchInitialData(attr, {} as any, {} as any, mkCtx()).catch((error) => error);

    expect(failure).toBeInstanceOf(InitialDataFailure);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('HTML heuristic retains its hint on the classified failure', async () => {
    const base = AppError.internal('<!DOCTYPE html>', undefined, { prev: true });
    const attr = { data: vi.fn(async () => Promise.reject(base)) } as any;
    const failure = await fetchInitialData(attr, { a: 1 } as any, {} as any, mkCtx()).catch((error) => error);

    expect(failure).toBeInstanceOf(InitialDataFailure);
    expect(failure).toMatchObject({
      details: expect.objectContaining({
        prev: true,
        hint: 'api-missing-or-content-type',
        suggestion: expect.stringMatching(/ServiceDescriptor/i),
      }),
    });
    expect((failure as InitialDataFailure).details).not.toEqual(expect.objectContaining({ logged: expect.anything() }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('HTML heuristic recognises the parser shape without logging', async () => {
    const attr = { data: vi.fn(async () => Promise.reject(new Error('Unexpected token < in JSON at position 0'))) } as any;
    const failure = await fetchInitialData(attr, {} as any, {} as any, mkCtx()).catch((error) => error);

    expect(failure).toMatchObject({ details: expect.objectContaining({ hint: 'api-missing-or-content-type' }) });
    expect(logger.error).not.toHaveBeenCalled();
  });

  // The dominant real-world failure - the service call itself - is classified here, so the
  // response terminal can log the request outcome while the service diagnostic remains separate.
  it('classifies service-dispatch failures without adding a resolver record', async () => {
    const attr = { data: vi.fn(async () => ({ serviceName: 'svc', serviceMethod: 'greet', args: { name: 'Ada' } })) } as any;
    const impl = vi.fn(async () => Promise.reject(new Error('service down')));

    const failure = await fetchInitialData(attr, { id: '7' } as any, registry, mkCtx(), impl as any).catch((error) => error);

    expect(failure).toBeInstanceOf(InitialDataFailure);
    expect(failure).toMatchObject({ kind: 'infra', params: { id: '7' } });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('classifies HTML-shaped service-dispatch failures with the API hint', async () => {
    const attr = { data: vi.fn(async () => ({ serviceName: 'svc', serviceMethod: 'greet' })) } as any;
    const impl = vi.fn(async () => Promise.reject(new Error('<!DOCTYPE html><html><body>404</body></html>')));

    const failure = await fetchInitialData(attr, {} as any, registry, mkCtx(), impl as any).catch((error) => error);

    expect(failure).toMatchObject({ details: expect.objectContaining({ hint: 'api-missing-or-content-type' }) });
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('fetchHeadData (RFC 0004 H1)', () => {
  const registry = {
    svc: {
      head: { handler: vi.fn(async () => ({ t: 'x' })) },
    },
  } as any;

  const mkCtx = () => ({ requestId: 'test-episode', headers: {}, logger: { error: vi.fn(), warn: vi.fn() } });

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

  it('propagates a service-dispatch rejection raw and unlogged', async () => {
    const boom = new Error('head service down');
    const attr = { head: { data: vi.fn(async () => ({ serviceName: 'svc', serviceMethod: 'head' })) } } as any;
    const impl = vi.fn(async () => Promise.reject(boom));
    const ctx = mkCtx();

    await expect(fetchHeadData(attr, {} as any, registry, ctx as any, impl as any)).rejects.toBe(boom);

    expect(ctx.logger.error).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });
});
