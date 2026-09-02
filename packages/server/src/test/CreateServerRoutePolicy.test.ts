// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { testRenderer } from './support/renderer';

import type { TaujsConfig } from '../Config';
import type { RequestGraph } from '../core/introspection/RequestGraph';

// RFC 0016 (Phase A) boot-wiring cells: opt-in inertness, boot refusal in both runtime modes,
// and the byte-identical `verifyContracts()` failure path with no policy declared. The pure
// evaluator/validator matrix (config-error rows, the CSP truth table, selector matching, `ok`
// derivation) lives in `core/policy/test/RoutePolicy.test.ts` - this file exercises only what
// changes at the `createServer()` call site.

const hoisted = vi.hoisted(() => ({
  createRequestGraphSpy: vi.fn<(config: unknown, options: unknown) => RequestGraph>(),
}));

vi.mock('../core/introspection/RequestGraph', () => ({
  createRequestGraph: hoisted.createRequestGraphSpy,
}));

vi.mock('../SSRServer', () => ({
  ssrServerPlugin: () => ({ __id: 'ssr-server-plugin' }),
}));

vi.mock('../network/Network', () => ({
  bannerPlugin: { __id: 'banner-plugin' },
}));

vi.mock('../network/CLI', () => ({
  resolveNet: vi.fn(() => ({ host: '127.0.0.1', port: 5173, hmrPort: 5174 })),
}));

const mkApp = () =>
  ({
    register: vi.fn(async () => undefined),
    addHook: vi.fn(),
    log: undefined,
  }) as any;

const publicRoute = { path: '/', attr: { render: 'ssr' as const } };

const baseConfig: TaujsConfig = {
  apps: [{ appId: 'web', entryPoint: 'web', renderer: testRenderer(), routes: [publicRoute] }],
};

// A minimal but schema-complete graph the mocked `createRequestGraph` returns - just enough for
// `evaluateRoutePolicy` (the real, unmocked function) to read.
const graphFor = (routes: RequestGraph['routes']): RequestGraph => ({
  schemaVersion: 1,
  taujs: { server: 'test' },
  source: 'boot',
  emittedAt: '2026-01-01T00:00:00.000Z',
  disclosure: 'conservative',
  apps: [{ appId: 'web', entryPoint: 'web', routeCount: routes.length }],
  routes,
  services: null,
  security: { cspDefaultMode: 'merge', reporting: false },
  fallthrough: { mode: 'spa', appId: 'web', assetLike: 404, reachable: true },
  warnings: [],
});

const okRoute: RequestGraph['routes'][number] = {
  id: 'web:/',
  appId: 'web',
  path: '/',
  render: { strategy: 'ssr', defaulted: false },
  hydrate: { enabled: true, defaulted: false },
  specificity: 0,
  middleware: { auth: { declared: false }, csp: { declared: false } },
  data: { kind: 'none' },
};

const originalNodeEnv = process.env.NODE_ENV;
const originalConsoleLog = console.log;

async function bootWith(nodeEnv: string, config: TaujsConfig, opts: { logger?: any; app?: any } = {}) {
  process.env.NODE_ENV = nodeEnv;
  vi.resetModules();
  const { createServer } = await import('../CreateServer');
  const app = opts.app ?? mkApp();
  const result = await createServer({ config, fastify: app, logger: opts.logger });
  return { app, result };
}

const errorLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(function (this: any) {
    return this;
  }),
});

beforeEach(() => {
  hoisted.createRequestGraphSpy.mockReset();
  hoisted.createRequestGraphSpy.mockReturnValue(graphFor([okRoute]));
  console.log = vi.fn();
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  console.log = originalConsoleLog;
});

