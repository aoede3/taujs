// @vitest-environment node
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createServerMock: vi.fn(),
  createLoggerMock: vi.fn(),
  overrideCSSHMRConsoleErrorMock: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('vite', () => ({
  createServer: hoisted.createServerMock,
}));

vi.mock('../../logging/Logger', () => ({
  createLogger: hoisted.createLoggerMock,
}));

vi.mock('../System', () => ({
  __dirname: '/srv',
}));

vi.mock('../Templates', () => ({
  overrideCSSHMRConsoleError: hoisted.overrideCSSHMRConsoleErrorMock,
}));

async function importer() {
  vi.resetModules();
  vi.doMock('vite', () => ({ createServer: hoisted.createServerMock }));
  vi.doMock('../../logging/Logger', () => ({ createLogger: hoisted.createLoggerMock }));
  vi.doMock('../System', () => ({ __dirname: '/srv' }));
  vi.doMock('../Templates', () => ({ overrideCSSHMRConsoleError: hoisted.overrideCSSHMRConsoleErrorMock }));
  return await import('../DevServer'); // <-- adjust path to your file if needed
}

type FakeServer = {
  middlewares: (req: any, res: any, next: Function) => void;
  _useHandlers: Function[];
};

function makeFakeViteServer(): FakeServer {
  const server: any = {
    _useHandlers: [],
    middlewares: (req: any, res: any, next: Function) => next(),
  };
  // allow plugin to register middleware handlers
  server.middlewares.use = (handler: Function) => {
    server._useHandlers.push(handler);
  };
  return server as FakeServer;
}

function makeApp() {
  const hooks: Record<string, Function[]> = {};
  return {
    hooks,
    addHook: (name: string, fn: Function) => {
      (hooks[name] ||= []).push(fn);
    },
  } as any;
}

const { createServerMock, createLoggerMock, overrideCSSHMRConsoleErrorMock, logger } = hoisted;

