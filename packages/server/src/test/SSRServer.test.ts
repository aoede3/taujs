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
  autoStaticPluginMock,
  getAutoStaticOpts,
  printVitePluginSummaryMock,
  composePluginsMock,
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
  // RFC 0010: τjs creates the Vite server, so τjs closes it on Fastify closure. The double models
  // that contract - a real `ViteDevServer` always has `close()`, and the product deliberately calls
  // it unguarded so a missing close surfaces here rather than passing vacuously.
  const setupDevServerMock = vi.fn(async () => ({ name: 'vite-dev', close: vi.fn(async () => undefined) }));
  const toHttpMock = vi.fn((_e: any) => ({ status: 499, body: { message: 'safe' } }));
  const resolveRouteDataMock = vi.fn<() => Promise<Record<string, unknown>>>(async () => ({ userId: 123, name: 'Test' }));

  let autoStaticOpts: any;
  const autoStaticPluginMock: FastifyPluginCallback<any> = (inst, opts, done) => {
    autoStaticOpts = opts;
    inst.get('/auto-default', async (_req, reply) => reply.send('auto-ok'));
    done();
  };
  const getAutoStaticOpts = () => autoStaticOpts;
  const printVitePluginSummaryMock = vi.fn();
  const composePluginsMock = vi.fn(() => ['composed:one', 'composed:two']);

  return {
    AppErrorFake,
    mockLogger,
    maps,
    processConfigsMock,
    loadAssetsMock,
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
    autoStaticPluginMock,
    getAutoStaticOpts,
    printVitePluginSummaryMock,
    composePluginsMock,
  };
});

vi.mock('../logging/Logger', () => ({ createLogger: vi.fn(() => mockLogger) }));

vi.mock('../utils/AssetManager', () => ({
  createMaps: vi.fn(() => maps),
  loadAssets: loadAssetsMock,
  processConfigs: processConfigsMock,
}));

vi.mock('../security/Auth', () => ({ createAuthHook: createAuthHookMock }));

vi.mock('../security/CSP', () => ({ cspPlugin: cspPluginMock }));

vi.mock('../security/CSPReporting', () => ({ cspReportPlugin: cspReportPluginMock }));

// The controlled System mock mirrors the real module's single derivation: one mode drives both
// exports, so the mock cannot express the mixed state this unit removed.
vi.mock('../System', () => ({
  get isDevelopment() {
    return devRef.value;
  },
  get runtimeMode() {
    return devRef.value ? 'development' : 'production';
  },
}));

vi.mock('../utils/HandleRender', () => ({ handleRender: handleRenderMock }));

vi.mock('../utils/HandleNotFound', () => ({ handleNotFound: handleNotFoundMock }));

vi.mock('../utils/DevServer', () => ({ setupDevServer: setupDevServerMock }));

vi.mock('../logging/utils', () => ({ toHttp: toHttpMock }));

vi.mock('../core/errors/AppError', () => ({ AppError: AppErrorFake }));

vi.mock('../utils/ResolveRouteData', () => ({ resolveRouteData: resolveRouteDataMock }));

vi.mock('@fastify/static', () => ({ default: autoStaticPluginMock }));

vi.mock('../Setup', () => ({ printVitePluginSummary: printVitePluginSummaryMock }));
vi.mock('../utils/VitePlugins', () => ({
  composePlugins: composePluginsMock,
  pluginCollisionMessage: (c: any) => `collision:${c.name}`,
  reservedPluginMessage: (d: any) => `reserved:${d.name}`,
}));

import { ssrServerPlugin, TEMPLATE } from '../SSRServer';

// RFC 0010: this suite predates the ownership split and was written against the root-installing
// plugin, so every registration below uses the τjs-created form. Caller-owned behaviour is proved
// by the permanent ownership regressions, which drive the real public `createServer` path.
const SSRServer = ssrServerPlugin({ callerOwnedHost: false });
import { loadAssets } from '../utils/AssetManager';
import { createAuthHook } from '../security/Auth';
import { createLogger } from '../logging/Logger';
import { composePlugins } from '../utils/VitePlugins';
import { printVitePluginSummary } from '../Setup';
import { testRenderer } from './support/renderer';