describe('createServer — routePolicy opt-in inertness', () => {
  it.each(['development', 'production'])('with no routePolicy declared, createRequestGraph is NEVER invoked (%s)', async (mode) => {
    const { app } = await bootWith(mode, baseConfig);

    expect(hoisted.createRequestGraphSpy).not.toHaveBeenCalled();
    // Boot still completes normally: the SSR plugin registers.
    expect(app.register).toHaveBeenCalledWith(expect.objectContaining({ __id: 'ssr-server-plugin' }), expect.any(Object));
  });

  it('with routePolicy declared, createRequestGraph is invoked exactly once, with the config and a boot-source option carrying the service registry', async () => {
    const serviceRegistry = { catalog: {} } as any;
    const config: TaujsConfig = { ...baseConfig, routePolicy: { rules: [{ id: 'public', match: {} }] } };

    process.env.NODE_ENV = 'development';
    vi.resetModules();
    const { createServer } = await import('../CreateServer');
    await createServer({ config, fastify: mkApp(), serviceRegistry });

    expect(hoisted.createRequestGraphSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.createRequestGraphSpy).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ source: 'boot', emittedAt: expect.any(String), serviceRegistry }),
    );
  });
});

describe('createServer — routePolicy byte-identical verifyContracts failure without policy', () => {
  it('a route requiring auth with no .authenticate decorator throws the exact original message, unchanged, with no routePolicy declared', async () => {
    const config: TaujsConfig = {
      apps: [{ appId: 'web', entryPoint: 'web', renderer: testRenderer(), routes: [{ path: '/admin', attr: { render: 'ssr', middleware: { auth: {} } } }] }],
    };

    await expect(bootWith('development', config)).rejects.toThrow('[τjs] Routes require auth but Fastify is missing .authenticate decorator.');
    // The routePolicy branch never even runs on this path - it is gated on `routePolicy` being
    // declared, and `verifyContracts` throws before that gate is ever reached.
    expect(hoisted.createRequestGraphSpy).not.toHaveBeenCalled();
  });
});

describe('createServer — routePolicy boot refusal', () => {
  it.each(['development', 'production'])('every finding logs, then one aggregate error refuses boot, BEFORE the SSR plugin registers (%s)', async (mode) => {
    const config: TaujsConfig = { ...baseConfig, routePolicy: { rules: [{ id: 'strict', match: {}, require: ['taujs.auth-wired', 'taujs.csp-configured'] }] } };
    const logger = errorLogger();
    const app = mkApp();

    process.env.NODE_ENV = mode;
    vi.resetModules();
    const { createServer } = await import('../CreateServer');

    await expect(createServer({ config, fastify: app, logger })).rejects.toThrow(/routePolicy: 2 finding\(s\) refuse boot/);

    // Every finding logged before the aggregate throw.
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'policy.evidence_missing', routeId: 'web:/', ruleId: 'strict', evidence: 'taujs.auth-wired' }),
      expect.stringContaining('[routePolicy]'),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'policy.evidence_missing', routeId: 'web:/', ruleId: 'strict', evidence: 'taujs.csp-configured' }),
      expect.stringContaining('[routePolicy]'),
    );

    // Refusal precedes SSR plugin registration - the caller never gets a half-booted server.
    expect(app.register).not.toHaveBeenCalledWith(expect.objectContaining({ __id: 'ssr-server-plugin' }), expect.anything());
  });

  it.each(['development', 'production'])('a fail-closed unmatched route refuses boot (%s)', async (mode) => {
    const config: TaujsConfig = { ...baseConfig, routePolicy: { rules: [{ id: 'only-elsewhere', match: { path: '/never' } }] } };
    const app = mkApp();

    process.env.NODE_ENV = mode;
    vi.resetModules();
    const { createServer } = await import('../CreateServer');

    await expect(createServer({ config, fastify: app })).rejects.toThrow(/routePolicy: 1 finding\(s\) refuse boot/);
    expect(app.register).not.toHaveBeenCalledWith(expect.objectContaining({ __id: 'ssr-server-plugin' }), expect.anything());
  });

  it('a routePolicy with no findings boots normally in both environments and registers the SSR plugin', async () => {
    const config: TaujsConfig = { ...baseConfig, routePolicy: { rules: [{ id: 'public', match: {} }] } };

    for (const mode of ['development', 'production']) {
      const { app } = await bootWith(mode, config);
      expect(app.register).toHaveBeenCalledWith(expect.objectContaining({ __id: 'ssr-server-plugin' }), expect.any(Object));
    }
  });
});