beforeEach(() => {
  delete process.env.HOST;
  delete process.env.FASTIFY_ADDRESS;
  delete process.env.HMR_PORT;

  createLoggerMock.mockReset().mockReturnValue(logger);
  logger.debug.mockReset();
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();

  overrideCSSHMRConsoleErrorMock.mockReset();

  createServerMock.mockReset().mockImplementation(async (opts: any) => {
    const server = makeFakeViteServer();

    // Simulate Vite invoking plugin.configureServer(server)
    if (Array.isArray(opts?.plugins)) {
      for (const p of opts.plugins) {
        if (p && typeof p.configureServer === 'function') {
          await p.configureServer(server as any);
        }
      }
    }

    // return the fake server
    return server as any;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('setupDevServer', () => {
  it('creates a vite server with debug=false (no plugin), merges alias, and wires Fastify onRequest hook', async () => {
    const { setupDevServer } = await importer();

    const app = makeApp();
    const baseClientRoot = path.join('/', 'root', 'client');

    const server = await setupDevServer(app as any, baseClientRoot, { '~foo': '/bar' }, /* debug */ false, {
      host: 'dev.example.com',
      hmrPort: 7777,
    });

    // createLogger called with expected shape
    expect(createLoggerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { service: 'setupDevServer' },
        minLevel: 'debug',
      }),
    );

    // vite.createServer was called once
    expect(createServerMock).toHaveBeenCalledTimes(1);
    const cfg = createServerMock.mock.calls[0]![0];

    // No plugin when debug=false
    expect(cfg.plugins).toEqual([]);

    // Alias merge + resolution
    expect(cfg.resolve.alias['@client']).toBe(path.resolve(baseClientRoot));
    expect(cfg.resolve.alias['@server']).toBe(path.resolve('/srv'));
    expect(cfg.resolve.alias['@shared']).toBe(path.resolve('/srv', '../shared'));
    expect(cfg.resolve.alias['~foo']).toBe('/bar');

    // HMR from devNet overrides env/defaults
    expect(cfg.server.hmr.clientPort).toBe(7777);
    expect(cfg.server.hmr.host).toBe('dev.example.com');
    expect(cfg.server.hmr.port).toBe(7777);
    expect(cfg.server.hmr.protocol).toBe('ws');

    // CSS preprocessor config is set
    expect(cfg.css?.preprocessorOptions?.scss?.api).toBe('modern-compiler');

    // overrideCSSHMRConsoleError was called
    expect(overrideCSSHMRConsoleErrorMock).toHaveBeenCalledTimes(1);

    // onRequest hook wired and calls through middlewares and resolves
    const onReq = app.hooks['onRequest'][0];
    const req = { raw: { method: 'GET', url: '/x', headers: { host: 'h', 'user-agent': 'ua' } } } as any;
    const res = { raw: { statusCode: 200 }, sent: false, rawEnd: vi.fn() } as any;

    const reply = {
      raw: {
        statusCode: 200,
      },
      sent: false,
    } as any;

    // Our fake server's middlewares simply next() immediately, so the promise resolves.
    await expect(onReq({ raw: req.raw } as any, reply)).resolves.toBeUndefined();

    // Returned server is the fake one
    expect(server).toBeDefined();
  });

  it('debug=true injects plugin which logs rx/tx via middleware', async () => {
    const { setupDevServer } = await importer();

    const app = makeApp();
    const server = await setupDevServer(app as any, '/root/client', undefined, /* debug */ { all: true });

    // The debug plugin should have executed configureServer and registered a middleware
    expect((server as any)._useHandlers.length).toBe(1);
    const handler = (server as any)._useHandlers[0];

    // Simulate a request/response pair
    const req = {
      method: 'GET',
      url: '/hello',
      headers: { host: 'localhost:3000', 'user-agent': 'UA' },
    } as any;

    const onListeners: Record<string, Function[]> = {};
    const res = {
      statusCode: 200,
      on: vi.fn((ev: string, cb: Function) => {
        (onListeners[ev] ||= []).push(cb);
      }),
    } as any;

    const next = vi.fn();
    handler(req, res, next);

    // logs the incoming request
    expect(logger.debug).toHaveBeenCalledWith('vite', expect.stringContaining('Development server debug started'));
    expect(logger.debug).toHaveBeenCalledWith('vite', expect.objectContaining({ method: 'GET', url: '/hello', host: 'localhost:3000', ua: 'UA' }), '← rx');

    // simulate response finish to trigger tx log
    const finishCbs = onListeners['finish'] ?? [];
    expect(finishCbs.length).toBeGreaterThan(0);
    finishCbs.forEach((cb) => cb());
    expect(logger.debug).toHaveBeenCalledWith('vite', expect.objectContaining({ method: 'GET', url: '/hello', statusCode: 200 }), '→ tx');

    // middleware must call next()
    expect(next).toHaveBeenCalled();
  });

  it('hmr host/port fallbacks: from env when devNet not provided', async () => {
    process.env.HOST = ' example.org ';
    process.env.HMR_PORT = '12345';

    const { setupDevServer } = await importer();

    const app = makeApp();
    await setupDevServer(app as any, '/root/client', undefined, /* debug */ false);

    const cfg = createServerMock.mock.calls[0]![0];

    // host trimmed from env, not localhost => present in cfg
    expect(cfg.server.hmr.clientPort).toBe(12345);
    expect(cfg.server.hmr.port).toBe(12345);
    expect(cfg.server.hmr.host).toBe('example.org');
  });

  it('hmr host uses FASTIFY_ADDRESS when HOST not set; omits host when localhost', async () => {
    process.env.FASTIFY_ADDRESS = 'localhost';
    process.env.HMR_PORT = ''; // force default 5174

    const { setupDevServer } = await importer();

    const app = makeApp();
    await setupDevServer(app as any, '/root/client');

    const cfg = createServerMock.mock.calls[0]![0];
    expect(cfg.server.hmr.clientPort).toBe(5174);
    expect(cfg.server.hmr.port).toBe(5174);
    // when host === 'localhost', code sets host: undefined
    expect(cfg.server.hmr.host).toBeUndefined();
  });

  it('alias option merges and overrides defaults if needed', async () => {
    const { setupDevServer } = await importer();
    const app = makeApp();

    await setupDevServer(app as any, '/root/client', {
      '@client': '/override/client',
      custom: '/x/y',
    });

    const cfg = createServerMock.mock.calls[0]![0];
    expect(cfg.resolve.alias['@client']).toBe('/override/client'); // path.resolve is applied in code via path.resolve(baseClientRoot); here we provide absolute
    expect(cfg.resolve.alias['custom']).toBe('/x/y');
  });
});
