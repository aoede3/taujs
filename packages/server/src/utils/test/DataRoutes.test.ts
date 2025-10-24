// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createRouteMatchers, matchRoute, matchAllRoutes, extractRouteParams, getRouteStats, fetchInitialData } from '../DataRoutes';
import { AppError } from '../../logging/AppError';

const mkRoute = (path: string, appId = 'app', attr: any = {}) => ({ path, appId, attr }) as any;

describe('createRouteMatchers / matchRoute / extractRouteParams / matchAllRoutes', () => {
  it('orders by specificity, matches first, extracts params, and matches-all', () => {
    // specific > dynamic > generic dynamic (fallback) - no wildcards/modifiers/parens
    const routes = [
      mkRoute('/users/:id'), // dynamic
      mkRoute('/users/edit'), // most specific (static)
      mkRoute('/:a/:b'), // generic fallback that matches two segments
    ];

    const matchers = createRouteMatchers(routes);
    expect(matchers.length).toBeGreaterThan(0);

    const first = matchers[0]!.route.path;
    const last = matchers[matchers.length - 1]!.route.path;
    expect(first).toBe('/users/edit');
    expect(last).toBe('/:a/:b');

    // first match for a static path
    const m1 = matchRoute('/users/edit', matchers);
    expect(m1).not.toBeNull();
    expect(m1!.route.path).toBe('/users/edit');
    expect(m1!.params).toEqual({});

    // dynamic param
    const m2 = matchRoute('/users/123', matchers);
    expect(m2).not.toBeNull();
    expect(m2!.route.path).toBe('/users/:id');
    expect(m2!.params).toEqual({ id: '123' });

    // matchAllRoutes returns all matching routes in matcher order
    const all = matchAllRoutes('/users/123', matchers);
    expect(all.map((a) => a.route.path)).toEqual(expect.arrayContaining(['/users/:id', '/:a/:b']));

    // extractRouteParams strips query/hash
    const p = extractRouteParams('/users/456?x=1#frag', '/users/:id');
    expect(p).toEqual({ id: '456' });

    // safeDecode success
    const p2 = extractRouteParams('/u/%E2%9C%93', '/u/:name');
    expect(p2).toEqual({ name: '✓' });

    // safeDecode failure (invalid percent) → returns raw segment
    const p3 = extractRouteParams('/u/%ZZabc', '/u/:name');
    expect(p3).toEqual({ name: '%ZZabc' });

    // cleanPath('') -> '/' path
    const mRoot = matchRoute('', createRouteMatchers([mkRoute('/'), mkRoute('/x')]));
    expect(mRoot!.route.path).toBe('/');
  });

  it('returns null when no route matches', () => {
    const matchers = createRouteMatchers([mkRoute('/a'), mkRoute('/b')]);
    const m = matchRoute('/c', matchers);
    expect(m).toBeNull();
  });

  it('cleanPath: path starting with "?" → basePart empty → returns "/"', () => {
    const matchers = createRouteMatchers([mkRoute('/'), mkRoute('/x')]);
    // path.split('?')[0] => ''  ⇒ basePart falsy ⇒ base = '/'
    const m = matchRoute('?q=1', matchers);
    expect(m!.route.path).toBe('/'); // exercises the ": '/'" branch
  });

  it('cleanPath: path starting with "#" → base empty after split → falls back to "/"', () => {
    const matchers = createRouteMatchers([mkRoute('/'), mkRoute('/x')]);
    // path.split('?')[0] => '#frag' ⇒ '#frag'.split('#')[0] => '' ⇒ base === ''
    const m = matchRoute('#frag', matchers);
    expect(m!.route.path).toBe('/'); // exercises the "base || '/'" branch
  });

  it('extractRouteParams returns null when the path does not match the route', () => {
    // no dynamic capture here, so it can only match exactly "/users/:id"
    const out = extractRouteParams('/nope', '/users/:id');
    expect(out).toBeNull(); // covers the ": null" branch
  });
});

