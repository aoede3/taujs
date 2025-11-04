// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { TaujsConfig } from '../Config';
import type { FastifyPluginCallback } from 'fastify/types/plugin';

async function importer() {
  vi.resetModules();
  return await import('../CreateServer');
}

const origConsoleLog = console.log;
const origPerformanceNow = performance.now;

beforeEach(() => {
  console.log = vi.fn();
  let calls = 0;
  performance.now = vi.fn(() => (calls++ === 0 ? 1000 : 1675));
});

afterEach(() => {
  console.log = origConsoleLog;
  performance.now = origPerformanceNow;
  vi.clearAllMocks();
});

vi.mock('picocolors', () => ({
  default: {
    bgGreen: (s: string) => `[bgGreen:${s}]`,
    black: (s: string) => `[black:${s}]`,
  },
}));

vi.mock('../constants', () => ({
  CONTENT: { TAG: '[τjs]' },
}));

const registerMock = vi.fn();
const fakeFastifyInstance = {
  register: registerMock,
};

vi.mock('fastify', () => ({
  default: vi.fn(() => fakeFastifyInstance),
}));

const fastifyStaticMock = { __id: 'fastifyStatic' };
vi.mock('@fastify/static', () => ({
  default: fastifyStaticMock,
}));

const bannerPluginMock = { __id: 'bannerPlugin' };
vi.mock('../network/Network', () => ({
  bannerPlugin: bannerPluginMock,
}));

const netResolved = { host: '127.0.0.1', hmrPort: 5173 } as const;
vi.mock('../network/CLI', () => ({
  resolveNet: vi.fn(() => netResolved),
}));

const loggerError = vi.fn();

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: loggerError,
  debug: vi.fn(),

  child: vi.fn(function (this: any, _bindings?: Record<string, unknown>) {
    return this as any;
  }),

  isDebugEnabled: vi.fn(() => true),
};

vi.mock('../logging/Logger', () => ({
  createLogger: createLoggerSpy,
}));

const createLoggerSpy = vi.fn(() => fakeLogger);

vi.mock('../logging/Logger', () => ({
  createLogger: createLoggerSpy,
}));

const extractBuildConfigsSpy = vi.fn(() => [{ id: 'appA' }]);
const extractRoutesSpy = vi.fn(() => ({
  routes: [{ path: '/a' }],
  apps: [{ name: 'A' }],
  totalRoutes: 1,
  durationMs: 12,
  warnings: ['w1'],
}));
const extractSecuritySpy = vi.fn(() => ({
  security: { csp: { directives: { defaultSrc: ["'self'"] } } },
  durationMs: 7,
  hasExplicitCSP: true,
}));
const printConfigSummarySpy = vi.fn();
const printSecuritySummarySpy = vi.fn();
const printContractReportSpy = vi.fn();
vi.mock('../Setup', () => ({
  extractBuildConfigs: extractBuildConfigsSpy,
  extractRoutes: extractRoutesSpy,
  extractSecurity: extractSecuritySpy,
  printConfigSummary: printConfigSummarySpy,
  printSecuritySummary: printSecuritySummarySpy,
  printContractReport: printContractReportSpy,
}));

const verifyContractsResult = { ok: true, details: [{ key: 'auth', ok: true }] };
const verifyContractsSpy = vi.fn(() => verifyContractsResult);
const isAuthRequiredSpy = vi.fn(() => true);
const hasAuthenticateSpy = vi.fn(() => true);
vi.mock('../security/VerifyMiddleware', () => ({
  verifyContracts: verifyContractsSpy,
  isAuthRequired: isAuthRequiredSpy,
  hasAuthenticate: hasAuthenticateSpy,
}));

let ssrShouldThrow = false;
const SSRServerPlugin = Symbol('SSRServerPlugin');
vi.mock('../SSRServer', () => ({
  SSRServer: SSRServerPlugin,
}));

beforeEach(() => {
  registerMock.mockImplementation(async (plugin, _opts) => {
    if (plugin === bannerPluginMock) return;
    if (plugin === SSRServerPlugin && ssrShouldThrow) {
      throw new Error('SSR register failed');
    }
  });
});

