// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createRouteMatchersMock: vi.fn(),
  matchRouteMock: vi.fn(),

  createLoggerMock: vi.fn(),
  loggerErrorMock: vi.fn(),

  randomBytesMock: vi.fn(() => Buffer.from('0123456789abcdef')), // deterministic 16 bytes
}));

vi.mock('fastify-plugin', () => ({
  default: (fn: any) => fn,
}));

vi.mock('crypto', () => ({
  default: { randomBytes: hoisted.randomBytesMock },
  randomBytes: hoisted.randomBytesMock,
}));

vi.mock('../../constants', () => ({
  DEV_CSP_DIRECTIVES: {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
  },
}));

vi.mock('../../utils/DataRoutes', () => ({
  createRouteMatchers: hoisted.createRouteMatchersMock,
  matchRoute: hoisted.matchRouteMock,
}));

vi.mock('../../logging/Logger', () => ({
  createLogger: hoisted.createLoggerMock,
}));

async function importer(isDev = true) {
  vi.resetModules();

  vi.doMock('fastify-plugin', () => ({ default: (fn: any) => fn }));
  vi.doMock('crypto', () => ({
    default: { randomBytes: hoisted.randomBytesMock },
    randomBytes: hoisted.randomBytesMock,
  }));
  vi.doMock('../../constants', () => ({
    DEV_CSP_DIRECTIVES: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
    },
  }));
  vi.doMock('../../utils/DataRoutes', () => ({
    createRouteMatchers: hoisted.createRouteMatchersMock,
    matchRoute: hoisted.matchRouteMock,
  }));
  vi.doMock('../../logging/Logger', () => ({
    createLogger: hoisted.createLoggerMock,
  }));

  vi.doMock('../../utils/System', () => ({
    isDevelopment: isDev,
  }));

  return await import('../CSP');
}

function makeFastify() {
  const hooks: Record<string, any> = {};
  const fastify = {
    addHook(name: string, fn: any) {
      hooks[name] = fn;
    },
    _hooks: hooks,
  } as any;
  return fastify;
}

function makeReqReply(url = '/path', headers: any = {}) {
  const replyHeaders: Record<string, any> = {};
  const req = {
    url,
    headers: { host: 'example.test', ...headers },
  } as any;

  const reply = {
    header: vi.fn((k: string, v: any) => {
      replyHeaders[k] = v;
      return reply;
    }),
  } as any;

  const done = vi.fn();
  return { req, reply, done, replyHeaders };
}

const { createRouteMatchersMock, matchRouteMock, createLoggerMock, loggerErrorMock, randomBytesMock } = hoisted;