describe('calculateSpecificity coverage (modifier penalty and wildcard)', () => {
  async function importerWithMatchMock() {
    vi.resetModules();
    vi.doMock('path-to-regexp', () => {
      // Minimal stub: match() returns a matcher function that always returns null.
      // We only care about createRouteMatchers calling calculateSpecificity and not throwing.
      const matchStub =
        <T extends Record<string, string>>() =>
        (_path: string) =>
          null as any;
      return { match: matchStub };
    });
    return await import('../DataRoutes');
  }

  const mkRoute = (path: string, appId = 'app', attr: any = {}) => ({ path, appId, attr }) as any;

  it('penalises params ending with +/*/? by 0.5 (e.g., ":id*" < ":id")', async () => {
    const { createRouteMatchers } = await importerWithMatchMock();

    const routes = [mkRoute('/a/:id'), mkRoute('/a/:id*')];
    const matchers = createRouteMatchers(routes);

    // We sort by specificity DESC, so the plain ":id" should come BEFORE ":id*"
    expect(matchers[0]!.route.path).toBe('/a/:id');
    expect(matchers[1]!.route.path).toBe('/a/:id*');
  });

  it('adds only 0.1 for literal "*" segment (very low specificity)', async () => {
    const { createRouteMatchers } = await importerWithMatchMock();

    const routes = [mkRoute('/solid/static'), mkRoute('/*')];
    const matchers = createRouteMatchers(routes);

    // Sorted DESC → most specific first, least specific last
    expect(matchers[0]!.route.path).toBe('/solid/static');
    expect(matchers[matchers.length - 1]!.route.path).toBe('/*');
  });
});

describe('getRouteStats', () => {
  it('computes totals, averages, per-app counts, CSP/auth flags, and extremes', () => {
    const routes = [
      mkRoute('/a', 'one', { middleware: { csp: true } }),
      mkRoute('/b/:id', 'one', { middleware: { auth: true } }),
      mkRoute('/static/path', 'two', {}),
      mkRoute('/:p', 'two', {}), // generic fallback, v6/v7 safe
    ];
    const matchers = createRouteMatchers(routes);
    expect(matchers.length).toBeGreaterThan(0);

    const stats = getRouteStats(matchers);
    expect(stats.totalRoutes).toBe(matchers.length);

    // averageSpecificity is finite
    expect(Number.isFinite(stats.averageSpecificity)).toBe(true);

    // per-app counts
    expect(stats.routesByApp).toEqual({ one: 2, two: 2 });

    // flags
    expect(stats.routesWithCSP).toBe(1);
    expect(stats.routesWithAuth).toBe(1);

    // extremes (sorted by specificity in createRouteMatchers)
    expect(stats.mostSpecific).toBe(matchers[0]!.route.path);
    expect(stats.leastSpecific).toBe(matchers[matchers.length - 1]!.route.path);
  });

  it('routesByApp uses "unknown" when appId is falsy', () => {
    const routes = [
      { path: '/has', appId: 'one', attr: {} } as any,
      { path: '/no-appid', appId: '', attr: {} } as any, // falsy appId -> "unknown"
    ];
    const matchers = createRouteMatchers(routes);
    const stats = getRouteStats(matchers);

    expect(stats.routesByApp).toEqual({ one: 1, unknown: 1 }); // covers appId || 'unknown'
  });

  it('most/leastSpecific fall back to "none" (and avg NaN) when empty input', () => {
    const stats = getRouteStats([] as any);
    expect(stats.totalRoutes).toBe(0);
    expect(Number.isNaN(stats.averageSpecificity)).toBe(true); // 0/0 -> NaN is fine
    expect(stats.routesByApp).toEqual({});
    expect(stats.routesWithCSP).toBe(0);
    expect(stats.routesWithAuth).toBe(0);
    expect(stats.mostSpecific).toBe('none'); // covers path || 'none'
    expect(stats.leastSpecific).toBe('none'); // covers path || 'none'
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
});
