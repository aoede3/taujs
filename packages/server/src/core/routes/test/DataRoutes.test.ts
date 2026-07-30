// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { calculateSpecificity, fetchHeadData, fetchInitialData } from '../DataRoutes';
import { AppError } from '../../errors/AppError';
import { wasErrorLogged } from '../../errors/ErrorLogState';

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

  it('HTML heuristic: merges existing object details and adds hint/suggestion only', async () => {
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
      }),
    );
    // `details` is application data, never log state - the wrapper contributes no `logged` key.
    expect(meta.details.logged).toBeUndefined();
  });

  it('HTML heuristic: ignores non-object previous details and still adds hint/suggestion', async () => {
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
      }),
    );
    expect(meta.details.prev).toBeUndefined();
    expect(meta.details.logged).toBeUndefined();
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
      }),
    );
    expect(meta.details.logged).toBeUndefined();
  });

  // The dominant real-world failure - the service call itself - is classified by this layer, which
  // is also the only way the HTML hint can fire for the case its text describes.
  it('classifies a service-dispatch rejection under component fetch-initial-data', async () => {
    const attr = {
      data: vi.fn(async () => ({ serviceName: 'svc', serviceMethod: 'greet', args: { name: 'Ada' } })),
    } as any;
    const impl = vi.fn(async () => {
      throw new Error('service down');
    });

    await expect(fetchInitialData(attr, { id: '7' } as any, registry, mkCtx({ traceId: 'svc-fail' }), impl as any)).rejects.toThrow(/service down/);

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [meta, msg] = (logger.error as any).mock.calls[0];
    expect(meta).toEqual(
      expect.objectContaining({
        component: 'fetch-initial-data',
        kind: 'infra',
        httpStatus: 500,
        traceId: 'svc-fail',
        params: { id: '7' },
      }),
    );
    expect(msg).toBe('service down');
  });

  it('classifies an HTML-shaped service-dispatch rejection with the api-missing hint', async () => {
    const attr = {
      data: vi.fn(async () => ({ serviceName: 'svc', serviceMethod: 'greet' })),
    } as any;
    const impl = vi.fn(async () => {
      throw new Error('<!DOCTYPE html><html><body>404</body></html>');
    });

    await expect(fetchInitialData(attr, {} as any, registry, mkCtx({ traceId: 'svc-html' }), impl as any)).rejects.toThrow(/expected JSON but received HTML/i);

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [meta, msg] = (logger.error as any).mock.calls[0];
    expect(msg).toMatch(/expected JSON but received HTML/i);
    expect(meta.details).toEqual(
      expect.objectContaining({
        hint: 'api-missing-or-content-type',
        suggestion: expect.stringMatching(/ServiceDescriptor/i),
      }),
    );
    expect(meta.details.logged).toBeUndefined();
  });

  it('produces exactly ONE record for a handler rejection, an invalid result and a dispatch rejection', async () => {
    const cases: ReadonlyArray<readonly [string, unknown, unknown]> = [
      [
        'handler rejection',
        {
          data: async () => {
            throw new Error('handler boom');
          },
        },
        undefined,
      ],
      ['invalid result', { data: async () => 42 }, undefined],
      [
        'dispatch rejection',
        { data: async () => ({ serviceName: 'svc', serviceMethod: 'greet' }) },
        async () => {
          throw new Error('dispatch boom');
        },
      ],
    ];

    for (const [name, attr, impl] of cases) {
      logger.warn.mockClear();
      logger.error.mockClear();

      await expect(fetchInitialData(attr as any, {} as any, registry, mkCtx(), impl as any)).rejects.toThrow();

      expect(logger.warn.mock.calls.length + logger.error.mock.calls.length, name).toBe(1);
    }
  });

  it('marks the classified error under the request key, so a response terminal can tell it is already reported', async () => {
    const attr = {
      data: vi.fn(async () => {
        throw new Error('marked');
      }),
    } as any;
    const requestKey = {};

    const e = await fetchInitialData(attr, {} as any, registry, mkCtx(), undefined, requestKey).catch((thrown) => thrown);

    expect(wasErrorLogged(requestKey, e)).toBe(true);
  });

  it('a mark is request-scoped: the same error object marked under request A stays unmarked under request B', async () => {
    // An application may legally throw ONE long-lived error object from many places. A mark left
    // by request A's classification must not let request B's terminal suppress ITS only record.
    const singleton = AppError.internal('module-level shared failure');
    const attr = { data: vi.fn(async () => Promise.reject(singleton)) } as any;
    const requestA = {};
    const requestB = {};

    const e = await fetchInitialData(attr, {} as any, registry, mkCtx(), undefined, requestA).catch((thrown) => thrown);

    expect(e).toBe(singleton);
    expect(wasErrorLogged(requestA, e)).toBe(true);
    expect(wasErrorLogged(requestB, e)).toBe(false);
  });

  it('without a request key the classified error stays unmarked - the terminal logs (fail safe)', async () => {
    const attr = { data: vi.fn(async () => Promise.reject(new Error('keyless'))) } as any;

    const e = await fetchInitialData(attr, {} as any, registry, mkCtx()).catch((thrown) => thrown);

    expect(wasErrorLogged({}, e)).toBe(false);
  });

  it('a throwing logger forfeits the record without changing the propagated error or marking it', async () => {
    const down = () => {
      throw new Error('logger down');
    };
    const brokenLogger = { warn: vi.fn(down), error: vi.fn(down) };
    const boom = AppError.badRequest('still mine');
    const attr = { data: vi.fn(async () => Promise.reject(boom)) } as any;
    const requestKey = {};

    const e = await fetchInitialData(attr, {} as any, registry, mkCtx({ logger: brokenLogger as any }), undefined, requestKey).catch((thrown) => thrown);

    expect(e).toBe(boom);
    expect(brokenLogger.warn).toHaveBeenCalledTimes(1);
    expect(wasErrorLogged(requestKey, e)).toBe(false);
  });

  it('real service dispatch: one service-call record, one classification record, and the marked error silences only the terminal', async () => {
    // The REAL callServiceMethod logs 'Service method failed' before rethrowing - an intentional
    // service-layer diagnostic that stays a separate record. The contract is exactly one
    // fetch-initial-data classification record with no repeated response-terminal record, NOT one
    // record in total across layers.
    const records: Array<{ level: string; msg: string }> = [];
    const capture = (level: string) =>
      vi.fn((_meta: unknown, msg?: string) => {
        records.push({ level, msg: msg ?? '' });
      });
    const captureLogger: any = { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') };
    captureLogger.child = vi.fn(() => captureLogger);

    const failure = new Error('upstream unavailable');
    const realRegistry = {
      catalogue: {
        load: vi.fn(async () => {
          throw failure;
        }),
      },
    } as any;
    const attr = { data: vi.fn(async () => ({ serviceName: 'catalogue', serviceMethod: 'load', args: {} })) } as any;
    const requestKey = {};

    const e = await fetchInitialData(attr, {} as any, realRegistry, mkCtx({ logger: captureLogger }), undefined, requestKey).catch((thrown) => thrown);

    const serviceRecords = records.filter((r) => r.msg === 'Service method failed');
    const boundaryRecords = records.filter((r) => r.msg === (e as Error).message);
    expect(serviceRecords).toHaveLength(1);
    expect(boundaryRecords).toHaveLength(1);
    expect(records.filter((r) => r.level === 'warn' || r.level === 'error')).toHaveLength(2);
    expect(wasErrorLogged(requestKey, e)).toBe(true);
  });

  it('an expected 4xx is ONE stackless warn; an unexpected failure is ONE error carrying a stack', async () => {
    const expected = {
      data: vi.fn(async () => {
        throw AppError.forbidden('not yours');
      }),
    } as any;

    await expect(fetchInitialData(expected, {} as any, registry, mkCtx())).rejects.toThrow(/not yours/);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect((logger.warn as any).mock.calls[0][0].stack).toBeUndefined();

    logger.warn.mockClear();

    const unexpected = {
      data: vi.fn(async () => {
        throw new Error('infra boom');
      }),
    } as any;

    await expect(fetchInitialData(unexpected, {} as any, registry, mkCtx())).rejects.toThrow(/infra boom/);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(typeof (logger.error as any).mock.calls[0][0].stack).toBe('string');
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

  it('propagates a service-dispatch rejection raw too - unlogged and unmarked', async () => {
    const boom = new Error('head service down');
    const attr = { head: { data: vi.fn(async () => ({ serviceName: 'svc', serviceMethod: 'head' })) } } as any;
    const impl = vi.fn(async () => Promise.reject(boom));
    const ctx = mkCtx();

    await expect(fetchHeadData(attr, {} as any, registry, ctx as any, impl as any)).rejects.toBe(boom);

    expect(ctx.logger.error).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    expect(wasErrorLogged(ctx, boom)).toBe(false);
  });
});
