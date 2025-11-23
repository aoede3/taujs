import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

vi.mock('../DataRoutes', () => ({
  matchRoute: vi.fn(),
  fetchInitialData: vi.fn(),
}));

vi.mock('../Telemetry', () => ({
  createRequestContext: vi.fn(),
}));

import { resolveRouteData } from '../ResolveRouteData';
import { matchRoute, fetchInitialData } from '../DataRoutes';
import { createRequestContext } from '../Telemetry';
import { AppError } from '../../logging/AppError';

type MockFastifyReq = FastifyRequest & { [key: string]: unknown };
type MockFastifyReply = FastifyReply & { [key: string]: unknown };

const matchRouteMock = vi.mocked(matchRoute);
const fetchInitialDataMock = vi.mocked(fetchInitialData);
const createRequestContextMock = vi.mocked(createRequestContext);

describe('resolveRouteData', () => {
  const url = '/test-url';

  let req: MockFastifyReq;
  let reply: MockFastifyReply;
  let routeMatchers: any[];
  let serviceRegistry: any;
  let logger: any;

  beforeEach(() => {
    vi.clearAllMocks();

    matchRouteMock.mockReset();
    fetchInitialDataMock.mockReset();
    createRequestContextMock.mockReset();

    req = { method: 'GET', url } as MockFastifyReq;
    reply = { statusCode: 200 } as MockFastifyReply;
    routeMatchers = [{ fake: 'matcher' }];
    serviceRegistry = { registry: true };
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  it('throws AppError.notFound("route_not_found") when no route matches', async () => {
    // Arrange: no match
    matchRouteMock.mockReturnValue(null);

    const notFoundSpy = vi.spyOn(AppError, 'notFound');

    await expect(
      resolveRouteData(url, {
        req,
        reply,
        routeMatchers,
        serviceRegistry,
        logger,
      }),
    ).rejects.toBeInstanceOf(AppError);

    // Ensure we called the match function
    expect(matchRouteMock).toHaveBeenCalledTimes(1);
    expect(matchRouteMock).toHaveBeenCalledWith(url, routeMatchers);

    // Ensure we called the static AppError.notFound with correct payload
    expect(notFoundSpy).toHaveBeenCalledTimes(1);
    expect(notFoundSpy).toHaveBeenCalledWith('route_not_found', {
      details: { url },
    });

    // No context or data fetch
    expect(createRequestContextMock).not.toHaveBeenCalled();
    expect(fetchInitialDataMock).not.toHaveBeenCalled();
    notFoundSpy.mockRestore();
  });

  it('throws AppError.notFound("no_data_handler") when route has no attr.data', async () => {
    const routeWithoutData = {
      path: '/no-data',
      appId: 'test-app',
      attr: {}, // no data
    };

    matchRouteMock.mockReturnValue({
      route: routeWithoutData,
      params: { id: '123' },
    } as any);

    const notFoundSpy = vi.spyOn(AppError, 'notFound');

    await expect(
      resolveRouteData(url, {
        req,
        reply,
        routeMatchers,
        serviceRegistry,
        logger,
      }),
    ).rejects.toBeInstanceOf(AppError);

    expect(matchRouteMock).toHaveBeenCalledTimes(1);
    expect(matchRouteMock).toHaveBeenCalledWith(url, routeMatchers);

    expect(notFoundSpy).toHaveBeenCalledTimes(1);
    expect(notFoundSpy).toHaveBeenCalledWith('no_data_handler', {
      details: {
        url,
        path: routeWithoutData.path,
        appId: routeWithoutData.appId,
      },
    });

    // Still no context or data fetch in this branch
    expect(createRequestContextMock).not.toHaveBeenCalled();
    expect(fetchInitialDataMock).not.toHaveBeenCalled();
    notFoundSpy.mockRestore();
  });

  it('resolves data via fetchInitialData when route and attr.data exist', async () => {
    const route = {
      path: '/with-data',
      appId: 'test-app',
      attr: {
        // existence triggers happy path
        data: vi.fn(),
      },
    };

    const params = { slug: 'abc' };
    const ctx = { ctx: true };
    const resolvedData = { foo: 'bar', meaning: 42 };

    matchRouteMock.mockReturnValue({ route, params } as any);
    createRequestContextMock.mockReturnValue(ctx as any);
    fetchInitialDataMock.mockResolvedValue(resolvedData);

    const result = await resolveRouteData(url, {
      req,
      reply,
      routeMatchers,
      serviceRegistry,
      logger,
    });

    expect(matchRouteMock).toHaveBeenCalledTimes(1);
    expect(matchRouteMock).toHaveBeenCalledWith(url, routeMatchers);

    expect(createRequestContextMock).toHaveBeenCalledTimes(1);
    expect(createRequestContextMock).toHaveBeenCalledWith(req, reply, logger);

    expect(fetchInitialDataMock).toHaveBeenCalledTimes(1);
    expect(fetchInitialDataMock).toHaveBeenCalledWith(route.attr, params, serviceRegistry, ctx);

    expect(result).toBe(resolvedData);
  });
});
