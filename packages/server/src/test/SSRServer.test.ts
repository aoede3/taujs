// @vitest-environment node

import fastify from 'fastify';
import { beforeEach, afterEach, describe, it, expect, vi, type Mock } from 'vitest';
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';

const {
  AppErrorFake,
  mockLogger,
  maps,
  processConfigsMock,
  loadAssetsMock,
  routeMatchersMock,
  // authHookFn,
  createAuthHookMock,
  cspPluginMock,
  cspReportPluginMock,
  devRef,
  handleRenderMock,
  handleNotFoundMock,
  setupDevServerMock,
  toHttpMock,
  resolveRouteDataMock,
} = vi.hoisted(() => {
  class AppErrorFake {
    message!: string;
    kind = 'infra';
    httpStatus = 500;
    code?: string;
    details?: unknown;
    stack = 'stack';
    safeMessage?: string;
    static from = vi.fn((err: any) =>
      Object.assign(new AppErrorFake(), {
        message: err?.message ?? 'boom',
        httpStatus: err?.httpStatus ?? 500,
        details: err?.details,
      }),
    );
  }

  const mockLogger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

  const maps = {
    bootstrapModules: new Map<string, string>(),
    cssLinks: new Map<string, string>(),
    manifests: new Map<string, string>(),
    preloadLinks: new Map<string, string>(),
    renderModules: new Map<string, string>(),
    ssrManifests: new Map<string, string>(),
    templates: new Map<string, string>(),
  };

  const processConfigsMock = vi.fn((configs: any[], baseClientRoot: string, TEMPLATE: unknown) =>
    configs.map((c: any) => ({ ...c, clientRoot: baseClientRoot, template: TEMPLATE })),
  );
  const loadAssetsMock = vi.fn(async () => {});
  const routeMatchersMock = { match: vi.fn() };
  const authHookFn = vi.fn((_req: any, _reply: any, done: any) => done && done());
  const createAuthHookMock = vi.fn(() => authHookFn);
  const cspPluginMock = vi.fn(async (_instance: any, _opts: any, done?: () => void) => done?.());
  const cspReportPluginMock = vi.fn(async (_instance: any, _opts: any, done?: () => void) => done?.());
  const devRef = { value: false };
  const handleRenderMock = vi.fn(async (_req: any, reply: any) => {
    reply.status(200).send('OK:handleRender');
  });
  const handleNotFoundMock = vi.fn(async (_req: any, reply: any) => {
    reply.status(200).send('OK:notFound');
  });
  const setupDevServerMock = vi.fn(async () => ({ name: 'vite-dev' }));
  const toHttpMock = vi.fn((_e: any) => ({ status: 499, body: { message: 'safe' } }));
  const resolveRouteDataMock = vi.fn<() => Promise<Record<string, unknown>>>(async () => ({ userId: 123, name: 'Test' }));

  return {
    AppErrorFake,
    mockLogger,
    maps,
    processConfigsMock,
    loadAssetsMock,
    routeMatchersMock,
    authHookFn,
    createAuthHookMock,
    cspPluginMock,
    cspReportPluginMock,
    devRef,
    handleRenderMock,
    handleNotFoundMock,
    setupDevServerMock,
    toHttpMock,
    resolveRouteDataMock,
  };
});

vi.mock('../logging/Logger', () => ({ createLogger: vi.fn(() => mockLogger) }));

vi.mock('../utils/AssetManager', () => ({
  createMaps: vi.fn(() => maps),
  loadAssets: loadAssetsMock,
  processConfigs: processConfigsMock,
}));

vi.mock('../utils/DataRoutes', () => ({ createRouteMatchers: vi.fn(() => routeMatchersMock) }));

vi.mock('../security/Auth', () => ({ createAuthHook: createAuthHookMock }));

vi.mock('../security/CSP', () => ({ cspPlugin: cspPluginMock }));

vi.mock('../security/CSPReporting', () => ({ cspReportPlugin: cspReportPluginMock }));

vi.mock('../utils/System', () => ({
  get isDevelopment() {
    return devRef.value;
  },
}));

vi.mock('../utils/HandleRender', () => ({ handleRender: handleRenderMock }));