const minimalConfig: TaujsConfig = {
  server: { host: 'unused' },
  apps: [{ appId: 'a', entryPoint: 'e' }],
};
const dummyRegistry = {} as any;

describe('createServer', () => {
  beforeEach(() => {
    ssrShouldThrow = false;
    process.env.NODE_ENV = 'test';
  });

  it('creates Fastify instance, registers plugins, defaults staticAssets to fastifyStatic, returns { app, net }', async () => {
    const { createServer } = await importer();

    const result = await createServer({
      config: minimalConfig,
      serviceRegistry: dummyRegistry,
    });

    expect(result).toEqual({ app: fakeFastifyInstance, net: netResolved });

    expect(registerMock).toHaveBeenNthCalledWith(
      1,
      bannerPluginMock,
      expect.objectContaining({
        hmr: { host: netResolved.host, port: netResolved.hmrPort },
        debug: undefined,
      }),
    );

    expect(createLoggerSpy).toHaveBeenCalledWith(expect.objectContaining({ minLevel: 'debug', includeContext: true }));

    expect(extractBuildConfigsSpy).toHaveBeenCalled();
    expect(extractRoutesSpy).toHaveBeenCalled();
    expect(extractSecuritySpy).toHaveBeenCalled();
    expect(printConfigSummarySpy).toHaveBeenCalled();
    expect(printSecuritySummarySpy).toHaveBeenCalled();

    expect(verifyContractsSpy).toHaveBeenCalled();
    expect(printContractReportSpy).toHaveBeenCalledWith(expect.any(Object), verifyContractsResult);

    expect(registerMock).toHaveBeenNthCalledWith(
      2,
      SSRServerPlugin,
      expect.objectContaining({
        staticAssets: { plugin: fastifyStaticMock },
        clientRoot: expect.stringContaining('/client'),
        devNet: { host: netResolved.host, hmrPort: netResolved.hmrPort },
      }),
    );

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[bgGreen:[black: [τjs] ]]'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('configured in 675ms'));
  });

  it('respects staticAssets=false (passes false through to SSRServer)', async () => {
    const { createServer } = await importer();

    await createServer({
      config: minimalConfig,
      serviceRegistry: dummyRegistry,
      staticAssets: false,
    });

    expect(registerMock).toHaveBeenNthCalledWith(2, SSRServerPlugin, expect.objectContaining({ staticAssets: false }));
  });

  it('respects custom staticAssets object', async () => {
    const { createServer } = await importer();
    const customPlugin: FastifyPluginCallback = (_instance, _opts, done) => {
      done();
    };
    const custom = { plugin: customPlugin, options: { foo: 'bar' } };

    await createServer({
      config: minimalConfig,
      serviceRegistry: dummyRegistry,
      staticAssets: custom,
    });

    expect(registerMock).toHaveBeenNthCalledWith(2, SSRServerPlugin, expect.objectContaining({ staticAssets: custom }));
  });

  it('logs an error if SSRServer registration throws, but continues and returns normally', async () => {
    const { createServer } = await importer();
    ssrShouldThrow = true;

    const result = await createServer({
      config: minimalConfig,
      serviceRegistry: dummyRegistry,
    });

    expect(result).toEqual({ app: fakeFastifyInstance, net: netResolved });

    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'register:SSRServer',
        error: expect.objectContaining({
          name: 'Error',
          message: 'SSR register failed',
        }),
      }),
      'Failed to register SSRServer',
    );
  });

  it('when a Fastify instance is provided, returns only { net } (no app) and still registers plugins', async () => {
    const { createServer } = await importer();

    const externalFastify = { register: vi.fn(registerMock) } as any;

    const result = await createServer({
      config: minimalConfig,
      serviceRegistry: dummyRegistry,
      fastify: externalFastify,
    });

    expect(result).toEqual({ net: netResolved });

    expect(registerMock).toHaveBeenNthCalledWith(1, bannerPluginMock, expect.any(Object));
    expect(registerMock).toHaveBeenNthCalledWith(2, SSRServerPlugin, expect.any(Object));
  });

  it('sets logger minLevel to "info" in production NODE_ENV', async () => {
    process.env.NODE_ENV = 'production';
    const { createServer } = await importer();

    await createServer({
      config: minimalConfig,
      serviceRegistry: dummyRegistry,
    });

    expect(createLoggerSpy).toHaveBeenCalledWith(expect.objectContaining({ minLevel: 'info' }));
  });

  it('passes through debug + custom logger into createLogger and bannerPlugin', async () => {
    const { createServer } = await importer();

    const customLogger: any = { custom: true };
    const debugConfig: any = { routes: true };

    await createServer({
      config: minimalConfig,
      serviceRegistry: dummyRegistry,
      debug: debugConfig,
      logger: customLogger,
    });

    expect(createLoggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        debug: debugConfig,
        custom: customLogger,
      }),
    );

    expect(registerMock).toHaveBeenNthCalledWith(1, bannerPluginMock, expect.objectContaining({ debug: debugConfig }));
  });

  it('exercises contract required/verify lambdas (auth & csp)', async () => {
    const { createServer } = await importer();

    await createServer({
      config: minimalConfig,
      serviceRegistry: dummyRegistry,
    });

    expect(verifyContractsSpy).toHaveBeenCalled();
    const contractCall = verifyContractsSpy.mock.calls[0] as unknown as Array<any>;
    const contractDefs = contractCall?.[2] as unknown as Array<{
      key: string;
      required: (rts: any[]) => boolean;
      verify: (app?: any) => boolean;
      errorMessage: string;
    }>;

    const authDef = contractDefs.find((d) => d.key === 'auth')!;
    const cspDef = contractDefs.find((d) => d.key === 'csp')!;
    expect(authDef).toBeTruthy();
    expect(cspDef).toBeTruthy();

    isAuthRequiredSpy.mockReset().mockReturnValueOnce(false).mockReturnValueOnce(true);

    const routesProbe = [{ path: '/a' }, { path: '/b' }];
    const authRequired = authDef.required(routesProbe);

    expect(authRequired).toBe(true);
    expect(isAuthRequiredSpy).toHaveBeenCalledTimes(2);
    expect(isAuthRequiredSpy).toHaveBeenNthCalledWith(1, routesProbe[0], 0, routesProbe);
    expect(isAuthRequiredSpy).toHaveBeenNthCalledWith(2, routesProbe[1], 1, routesProbe);

    expect(cspDef.required([])).toBe(true);
    expect(cspDef.verify()).toBe(true);
  });

  it('uses Fastify app.log as default custom logger when level !== "silent"', async () => {
    const { createServer } = await importer();

    const fastifyLog = { level: 'info', child: vi.fn(() => fastifyLog) } as any;
    const externalFastify = { register: vi.fn(registerMock), log: fastifyLog } as any;

    await createServer({
      config: minimalConfig,
      serviceRegistry: dummyRegistry,
      fastify: externalFastify,
    });

    // custom should be the fastify log
    expect(createLoggerSpy).toHaveBeenCalledWith(expect.objectContaining({ custom: fastifyLog }));
  });

  it('does NOT use Fastify app.log when level === "silent" (custom undefined)', async () => {
    const { createServer } = await importer();

    const fastifyLog = { level: 'silent', child: vi.fn(() => fastifyLog) } as any;
    const externalFastify = { register: vi.fn(registerMock), log: fastifyLog } as any;

    await createServer({
      config: minimalConfig,
      serviceRegistry: dummyRegistry,
      fastify: externalFastify,
    });

    expect(createLoggerSpy).toHaveBeenCalledWith(expect.objectContaining({ custom: undefined }));
  });

  it('opts.logger overrides Fastify app.log when both provided', async () => {
    const { createServer } = await importer();

    const fastifyLog = { level: 'info', child: vi.fn(() => fastifyLog) } as any;
    const externalFastify = { register: vi.fn(registerMock), log: fastifyLog } as any;
    const customLogger = { my: 'logger' } as any;

    await createServer({
      config: minimalConfig,
      serviceRegistry: dummyRegistry,
      fastify: externalFastify,
      logger: customLogger,
    });

    expect(createLoggerSpy).toHaveBeenCalledWith(expect.objectContaining({ custom: customLogger }));
  });
});
