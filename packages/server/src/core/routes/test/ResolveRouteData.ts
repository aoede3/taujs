// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { AppError } from '../../errors/AppError';
import { resolveRouteDataCore } from '../ResolveRouteData';

import type { RouteMatcher } from '../DataRoutes';
import type { ServiceRegistry } from '../../services/DataServices';
import type { RequestContext } from '../../telemetry/Telemetry';
import type { Logs } from '../../logging/types';
import type { PathToRegExpParams } from '../../config/types';

// Mock the two core collaborators so we don't depend on path-to-regexp behaviour here
vi.mock('../DataRoutes', async () => {
  const actual = await vi.importActual<any>('../DataRoutes');
  return {
    ...actual,
    matchRoute: vi.fn(),
    fetchInitialData: vi.fn(),
  };
});

import { matchRoute, fetchInitialData } from '../DataRoutes';

describe('resolveRouteDataCore', () => {
  const routeMatchers: RouteMatcher<PathToRegExpParams>[] = [] as any;
  const serviceRegistry: ServiceRegistry = {} as any;

  const ctx: RequestContext<Logs> = {
    traceId: 't1',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => this as any,
      isDebugEnabled: () => false,
    } as any,
    headers: {},
  };

  it('throws AppError.notFound("route_not_found") when no route matches, and does not call getCtx()', async () => {
    (matchRoute as any).mockReturnValue(null);

    const getCtx = vi.fn(() => ctx);

    await expect(resolveRouteDataCore('/test-url', { routeMatchers, serviceRegistry, getCtx })).rejects.toMatchObject({
      name: 'AppError',
      kind: 'domain',
      message: 'route_not_found',
    });

    expect(getCtx).not.toHaveBeenCalled();
    expect(fetchInitialData).not.toHaveBeenCalled();
  });

  it('throws AppError.notFound("no_data_handler") when route has no attr.data, and does not call getCtx()', async () => {
    (matchRoute as any).mockReturnValue({
      route: { path: '/test', appId: 'a1', attr: {} },
      params: {},
      keys: [],
    });

    const getCtx = vi.fn(() => ctx);

    await expect(resolveRouteDataCore('/test-url', { routeMatchers, serviceRegistry, getCtx })).rejects.toMatchObject({
      name: 'AppError',
      kind: 'domain',
      message: 'no_data_handler',
    });

    expect(getCtx).not.toHaveBeenCalled();
    expect(fetchInitialData).not.toHaveBeenCalled();
  });

  it('calls fetchInitialData when route and attr.data exist, using ctx from getCtx()', async () => {
    const dataHandler = vi.fn(async () => ({}));

    (matchRoute as any).mockReturnValue({
      route: { path: '/test', appId: 'a1', attr: { data: dataHandler } },
      params: { id: '123' },
      keys: [],
    });

    (fetchInitialData as any).mockResolvedValue({ ok: true });

    const getCtx = vi.fn(() => ctx);

    const out = await resolveRouteDataCore('/test-url', { routeMatchers, serviceRegistry, getCtx });

    expect(getCtx).toHaveBeenCalledTimes(1);
    expect(fetchInitialData).toHaveBeenCalledTimes(1);

    const [attr, params, registry, passedCtx] = (fetchInitialData as any).mock.calls[0];
    expect(attr).toEqual({ data: dataHandler });
    expect(params).toEqual({ id: '123' });
    expect(registry).toBe(serviceRegistry);
    expect(passedCtx).toBe(ctx);

    expect(out).toEqual({ ok: true });
  });
});