describe('SSRServer', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    devRef.value = false;
    app = fastify();
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
      configs: [{ appId: 'a', entryPoint: '.', renderer: testRenderer() }],
      routes: [{ path: '/anything', appId: 'a', attr: { render: 'ssr' } }],
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
      expect.objectContaining({ logger: mockLogger }),
    );

    // CSP plugin called with the global policy; route metadata now comes from Fastify
    const cspCall = cspPluginMock.mock.calls[0];
    expect(cspCall?.[1]).toEqual(
      expect.objectContaining({
        directives: undefined,
        generateCSP: undefined,
        debug: false,
        logger: mockLogger,
      }),
    );

    // Auth hook added and executes
    expect(addHookSpy).toHaveBeenCalledWith('onRequest', expect.any(Function));
    expect(createAuthHook).toHaveBeenCalledWith(mockLogger);

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

  it('auto-registers @fastify/static in non-dev mode when staticAssets is not provided', async () => {
    devRef.value = false;

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      clientRoot: '/client',
      debug: false,
      // staticAssets: undefined -> should trigger the auto branch
    });

    const res = await app.inject({ method: 'GET', url: '/auto-default' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('auto-ok');

    const opts = getAutoStaticOpts();
    expect(opts).toEqual(
      expect.objectContaining({
        root: '/client',
        prefix: '/',
        index: false,
        wildcard: false,
      }),
    );
  });

  it('auto-registers @fastify/static in non-dev mode and uses userClientRoot', async () => {
    devRef.value = false; // ensure !isDevelopment

    // Pick a clientRoot that forces your helper to actually do some work.
    // If your helper resolves relative paths, use a relative here:
    const clientRoot = './public-assets';

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      clientRoot,
      debug: false,
      // staticAssets omitted -> triggers auto-branch
    });

    // Plugin route should be live
    const res = await app.inject({ method: 'GET', url: '/auto-default' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('auto-ok');

    // Now assert that whatever your helper computed as userClientRoot
    // is what @fastify/static sees as `root`.
    const opts = getAutoStaticOpts();

    // If your helper resolves relative → absolute:
    // const expectedRoot = path.resolve(process.cwd(), clientRoot);
    // expect(opts.root).toBe(expectedRoot);

    // If your helper *only* passes through the user value unmodified:
    expect(opts.root).toBe(clientRoot);

    expect(opts).toEqual(
      expect.objectContaining({
        prefix: '/',
        index: false,
        wildcard: false,
      }),
    );
  });

  it('does not require serviceRegistry option', async () => {
    await app.register(SSRServer, {
      alias: {},
      configs: [{ appId: 'a', entryPoint: '.', renderer: testRenderer() }],
      routes: [{ path: '/*' }],
      clientRoot: '/client',
      debug: false,
    });

    const res = await app.inject({ method: 'GET', url: '/anything' });

    expect(res.statusCode).toBe(200);
    expect(handleRenderMock).toHaveBeenCalled();
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

  // staticAssets tri-state: `undefined` requests the default production registration (proved by
  // the auto-register tests above); explicit `false` must install NO static plugin anywhere. The
  // not-found fallthrough is the proof - if any static plugin had claimed the route, the scope's
  // not-found handler could never answer it.
  it('staticAssets: false installs no static plugin in production', async () => {
    devRef.value = false;

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      clientRoot: '/client',
      debug: false,
      staticAssets: false,
    });

    const res = await app.inject({ method: 'GET', url: '/auto-default' });
    expect(res.body).toBe('OK:notFound');
  });

  it('staticAssets: false installs no static plugin in development', async () => {
    devRef.value = true;

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      clientRoot: '/client',
      debug: false,
      staticAssets: false,
    });

    const res = await app.inject({ method: 'GET', url: '/auto-default' });
    expect(res.body).toBe('OK:notFound');
  });

  it('custom staticAssets registers exactly once and suppresses the default in production', async () => {
    devRef.value = false;

    const impl: FastifyPluginCallback<any> = (inst, _opts, done) => {
      inst.get('/custom-static', async (_req, reply) => reply.send('custom-ok'));
      done();
    };
    const staticPlugin = vi.fn(impl);

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      clientRoot: '/client',
      debug: false,
      staticAssets: { plugin: staticPlugin },
    });

    const custom = await app.inject({ method: 'GET', url: '/custom-static' });
    expect(custom.body).toBe('custom-ok');
    expect(staticPlugin).toHaveBeenCalledTimes(1);

    const auto = await app.inject({ method: 'GET', url: '/auto-default' });
    expect(auto.body).toBe('OK:notFound');
  });

  it('caller-owned host keeps its own static facilities when τjs opts out', async () => {
    devRef.value = false;

    const CallerOwnedSSRServer = ssrServerPlugin({ callerOwnedHost: true });
    app.get('/host-static', async (_req, reply) => reply.send('host-ok'));

    await app.register(CallerOwnedSSRServer, {
      alias: {},
      configs: [],
      routes: [],
      clientRoot: '/client',
      debug: false,
      staticAssets: false,
    });

    const host = await app.inject({ method: 'GET', url: '/host-static' });
    expect(host.body).toBe('host-ok');

    // Encapsulated scope: τjs's not-found handler does NOT leak to the caller's root, so an
    // unclaimed URL gets Fastify's own 404 (RFC 0010) - and no static plugin ever claimed it.
    const auto = await app.inject({ method: 'GET', url: '/auto-default' });
    expect(auto.statusCode).toBe(404);
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
      routes: [{ path: '/x', appId: 'a', attr: { render: 'ssr' } }],
      serviceRegistry: {},
      clientRoot: '/client',
      debug: { all: true },
      devNet: { host: 'localhost', hmrPort: 5173 },
    });

    // RFC 0005 VS4: setupDevServer now takes one options object. The app plugin list rides inside the
    // resolved `viteConfig` fragment (apps -> config.vite); `declarativeAlias` is undefined here (no
    // taujsConfig passed).
    expect(setupDevServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        app: expect.any(Object),
        clientRoot: '/client',
        alias: { '@': '/src' },
        debug: { all: true },
        logger: mockLogger,
        devNet: { host: 'localhost', hmrPort: 5173 },
        declarativeAlias: undefined,
        viteConfig: expect.objectContaining({ plugins: ['composed:one', 'composed:two'] }),
      }),
    );

    await app.inject({ method: 'GET', url: '/x' });

    const lastCall = handleRenderMock.mock.calls[handleRenderMock.mock.calls.length - 1] as any[] | undefined;
    const opts = lastCall?.[6] as any;
    expect(opts?.viteDevServer).toBeDefined();
  });

  it('forwards declarative config.alias (taujsConfig.alias) to setupDevServer as the declarative layer (VS5)', async () => {
    devRef.value = true;

    await app.register(SSRServer, {
      alias: { '@': '/src' },
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
      debug: { all: true },
      devNet: { host: 'localhost', hmrPort: 5173 },
      taujsConfig: { apps: [], alias: { '@components': './src/client/shared/components' } } as any,
    });

    // Programmatic `alias` stays the escape hatch; the declarative map is forwarded as
    // `declarativeAlias`, layered UNDER it inside setupDevServer (RFC 0005 VS4/VS5).
    expect(setupDevServerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        app: expect.any(Object),
        clientRoot: '/client',
        alias: { '@': '/src' },
        debug: { all: true },
        devNet: { host: 'localhost', hmrPort: 5173 },
        declarativeAlias: { '@components': './src/client/shared/components' },
        viteConfig: expect.objectContaining({ plugins: ['composed:one', 'composed:two'] }),
      }),
    );
  });

  it('forwards projectRoot to setupDevServer (RFC 0005 §3 - dev alias normalisation root)', async () => {
    devRef.value = true;

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
      debug: false,
      projectRoot: '/repo/apps/shop',
    });

    // Dropping this forwarding line would break monorepo alias symmetry while leaving the
    // hard-gate 4 test green (it drives setupDevServer directly) - hence the explicit pin.
    expect(setupDevServerMock).toHaveBeenLastCalledWith(expect.objectContaining({ projectRoot: '/repo/apps/shop' }));
  });

  it('non-dev mode does not set viteDevServer', async () => {
    devRef.value = false;

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [{ path: '/x', appId: 'a', attr: { render: 'ssr' } }],
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
      routes: [{ path: '/err', appId: 'a', attr: { render: 'ssr' } }],
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

  it('error handler: logs through the hoisted request logger', async () => {
    const setErrorHandlerSpy = vi.spyOn(app, 'setErrorHandler');
    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    const errorHandlerFn = setErrorHandlerSpy.mock.calls[0]?.[0] as any;
    const requestLogger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn(), isDebugEnabled: vi.fn() };
    const mockReq = {
      method: 'GET',
      url: '/terminal',
      routeOptions: { url: '/terminal' },
      taujsRequestContext: { requestId: 'episode-terminal', logger: requestLogger },
    };
    const mockReply = {
      raw: { headersSent: false, end: vi.fn() },
      status: vi.fn().mockReturnThis(),
      // The error handler DECLARES its media type: `toHttp` always produces a structured body, so
      // its representation must not depend on whatever the abandoned response happened to declare.
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    mockLogger.error.mockClear();

    errorHandlerFn(new Error('terminal failure'), mockReq, mockReply);

    expect(requestLogger.error).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: '/terminal' }), 'terminal failure');
    expect(mockLogger.error).not.toHaveBeenCalled();
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
      // The error handler DECLARES its media type: `toHttp` always produces a structured body, so
      // its representation must not depend on whatever the abandoned response happened to declare.
      type: vi.fn().mockReturnThis(),
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

  // RECORDED DELTA: these two selected the level by writing NODE_ENV mid-test, and `test` used to
  // mean debug. The level follows the one runtime mode now, so they select the mode instead -
  // `test`, unset and any other value all resolve to the production branch.
  it('uses minLevel "debug" in development', async () => {
    devRef.value = true;

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

    devRef.value = false;
  });

  it('uses minLevel "info" in production mode', async () => {
    devRef.value = false;

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
        root: '/pub',
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
      routes: [{ path: '/err2', appId: 'a', attr: { render: 'ssr' } }],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    await app.inject({ method: 'GET', url: '/err2' });

    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'E42' }), expect.any(String));
  });

  // `details` is application-controlled data. It never acts as log state, so a handler cannot
  // silence the terminal by claiming its error was already reported.
  it('error handler: logs an error whose details claim logged = true', async () => {
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
      err.details = { logged: true, note: 'application-supplied' };
      throw err;
    });

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [{ path: '/dup', appId: 'a', attr: { render: 'ssr' } }],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    const res = await app.inject({ method: 'GET', url: '/dup' });

    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ details: { logged: true, note: 'application-supplied' } }), 'dup-logged');

    expect(toHttpMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(499);
    expect(res.json()).toEqual({ message: 'safe' });
  });

  it('error handler: logs an error whose details is a non-object', async () => {
    handleRenderMock.mockImplementationOnce(async () => {
      const err: any = new Error('nonobj-details');
      err.httpStatus = 502;
      err.details = 'oops';
      throw err;
    });

    await app.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [{ path: '/nonobj', appId: 'a', attr: { render: 'ssr' } }],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    const resA = await app.inject({ method: 'GET', url: '/nonobj' });
    expect(mockLogger.error).toHaveBeenCalled();
    expect(toHttpMock).toHaveBeenCalled();
    expect(resA.statusCode).toBe(499);
  });

  it('error handler: logs an error regardless of its details content', async () => {
    const app2 = fastify();

    handleRenderMock.mockImplementationOnce(async () => {
      const err: any = new Error('logged-false');
      err.httpStatus = 503;
      err.details = { logged: false, x: 1 };
      throw err;
    });

    await app2.register(SSRServer, {
      alias: {},
      configs: [],
      routes: [{ path: '/loggedfalse', appId: 'a', attr: { render: 'ssr' } }],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    const resB = await app2.inject({ method: 'GET', url: '/loggedfalse' });
    expect(mockLogger.error).toHaveBeenCalled();
    expect(toHttpMock).toHaveBeenCalled();
    expect(resB.statusCode).toBe(499);

    await app2.close();
  });

  it('dev mode: printVitePluginSummary receives mapped plugin descriptors for all plugin shapes', async () => {
    devRef.value = true;

    const namedPlugin = { name: 'named-plugin' };
    const unnamedObject = {}; // typeof => "object"
    const pluginArrayOption = [{ name: 'a' }, { name: 'b' }]; // Array.isArray => array(2)
    const pluginFn = function pluginFn() {}; // has .name => "pluginFn"
    const falsyPlugin = false; // typeof => "boolean"
    const nullPlugin = null; // typeof => "object"

    await app.register(SSRServer, {
      alias: {},
      clientRoot: '/client',
      routes: [],
      implyingThisDoesNotMatter: undefined as any,
      debug: false,
      configs: [
        {
          appId: 'app-a',
          entryPoint: '.',
          plugins: [pluginArrayOption, namedPlugin, unnamedObject, pluginFn, falsyPlugin, nullPlugin],
          renderer: testRenderer(),
        },
        {
          appId: 'app-b',
          entryPoint: '.',
          renderer: testRenderer(),
        },
      ],
    } as any);

    // VS6 (RFC 0005 §5): dev composes via composePlugins with each app as a labelled source, an
    // empty internal slot (the debug plugin is appended in setupDevServer), and warn-level reporters.
    expect(composePlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        internal: [],
        sources: [
          // ESC-1: each app source now carries its RAW plugins as a concrete array (managed
          // contributions are extracted in the pre-pass; an app with no plugins yields [] not
          // undefined). composePlugins treats [] and undefined identically, so the composed list is
          // unchanged - a functional no-op when no managed contribution is declared.
          { source: 'app-a', plugins: [pluginArrayOption, namedPlugin, unnamedObject, pluginFn, falsyPlugin, nullPlugin] },
          { source: 'app-b', plugins: [] },
        ],
        onCollision: expect.any(Function),
        onReservedPrefix: expect.any(Function),
      }),
    );

    // The cross-app dedup log is promoted from debug to WARN (and reserved-prefix drops too): invoke
    // the reporters composePlugins was handed and prove both land on logger.warn, not logger.debug.
    const composeOpts = (composePlugins as any).mock.calls[0]![0];
    mockLogger.warn.mockClear(); // ignore any registration-time warns; isolate the reporter routing
    composeOpts.onCollision({ name: 'dup', sources: ['app-a', 'app-b'], winner: 'app-a' });
    composeOpts.onReservedPrefix({ name: 'τjs-x', source: 'app-a' });
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    expect(mockLogger.debug).not.toHaveBeenCalledWith('vite', expect.anything(), expect.stringContaining('Duplicate'));

    expect(printVitePluginSummary).toHaveBeenCalledTimes(1);

    const call = (printVitePluginSummary as any).mock.calls[0]!;
    const [loggerArg, perAppArg, composedArg] = call;

    expect(loggerArg).toBe(mockLogger);

    expect(perAppArg).toEqual([
      {
        appId: 'app-a',
        plugins: ['array(2)', 'named-plugin', 'object', expect.any(String), 'boolean', 'object'],
      },
      {
        appId: 'app-b',
        plugins: [],
      },
    ]);

    expect(composedArg).toEqual(['composed:one', 'composed:two']);
  });

  it('routes config.vite plugins through the §5 composition as the config.vite source, resolving the override once (VS4/VS6 integration)', async () => {
    devRef.value = true;

    const overridePlugin = { name: 'override-plugin' };
    const viteFn = vi.fn(() => ({ plugins: [overridePlugin], define: { __X__: '1' } }));

    await app.register(SSRServer, {
      alias: {},
      clientRoot: '/client',
      routes: [],
      debug: false,
      configs: [{ appId: 'app-a', entryPoint: '.', plugins: [{ name: 'app-plugin' }], renderer: testRenderer() }],
      taujsConfig: { apps: [], vite: viteFn },
    } as any);

    // §1: the function form resolves exactly once, with the serve arm and no appId.
    expect(viteFn).toHaveBeenCalledTimes(1);
    expect(viteFn).toHaveBeenCalledWith({ command: 'serve', mode: 'development', isSSRBuild: false, clientRoot: '/client' });

    // §5: the override's plugins enter composePlugins as the labelled `config.vite` source AFTER the
    // app sources - they must not bypass dedupe via the engine's plain plugin append.
    const composeArgs = (composePlugins as any).mock.calls.at(-1)![0];
    expect(composeArgs.sources).toEqual([
      { source: 'app-a', plugins: [{ name: 'app-plugin' }] },
      { source: 'config.vite', plugins: [overridePlugin] },
    ]);
  });

  it('registers declared page routes natively and forwards Fastify-decoded params', async () => {
    await app.register(SSRServer, {
      alias: {},
      configs: [{ appId: 'shop', entryPoint: '.', renderer: testRenderer() }],
      routes: [{ path: '/products/:id', appId: 'shop', attr: { render: 'ssr' } }],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    const res = await app.inject({ method: 'GET', url: '/products/hello%20world' });

    expect(res.statusCode).toBe(200);
    expect(handleRenderMock).toHaveBeenCalledWith(
      expect.objectContaining({ params: { id: 'hello world' } }),
      expect.any(Object),
      expect.objectContaining({
        route: expect.objectContaining({ path: '/products/:id', appId: 'shop' }),
        params: { id: 'hello world' },
      }),
      expect.any(Array),
      expect.anything(),
      expect.anything(),
      expect.any(Object),
    );
  });

  it('lets a declared page route own dotted parameter values instead of treating them as asset misses', async () => {
    await app.register(SSRServer, {
      alias: {},
      configs: [{ appId: 'shop', entryPoint: '.', renderer: testRenderer() }],
      routes: [{ path: '/products/:id', appId: 'shop', attr: { render: 'ssr' } }],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    const res = await app.inject({ method: 'GET', url: '/products/logo.png' });

    expect(res.statusCode).toBe(200);
    expect(handleRenderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { id: 'logo.png' } }),
      expect.any(Object),
      expect.objectContaining({
        route: expect.objectContaining({ path: '/products/:id', appId: 'shop' }),
        params: { id: 'logo.png' },
      }),
      expect.any(Array),
      expect.anything(),
      expect.anything(),
      expect.any(Object),
    );
  });

  it('honours the supplied Fastify router policy instead of reproducing it in taujs', async () => {
    const configuredApp = fastify({ routerOptions: { caseSensitive: false, ignoreTrailingSlash: true } });
    try {
      await configuredApp.register(SSRServer, {
        alias: {},
        configs: [{ appId: 'docs', entryPoint: '.', renderer: testRenderer() }],
        routes: [{ path: '/Guides', appId: 'docs', attr: { render: 'ssr' } }],
        serviceRegistry: {},
        clientRoot: '/client',
      });

      const res = await configuredApp.inject({ method: 'GET', url: '/guides/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('OK:handleRender');
    } finally {
      await configuredApp.close();
    }
  });

  it('coexists with host-owned Fastify routes without a parallel taujs namespace', async () => {
    app.get('/health', async () => ({ ok: true }));
    await app.register(SSRServer, {
      alias: {},
      configs: [{ appId: 'site', entryPoint: '.', renderer: testRenderer() }],
      routes: [{ path: '/page', appId: 'site', attr: { render: 'ssr' } }],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: '/page' })).body).toBe('OK:handleRender');
  });

  it('uses Fastify precedence when static and parameter routes overlap', async () => {
    await app.register(SSRServer, {
      alias: {},
      configs: [{ appId: 'site', entryPoint: '.', renderer: testRenderer() }],
      routes: [
        { path: '/users/:id', appId: 'site', attr: { render: 'ssr' } },
        { path: '/users/edit', appId: 'site', attr: { render: 'ssr' } },
      ],
      serviceRegistry: {},
      clientRoot: '/client',
    });

    await app.inject({ method: 'GET', url: '/users/edit' });

    expect(handleRenderMock).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        route: expect.objectContaining({ path: '/users/edit' }),
        params: {},
      }),
      expect.any(Array),
      expect.anything(),
      expect.anything(),
      expect.any(Object),
    );
  });

  it('lets Fastify reject a collision with an existing host route at boot', async () => {
    app.get('/occupied', async () => 'host');

    await expect(
      app.register(SSRServer, {
        alias: {},
        configs: [{ appId: 'site', entryPoint: '.', renderer: testRenderer() }],
        routes: [{ path: '/occupied', appId: 'site', attr: { render: 'ssr' } }],
        serviceRegistry: {},
        clientRoot: '/client',
      }),
    ).rejects.toMatchObject({ code: 'FST_ERR_DUPLICATED_ROUTE' });
  });
});