beforeEach(() => {
  createRouteMatchersMock.mockReset();
  matchRouteMock.mockReset();
  createLoggerMock.mockReset().mockReturnValue({ error: loggerErrorMock.mockReset() });
  randomBytesMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('defaultGenerateCSP', () => {
  it('adds nonce and dev-only connect/style allowances when isDevelopment = true', async () => {
    const { defaultGenerateCSP } = await importer(true);

    const out = defaultGenerateCSP({ 'script-src': ["'self'"] }, 'NONCE123');
    expect(out).toMatch(/script-src 'self' .*'nonce-NONCE123'/);
    expect(out).toContain("connect-src 'self' ws: http:");
    expect(out).toMatch(/style-src 'self'(?: .*?)?'unsafe-inline'/);
  });

  it('does not add dev allowances when isDevelopment = false and avoids duplicate nonce', async () => {
    const { defaultGenerateCSP } = await importer(false);

    const out = defaultGenerateCSP({ 'script-src': ["'self'", "'nonce-EXISTING'"], 'connect-src': ["'self'"], 'style-src': ["'self'"] }, 'NEW');
    expect(out.match(/'nonce-/g)?.length ?? 0).toBe(1);
    expect(out).not.toContain('ws:');
    expect(out).not.toContain('http:');
    expect(out).not.toContain("'unsafe-inline'");
  });
});

describe('generateNonce', () => {
  it('returns a base64 string from crypto.randomBytes', async () => {
    const { generateNonce } = await importer(true);
    const s = generateNonce();
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
    expect(randomBytesMock).toHaveBeenCalledWith(16);
  });
});

describe('findMatchingRoute', () => {
  it('onRequest: routeMatchers present but no match → findMatchingRoute returns null (ternary : null)', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    // routeMatchers provided (non-null), but matchRoute returns no match
    await cspPlugin(fastify as any, { routeMatchers: [{} as any] });

    matchRouteMock.mockReturnValueOnce(undefined);

    const { req, reply, done } = makeReqReply('/no-match-with-matchers');
    await fastify._hooks.onRequest(req, reply, done);

    // Header still set from global directives path
    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy', expect.stringMatching(/script-src 'self' .*'nonce-/));
    expect(done).toHaveBeenCalled();
  });
});

describe('cspPlugin', () => {
  it('sets header using global directives when no route matchers / no match', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    // No matchers created (routes empty & routeMatchers undefined)
    createRouteMatchersMock.mockReturnValue(undefined);
    matchRouteMock.mockReturnValue(undefined);

    await cspPlugin(fastify as any, { routes: [], debug: false });

    const { req, reply, done } = makeReqReply('/no-match');
    await fastify._hooks.onRequest(req, reply, done);

    const header = (reply.header as any).mock.calls[0][1] as string;
    expect(header).toMatch(/script-src 'self' .*'nonce-/);
    expect(done).toHaveBeenCalled();
  });

  it('skips setting header when routeCSP === false', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    matchRouteMock.mockReturnValue({
      route: { attr: { middleware: { csp: false } } },
      params: {},
    });

    await cspPlugin(fastify as any, { routeMatchers: [{} as any] });

    const { req, reply, done } = makeReqReply('/skip');
    await fastify._hooks.onRequest(req, reply, done);

    // No header set
    expect(reply.header).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });

  it('handles disabled routeCSP object (no change), generates header via provided generateCSP', async () => {
    const gen = vi.fn(() => 'CSP:DISABLED');
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    matchRouteMock.mockReturnValue({
      route: { attr: { middleware: { csp: { disabled: true } } } },
      params: {},
    });

    await cspPlugin(fastify as any, { generateCSP: gen, routeMatchers: [{} as any] });

    const { req, reply, done } = makeReqReply('/disabled');
    await fastify._hooks.onRequest(req, reply, done);

    expect(gen).toHaveBeenCalled();
    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy', 'CSP:DISABLED');
    expect(done).toHaveBeenCalled();
  });

  it('merges route directives by default (mode merge), de-duplicates values', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    matchRouteMock.mockReturnValue({
      route: {
        attr: {
          middleware: {
            csp: {
              directives: {
                'script-src': ["'self'", 'https://cdn.example.com'],
                'img-src': ["'self'", 'data:'],
              },
            },
          },
        },
      },
      params: {},
    });

    await cspPlugin(fastify as any, { routeMatchers: [{} as any] });

    const { req, reply, done } = makeReqReply('/merge');
    await fastify._hooks.onRequest(req, reply, done);

    const header = (reply.header as any).mock.calls[0][1] as string;
    // From global + route; order is not guaranteed, check components
    expect(header).toMatch(/script-src 'self' .*'nonce-/);
    expect(header).toContain('https://cdn.example.com');
    // New directive added
    expect(header).toContain("img-src 'self' data:");
  });

  it('replaces directives when mode = replace', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    matchRouteMock.mockReturnValue({
      route: {
        attr: {
          middleware: {
            csp: {
              mode: 'replace',
              directives: {
                'connect-src': ["'self'", 'https://api.example.com'],
              },
            },
          },
        },
      },
      params: {},
    });

    await cspPlugin(fastify as any, { routeMatchers: [{} as any] });

    const { req, reply, done } = makeReqReply('/replace');
    await fastify._hooks.onRequest(req, reply, done);

    const header = (reply.header as any).mock.calls[0][1] as string;
    // Order can vary; assert presence
    expect(header).toMatch(/^connect-src 'self' /);
    expect(header).toContain('https://api.example.com');
    expect(header).toContain('ws:');
    expect(header).toContain('http:');
  });

  it('supports route-level directives as a function, receiving params and req', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    const directivesFn = vi.fn(({ url, params, headers, req }) => {
      expect(url).toBe('/user/42?foo=bar');
      expect(params).toEqual({ id: '42' });
      expect(headers.host).toBe('example.test');
      expect(req.url).toBe('/user/42?foo=bar');
      return {
        'style-src': ["'self'", 'https://fonts.example.com'],
      };
    });

    matchRouteMock.mockReturnValue({
      route: {
        attr: {
          middleware: {
            csp: {
              directives: directivesFn,
            },
          },
        },
      },
      params: { id: '42' },
    });

    await cspPlugin(fastify as any, { routeMatchers: [{} as any] });

    const { req, reply, done } = makeReqReply('/user/42?foo=bar');
    await fastify._hooks.onRequest(req, reply, done);

    const header = (reply.header as any).mock.calls[0][1] as string;
    expect(directivesFn).toHaveBeenCalled();
    // Order can vary; assert both parts present
    expect(header).toContain("style-src 'self'");
    expect(header).toContain("'unsafe-inline'");
    expect(header).toContain('https://fonts.example.com');
  });

  it('uses route-level generateCSP override when provided', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    const routeGen = vi.fn(() => 'ROUTE-OVERRIDE-CSP');

    matchRouteMock.mockReturnValue({
      route: {
        attr: {
          middleware: {
            csp: {
              directives: { 'img-src': ["'self'"] },
              generateCSP: routeGen,
            },
          },
        },
      },
      params: {},
    });

    await cspPlugin(fastify as any, { routeMatchers: [{} as any] });

    const { req, reply, done } = makeReqReply('/gen');
    await fastify._hooks.onRequest(req, reply, done);

    expect(routeGen).toHaveBeenCalled();
    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy', 'ROUTE-OVERRIDE-CSP');
  });

  it('logs and applies fallback header when an error occurs in processing', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    // Throw inside matchRoute to hit catch block
    matchRouteMock.mockImplementation(() => {
      throw new Error('boom');
    });

    await cspPlugin(fastify as any, { routeMatchers: [{} as any] });

    const { req, reply, done } = makeReqReply('/err');
    await fastify._hooks.onRequest(req, reply, done);

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/err',
        error: expect.objectContaining({ name: 'Error', message: 'boom' }),
      }),
      'CSP plugin error',
    );

    // fallback header still applied
    const header = (reply.header as any).mock.calls[0][1] as string;
    expect(header).toMatch(/script-src 'self' .*'nonce-/);
    expect(done).toHaveBeenCalled();
  });

  it('initialisation: routes non-empty → creates matchers via createRouteMatchers(routes)', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    createRouteMatchersMock.mockReturnValue([
      {
        /* matcher */
      },
    ] as any);

    const routes = [{ path: '/foo', attr: { middleware: {} } }] as any;
    await cspPlugin(fastify as any, { routes }); // no routeMatchers passed

    expect(createRouteMatchersMock).toHaveBeenCalledWith(routes);

    // Run a request to ensure the created matchers are used
    matchRouteMock.mockReturnValueOnce(undefined);
    const { req, reply, done } = makeReqReply('/foo');
    await fastify._hooks.onRequest(req, reply, done);

    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy', expect.stringMatching(/script-src 'self' .*'nonce-/));
    expect(done).toHaveBeenCalled();
  });

  it('route directives function receives params default {} when routeMatch.params is undefined', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    const directivesFn = vi.fn(({ params }) => {
      expect(params).toEqual({}); // ← hits params || {}
      return { 'img-src': ["'self'", 'data:'] };
    });

    matchRouteMock.mockReturnValue({
      route: { attr: { middleware: { csp: { directives: directivesFn } } } },
      params: undefined, // ← trigger default
    });

    await cspPlugin(fastify as any, { routeMatchers: [{} as any] });

    const { req, reply, done } = makeReqReply('/with-undefined-params');
    await fastify._hooks.onRequest(req, reply, done);

    expect(directivesFn).toHaveBeenCalled();
    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy', expect.stringContaining("img-src 'self' data:"));
  });

  it('routeDirectives defaults to {} when routeCSP.directives is undefined', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    matchRouteMock.mockReturnValue({
      route: {
        attr: {
          middleware: {
            csp: {
              /* no directives */
            },
          },
        },
      },
      params: {},
    });

    await cspPlugin(fastify as any, { routeMatchers: [{} as any] });

    const { req, reply, done } = makeReqReply('/no-directives');
    await fastify._hooks.onRequest(req, reply, done);

    // Should still set a valid CSP header (merged {} with global)
    const header = (reply.header as any).mock.calls[0][1] as string;
    expect(header).toMatch(/script-src 'self' .*'nonce-/);
    expect(done).toHaveBeenCalled();
  });

  it('logs stringified error and applies fallback header when a non-Error is thrown', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    matchRouteMock.mockImplementation(() => {
      throw 'route-err-str'; // ← non-Error to hit String(error)
    });

    await cspPlugin(fastify as any, { routeMatchers: [{} as any] });

    const { req, reply, done } = makeReqReply('/err-str');
    await fastify._hooks.onRequest(req, reply, done);

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/err-str',
        error: 'route-err-str', // ← String(error)
      }),
      'CSP plugin error',
    );

    const header = (reply.header as any).mock.calls[0][1] as string;
    expect(header).toMatch(/script-src 'self' .*'nonce-/); // fallback applied
    expect(done).toHaveBeenCalled();
  });
});