vi.mock('../utils/HandleNotFound', () => ({ handleNotFound: handleNotFoundMock }));

vi.mock('../utils/DevServer', () => ({ setupDevServer: setupDevServerMock }));

vi.mock('../logging/utils', () => ({ toHttp: toHttpMock }));

vi.mock('../logging/AppError', () => ({ AppError: AppErrorFake }));

vi.mock('../utils/ResolveRouteData', () => ({ resolveRouteData: resolveRouteDataMock }));

import { SSRServer, TEMPLATE } from '../SSRServer';
import { loadAssets } from '../utils/AssetManager';
import { createAuthHook } from '../security/Auth';
import { createLogger } from '../logging/Logger';

describe('SSRServer', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    devRef.value = false;
    app = fastify();

    // Shim: some path-to-regexp versions dislike '/*' - translate to '*' during test
    const origGet = (app.get as any).bind(app) as (...args: any[]) => any;
    (app as any).get = (path: string, ...rest: any[]) => {
      if (path === '/*') {
        return origGet.apply(app, ['*', ...rest]);
      }
      return origGet.apply(app, [path, ...rest]);
    };
  });

  afterEach(async () => {
    await app.close();
  });

  it('re-exports TEMPLATE', () => {
    expect(TEMPLATE).toBeDefined();
  });

  it('basic registration wires assets, CSP, auth, GET, notFound', async () => {
    const addHookSpy = vi.spyOn(app, 'addHook');

    await app.register(SSRServer, {
      alias: {},
      configs: [{ appId: 'a', entryPoint: '.' }],
      routes: [{ path: '/*' }],
      serviceRegistry: {},
      clientRoot: '/client',
      debug: false,
      security: {},
    });

    // Assets wired
    expect(processConfigsMock).toHaveBeenCalledWith(expect.any(Array), '/client', TEMPLATE);
    expect(loadAssets).toHaveBeenCalledWith(
      expect.any(Array),
      '/client',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      expect.objectContaining({ logger: mockLogger, debug: false }),
    );

    // CSP plugin called with route matchers + debug
    const cspCall = cspPluginMock.mock.calls[0];
    expect(cspCall?.[1]).toEqual(
      expect.objectContaining({
        directives: undefined,
        generateCSP: undefined,
        routeMatchers: routeMatchersMock,
        debug: false,
      }),
    );

    // Auth hook added and executes
    expect(addHookSpy).toHaveBeenCalledWith('onRequest', expect.any(Function));
    expect(createAuthHook).toHaveBeenCalledWith(expect.any(Object), mockLogger);

    // GET route triggers handleRender
    const res = await app.inject({ method: 'GET', url: '/anything' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('OK:handleRender');

    // notFound is set - exercise by hitting an unmapped verb/path
    const res2 = await app.inject({ method: 'DELETE', url: '/nope' });
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toBe('OK:notFound');

    // ensure notFound called with expected maps subset
    expect(handleNotFoundMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Array),
      {
        cssLinks: maps.cssLinks,
        bootstrapModules: maps.bootstrapModules,
        templates: maps.templates,
      },
      expect.objectContaining({ logger: mockLogger, debug: false }),
    );
  });

  it('does not require serviceRegistry option', async () => {
    await app.register(SSRServer, {
      alias: {},
      configs: [{ appId: 'a', entryPoint: '.' }],
      routes: [{ path: '/*' }],
      clientRoot: '/client',
      debug: false,
    });

    const res = await app.inject({ method: 'GET', url: '/anything' });

    expect(res.statusCode).toBe(200);
    expect(handleRenderMock).toHaveBeenCalled();
  });

  it('supports /__taujs/data when serviceRegistry is omitted', async () => {
    resolveRouteDataMock.mockResolvedValueOnce({ ok: true } as any);

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [{ path: '/app/dashboard' }],
      clientRoot: '/client',
      debug: false,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/__taujs/data?url=/app/dashboard',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { ok: true } });
    expect(resolveRouteDataMock).toHaveBeenCalled();
  });

  it('registers static assets when provided as object', async () => {
    const staticPlugin: FastifyPluginCallback<any> = (inst, _opts, done) => {
      inst.get('/static-check', async (_req, reply) => reply.send('static-ok'));
      done();
    };

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
      debug: true,
      staticAssets: { plugin: staticPlugin, options: { foo: 'bar' } },
    });

    const res = await app.inject({ method: 'GET', url: '/static-check' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('static-ok');
  });

  it('registers CSP reporting when configured', async () => {
    const onViolation = vi.fn();

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
      debug: ['errors'],
      security: { csp: { reporting: { endpoint: '/csp-end', onViolation } } },
    });

    expect(cspReportPluginMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: '/csp-end',
        debug: ['errors'],
        logger: mockLogger,
        onViolation,
      }),
      expect.any(Function),
    );
  });

  it('starts dev server only when isDevelopment = true and passes it to handleRender', async () => {
    devRef.value = true;

    await app.register(SSRServer, {
      alias: { '@': '/src' },
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
      debug: { all: true },
      devNet: { host: 'localhost', hmrPort: 5173 },
    });

    expect(setupDevServerMock).toHaveBeenCalledWith(expect.any(Object), '/client', { '@': '/src' }, { all: true }, { host: 'localhost', hmrPort: 5173 });

    await app.inject({ method: 'GET', url: '/x' });

    const lastCall = handleRenderMock.mock.calls[handleRenderMock.mock.calls.length - 1] as any[] | undefined;
    const opts = lastCall?.[6] as any;
    expect(opts?.viteDevServer).toBeDefined();
  });

  it('non-dev mode does not set viteDevServer', async () => {
    devRef.value = false;

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
      debug: false,
    });

    await app.inject({ method: 'GET', url: '/x' });

    const lastCall = handleRenderMock.mock.calls[handleRenderMock.mock.calls.length - 1] as any[] | undefined;
    const opts = lastCall?.[6] as any;
    expect(opts?.viteDevServer).toBeUndefined();
  });

  it('error handler: logs + uses toHttp when headers not sent', async () => {
    handleRenderMock.mockImplementationOnce(async () => {
      const err: any = new Error('render-fail');
      err.httpStatus = 418;
      err.details = { a: 1 };
      throw err;
    });

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    const res = await app.inject({ method: 'GET', url: '/err' });

    expect(AppErrorFake.from).toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        httpStatus: 418,
        method: 'GET',
        url: '/err',
        route: expect.anything(),
        stack: 'stack',
      }),
      expect.any(String),
    );
    expect(toHttpMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(499);
    expect(res.json()).toEqual({ message: 'safe' });
  });

  it('error handler: ends raw stream if headers already sent', async () => {
    let errorHandlerFn: any;

    const setErrorHandlerSpy = vi.spyOn(app, 'setErrorHandler');

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    errorHandlerFn = setErrorHandlerSpy.mock.calls[0]?.[0];
    expect(errorHandlerFn).toBeDefined();

    const mockReq = { method: 'GET', url: '/test', routeOptions: { url: '/test' } };
    const mockReply = {
      raw: {
        headersSent: true,
        end: vi.fn(),
      },
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    const testError = new Error('test-error');

    errorHandlerFn(testError, mockReq, mockReply);

    expect(AppErrorFake.from).toHaveBeenCalledWith(testError);
    expect(toHttpMock).not.toHaveBeenCalled();
    expect(mockReply.raw.end).toHaveBeenCalled();
    expect(mockReply.status).not.toHaveBeenCalled();
    expect(mockReply.send).not.toHaveBeenCalled();
  });

  it('uses minLevel "debug" when not in production', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
      debug: false,
    });

    const args = (createLogger as unknown as Mock).mock.calls[0]![0];
    expect(args.minLevel).toBe('debug');

    process.env.NODE_ENV = orig;
  });

  it('uses minLevel "info" when NODE_ENV=production', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
      debug: false,
    });

    const args = (createLogger as unknown as Mock).mock.calls[0]![0];
    expect(args.minLevel).toBe('info');

    process.env.NODE_ENV = orig;
  });

  it('registers static assets with default empty options when options is undefined', async () => {
    let capturedOpts: any;
    const staticPlugin: FastifyPluginCallback<any> = (inst, opts, done) => {
      capturedOpts = opts;
      inst.get('/static-default', async (_req, reply) => reply.send('ok-default'));
      done();
    };

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/pub',
      debug: false,
      staticAssets: { plugin: staticPlugin }, // <-- no options
    });

    // plugin should have received our base fields + spread of {} (no crash)
    expect(capturedOpts).toEqual(
      expect.objectContaining({
        root: '/client',
        prefix: '/',
        index: false,
        wildcard: false,
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/static-default' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok-default');
  });

  it('error handler includes {code} only when e.code is truthy', async () => {
    // const originalFrom = (AppErrorFake.from as Mock).mockImplementation;

    (AppErrorFake.from as Mock).mockImplementation((err: any) =>
      Object.assign(new AppErrorFake(), {
        message: err?.message ?? 'boom',
        httpStatus: 500,
        details: { x: 1 },
        code: 'E42',
      }),
    );

    handleRenderMock.mockImplementationOnce(async () => {
      throw new Error('kaboom');
    });

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    await app.inject({ method: 'GET', url: '/err2' });

    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'E42' }), expect.any(String));
  });

  it('error handler: suppresses duplicate top-level error when details.logged = true', async () => {
    (AppErrorFake.from as Mock).mockImplementation((err: any) =>
      Object.assign(new AppErrorFake(), {
        message: err?.message ?? 'boom',
        httpStatus: err?.httpStatus ?? 500,
        details: err?.details,
      }),
    );

    handleRenderMock.mockImplementationOnce(async () => {
      const err: any = new Error('dup-logged');
      err.httpStatus = 500;
      err.details = { logged: true, note: 'downstream already logged' };
      throw err;
    });

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    const res = await app.inject({ method: 'GET', url: '/dup' });

    expect(mockLogger.error).not.toHaveBeenCalled();

    expect(toHttpMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(499);
    expect(res.json()).toEqual({ message: 'safe' });
  });

  it('error handler: does NOT suppress when details is non-object', async () => {
    handleRenderMock.mockImplementationOnce(async () => {
      const err: any = new Error('nonobj-details');
      err.httpStatus = 502;
      err.details = 'oops';
      throw err;
    });

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    const resA = await app.inject({ method: 'GET', url: '/nonobj' });
    expect(mockLogger.error).toHaveBeenCalled();
    expect(toHttpMock).toHaveBeenCalled();
    expect(resA.statusCode).toBe(499);
  });

  it('error handler: does NOT suppress when details.logged is falsy', async () => {
    const app2 = fastify();

    const origGet2 = (app2.get as any).bind(app2) as (...args: any[]) => any;
    (app2 as any).get = (path: string, ...rest: any[]) => {
      if (path === '/*') return origGet2.apply(app2, ['*', ...rest]);
      return origGet2.apply(app2, [path, ...rest]);
    };

    handleRenderMock.mockImplementationOnce(async () => {
      const err: any = new Error('logged-false');
      err.httpStatus = 503;
      err.details = { logged: false, x: 1 };
      throw err;
    });

    await app2.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    const resB = await app2.inject({ method: 'GET', url: '/loggedfalse' });
    expect(mockLogger.error).toHaveBeenCalled();
    expect(toHttpMock).toHaveBeenCalled();
    expect(resB.statusCode).toBe(499);

    await app2.close();
  });

  describe('/__taujs/data endpoint', () => {
    beforeEach(() => {
      resolveRouteDataMock.mockReset();
      resolveRouteDataMock.mockResolvedValue({ userId: 123, name: 'Test User' } as any);
    });

    it('returns data when url query param is provided', async () => {
      await app.register(SSRServer, {
        alias: {},
        configs: [],
        routes: [{ path: '/app/dashboard' }],
        serviceRegistry: { someService: {} },
        clientRoot: '/client',
        debug: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/__taujs/data?url=/app/dashboard',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: { userId: 123, name: 'Test User' },
      });

      expect(resolveRouteDataMock).toHaveBeenCalledWith(
        '/app/dashboard',
        expect.objectContaining({
          req: expect.any(Object),
          reply: expect.any(Object),
          routeMatchers: routeMatchersMock,
          serviceRegistry: { someService: {} },
          logger: mockLogger,
        }),
      );
    });

    it('throws AppError.badRequest when url query param is missing', async () => {
      await app.register(SSRServer, {
        alias: {},
        configs: [],
        routes: [],
        serviceRegistry: {},
        clientRoot: '/client',
        debug: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/__taujs/data',
      });

      // Should trigger error handler which calls AppError.from and toHttp
      expect(AppErrorFake.from).toHaveBeenCalled();
      expect(res.statusCode).toBe(499); // toHttpMock returns 499
    });

    it('throws AppError.badRequest when url query param is empty string', async () => {
      await app.register(SSRServer, {
        alias: {},
        configs: [],
        routes: [],
        serviceRegistry: {},
        clientRoot: '/client',
        debug: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/__taujs/data?url=',
      });

      expect(AppErrorFake.from).toHaveBeenCalled();
      expect(res.statusCode).toBe(499);
    });

    it('throws AppError.badRequest when url query param is not a string', async () => {
      await app.register(SSRServer, {
        alias: {},
        configs: [],
        routes: [],
        serviceRegistry: {},
        clientRoot: '/client',
        debug: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/__taujs/data?url[]=invalid',
      });

      expect(AppErrorFake.from).toHaveBeenCalled();
      expect(res.statusCode).toBe(499);
    });

    it('handles complex URLs with query parameters', async () => {
      // Override the mock for this specific test
      resolveRouteDataMock.mockResolvedValueOnce({ items: [1, 2, 3] });

      await app.register(SSRServer, {
        alias: {},
        configs: [],
        routes: [],
        serviceRegistry: {},
        clientRoot: '/client',
        debug: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/__taujs/data?url=/app/search%3Fq%3Dtest%26page%3D2',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { items: [1, 2, 3] } });

      expect(resolveRouteDataMock).toHaveBeenCalledWith('/app/search?q=test&page=2', expect.any(Object));
    });

    it('passes through resolveRouteData errors to error handler', async () => {
      // Make the mock throw an error
      resolveRouteDataMock.mockRejectedValueOnce(
        Object.assign(new Error('Data resolution failed'), {
          httpStatus: 404,
          code: 'NOT_FOUND',
        }),
      );

      await app.register(SSRServer, {
        alias: {},
        configs: [],
        routes: [],
        serviceRegistry: {},
        clientRoot: '/client',
        debug: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/__taujs/data?url=/app/missing',
      });

      expect(AppErrorFake.from).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalled();
      expect(res.statusCode).toBe(499);
    });

    it('returns empty object when resolveRouteData returns empty result', async () => {
      // Override mock to return empty object
      resolveRouteDataMock.mockResolvedValueOnce({});

      await app.register(SSRServer, {
        alias: {},
        configs: [],
        routes: [],
        serviceRegistry: {},
        clientRoot: '/client',
        debug: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/__taujs/data?url=/app/empty',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: {} });
    });

    it('is subject to auth hook when auth is configured', async () => {
      const authError: any = new Error('Unauthorized');
      authError.statusCode = 401;

      const authHookFn = vi.fn((_req: any, reply: any, done: any) => {
        // Auth hook should call reply.code().send() for proper error handling
        reply.code(401).send({ error: 'Unauthorized' });
      });

      createAuthHookMock.mockReturnValueOnce(authHookFn);

      await app.register(SSRServer as any, {
        alias: {},
        configs: [],
        routes: [{ path: '/__taujs/data', attr: { middleware: { auth: true } } }],
        serviceRegistry: {},
        clientRoot: '/client',
        debug: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/__taujs/data?url=/protected',
      });

      expect(authHookFn).toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      // resolveRouteData should NOT have been called because auth failed
      expect(resolveRouteDataMock).not.toHaveBeenCalled();
    });

    it('handles multiple query parameters correctly', async () => {
      // Override mock for this test
      resolveRouteDataMock.mockResolvedValueOnce({ ok: true } as any);

      await app.register(SSRServer, {
        alias: {},
        configs: [],
        routes: [],
        serviceRegistry: {},
        clientRoot: '/client',
        debug: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/__taujs/data?url=/app/page&other=param&foo=bar',
      });

      expect(res.statusCode).toBe(200);
      expect(resolveRouteDataMock).toHaveBeenCalledWith('/app/page', expect.any(Object));
    });
  });
});