describe('defaultGenerateCSP (more cases)', () => {
  it('adds script-src with self + nonce when script-src is missing', async () => {
    const { defaultGenerateCSP } = await importer(true);

    const out = defaultGenerateCSP({ 'default-src': ["'self'"] } as any, 'NONCE-ADD');
    // script-src should be synthesized with 'self' and nonce
    expect(out).toMatch(/script-src 'self' .*'nonce-NONCE-ADD'/);
  });

  it('does not duplicate dev allowances when already present', async () => {
    const { defaultGenerateCSP } = await importer(true);

    const out = defaultGenerateCSP(
      {
        'script-src': ["'self'"],
        'connect-src': ["'self'", 'ws:', 'http:'],
        'style-src': ["'self'", "'unsafe-inline'"],
      },
      'NONCE-DUP',
    );

    // exactly one ws: and one http:
    const wsCount = (out.match(/(?:^|[\s;])ws:/g) || []).length;
    const httpCount = (out.match(/(?:^|[\s;])http:/g) || []).length;
    expect(wsCount).toBe(1);
    expect(httpCount).toBe(1);
    // exactly one 'unsafe-inline'
    expect((out.match(/'unsafe-inline'/g) || []).length).toBe(1);
    // nonce added once
    expect((out.match(/'nonce-/g) || []).length).toBe(1);
  });
});

describe('cspPlugin - reportOnly header selection', () => {
  it('uses Content-Security-Policy-Report-Only when opts.reporting.reportOnly = true (no route override)', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    // No matchers; global path
    await cspPlugin(fastify as any, { routes: [], reporting: { reportOnly: true } });

    const { req, reply, done } = makeReqReply('/no-match');
    await fastify._hooks.onRequest(req, reply, done);

    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy-Report-Only', expect.stringMatching(/script-src 'self' .*'nonce-/));
    expect(done).toHaveBeenCalled();
  });

  it('uses Content-Security-Policy-Report-Only when routeCSP.reportOnly = true (overrides global default)', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    matchRouteMock.mockReturnValue({
      route: {
        attr: {
          middleware: {
            csp: {
              reportOnly: true,
              directives: { 'img-src': ["'self'"] },
            },
          },
        },
      },
      params: {},
    });

    await cspPlugin(fastify as any, { routeMatchers: [{} as any] });

    const { req, reply, done } = makeReqReply('/route-report-only');
    await fastify._hooks.onRequest(req, reply, done);

    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy-Report-Only', expect.any(String));
    const headerVal = (reply.header as any).mock.calls[0][1] as string;
    expect(headerVal).toContain("img-src 'self'");
    expect(done).toHaveBeenCalled();
  });

  it('error path: still applies Report-Only header when opts.reporting.reportOnly = true', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    matchRouteMock.mockImplementation(() => {
      throw new Error('blow-up');
    });

    await cspPlugin(fastify as any, { routeMatchers: [{} as any], reporting: { reportOnly: true } });

    const { req, reply, done } = makeReqReply('/err-report-only');
    await fastify._hooks.onRequest(req, reply, done);

    // Header name is Report-Only even on fallback
    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy-Report-Only', expect.stringMatching(/script-src 'self' .*'nonce-/));
    expect(done).toHaveBeenCalled();
  });

  it('route-level generateCSP + reportOnly selects Report-Only header', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    const routeGen = vi.fn(() => 'ROUTE-REPORT-ONLY-CSP');

    matchRouteMock.mockReturnValue({
      route: {
        attr: {
          middleware: {
            csp: {
              reportOnly: true,
              directives: { 'img-src': ["'self'", 'data:'] },
              generateCSP: routeGen,
            },
          },
        },
      },
      params: {},
    });

    await cspPlugin(fastify as any, { routeMatchers: [{} as any] });

    const { req, reply, done } = makeReqReply('/route-gen-report-only');
    await fastify._hooks.onRequest(req, reply, done);

    expect(routeGen).toHaveBeenCalled();
    expect(reply.header).toHaveBeenCalledWith('Content-Security-Policy-Report-Only', 'ROUTE-REPORT-ONLY-CSP');
    expect(done).toHaveBeenCalled();
  });
});

describe('cspPlugin - req.cspNonce assignment', () => {
  it('sets req.cspNonce to the generated nonce', async () => {
    const { cspPlugin } = await importer(true);
    const fastify = makeFastify();

    await cspPlugin(fastify as any, { routes: [] });

    const { req, reply, done } = makeReqReply('/nonce-check');
    await fastify._hooks.onRequest(req, reply, done);

    // Base64 of Buffer('0123456789abcdef') from mocked randomBytes
    const expected = Buffer.from('0123456789abcdef').toString('base64');
    expect(req.cspNonce).toBe(expected);
    expect(done).toHaveBeenCalled();
  });
});
