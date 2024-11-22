// @vitest-environment node

import path from 'node:path';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SSRTAG, RENDERTYPE } from '../constants';

import type { FastifyInstance } from 'fastify';
import type { Mock } from 'vitest';
import type { SSRServerOptions } from '../SSRServer';

let mockVitePlugins: Record<string, unknown>[] = [];

vi.mock('vite', () => ({
  createServer: vi.fn(async (viteConfig) => {
    mockVitePlugins = viteConfig.plugins || [];

    return {
      close: vi.fn(),
      middlewares: {
        use: vi.fn(),
      },
      transformIndexHtml: vi.fn().mockResolvedValue(`<html>${SSRTAG.ssrHead}${SSRTAG.ssrHtml}</html>`),
    };
  }),
  defineConfig: vi.fn((config) => config),
  createViteRuntime: vi.fn(async (_viteServer) => ({
    executeEntrypoint: vi.fn().mockResolvedValue({
      renderStream: vi.fn().mockImplementation((_res, callbacks) => {
        callbacks.onHead('<head></head>');
        callbacks.onFinish({});
      }),
      renderSSR: vi.fn().mockResolvedValue({
        headContent: '<head></head>',
        appHtml: '<div id="app"></div>',
        initialDataScript: '<script>window.__INITIAL_DATA__ = {}</script>',
      }),
    }),
  })),
}));

vi.mock('@fastify/static', () => ({
  default: async (instance: FastifyInstance, _opts: Record<string, unknown>) => {
    instance.get('/static/*', async (_request, reply) => {
      reply.status(404).send('404 Not Found');
    });
  },
}));

describe('SSRServer Plugin', () => {
  const cssLinksMockValue = '<link rel="stylesheet" href="/style.css">';
  const preloadLinksMockValue = '<link rel="modulepreload" href="/entry-client.js">';
  let app: FastifyInstance;
  let options: SSRServerOptions;
  let isDevelopmentValue: boolean;

  beforeEach(async () => {
    vi.resetModules();

    app = fastify();

    options = {
      alias: {},
      clientRoot: './test',
      clientHtmlTemplate: 'index.html',
      clientEntryClient: 'entry-client',
      clientEntryServer: 'entry-server',
      routes: [],
      serviceRegistry: {},
      isDebug: false,
    };

    isDevelopmentValue = true;

    vi.mock('node:fs/promises', () => ({
      readFile: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('index.html')) {
          return `<html>
                    <head>${SSRTAG.ssrHead}</head>
                    <body>${SSRTAG.ssrHtml}</body>
                  </html>`;
        } else if (filePath.endsWith('.vite/ssr-manifest.json')) {
          return JSON.stringify({
            'entry-server.js': ['entry-server.js'],
          });
        } else if (filePath.endsWith('.vite/manifest.json')) {
          return JSON.stringify({
            'entry-client.tsx': {
              file: 'entry-client.js',
              css: ['entry-client.css'],
            },
          });
        }
        return '';
      }),
    }));

    mockVitePlugins = [];

    vi.doMock('../utils', async (importOriginal) => {
      const actual = await importOriginal();

      return {
        ...(actual as Record<string, unknown>),
        __dirname: __dirname,
        callServiceMethod: vi.fn(),
        collectStyle: vi.fn().mockResolvedValue(''),
        fetchData: vi.fn().mockResolvedValue({}),
        fetchInitialData: vi.fn().mockResolvedValue({}),
        get isDevelopment() {
          return isDevelopmentValue;
        },
        getCssLinks: vi.fn().mockReturnValue(cssLinksMockValue),
        matchRoute: vi.fn().mockReturnValue(options.routes[0] ? { route: options.routes[0], params: {} } : undefined),
        overrideCSSHMRConsoleError: vi.fn(),
        renderPreloadLinks: vi.fn().mockReturnValue(preloadLinksMockValue),
      };
    });

    vi.doMock(path.join(options.clientRoot, `${options.clientEntryServer}.js`), () => ({
      renderStream: vi.fn().mockImplementation((_res, callbacks) => {
        callbacks.onHead('<head></head>');
        callbacks.onFinish({});
        callbacks.onError(new Error('Test Critical Error'));
      }),
      renderSSR: vi.fn().mockRejectedValue(new Error('Test Critical Error')),
    }));

    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
    mockVitePlugins = [];
  });

  it('should register the plugin without errors in development', async () => {
    isDevelopmentValue = true;
    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    expect(app.hasPlugin('taujs-ssr-server')).toBe(true);
  });

  it('should register both SSR server and debug logging plugins in development debug mode', async () => {
    isDevelopmentValue = true;
    const optionsDebug = {
      ...options,
      isDebug: true,
    };
    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, optionsDebug);

    expect(app.hasPlugin('taujs-ssr-server')).toBe(true);

    const debugPlugin = mockVitePlugins.find((plugin) => plugin.name === 'taujs-ssr-server-debug-logging');
    expect(debugPlugin).toBeDefined();
  });

  it('should register the plugin without errors in production', async () => {
    isDevelopmentValue = false;
    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    expect(app.hasPlugin('taujs-ssr-server')).toBe(true);
  });

  it('should process development-specific code when isDevelopment is true', async () => {
    isDevelopmentValue = true;

    vi.resetModules();

    vi.mock('./test/entry-server.js', async (importOriginal) => {
      const actual = await importOriginal();

      return {
        ...(actual as Record<string, unknown>),
        renderStream: vi.fn().mockImplementation((_res, callbacks) => {
          callbacks.onHead('<head></head>');
          callbacks.onFinish({});
        }),
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<head></head>',
          appHtml: '<div id="app"></div>',
          initialDataScript: '<script>window.__INITIAL_DATA__ = {}</script>',
        }),
      };
    });

    vi.doMock('vite', () => {
      type MiddlewareFunction = {
        (req: Record<string, unknown>, res: Record<string, unknown>, next: Record<string, unknown>): void;
        use: Mock;
      };

      const mockMiddlewares: MiddlewareFunction = vi.fn((_req, _res, next) => next()) as unknown as MiddlewareFunction;
      mockMiddlewares.use = vi.fn();

      const mockViteDevServer = {
        transformIndexHtml: vi.fn().mockResolvedValue(`<html>${SSRTAG.ssrHead}${SSRTAG.ssrHtml}</html>`),
        middlewares: mockMiddlewares,
      };

      const mockViteRuntime = {
        executeEntrypoint: vi.fn().mockResolvedValue({
          renderStream: vi.fn().mockImplementation((_res, callbacks) => {
            callbacks.onHead('<head></head>');
            callbacks.onFinish({});
          }),
          renderSSR: vi.fn().mockResolvedValue({
            headContent: '<head></head>',
            appHtml: '<div id="app"></div>',
            initialDataScript: '<script>window.__INITIAL_DATA__ = {}</script>',
          }),
        }),
      };

      return {
        createServer: vi.fn().mockResolvedValue(mockViteDevServer),
        createViteRuntime: vi.fn().mockResolvedValue(mockViteRuntime),
      };
    });

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const mockRoute = {
      route: {
        path: '/some-route',
        attr: {},
      },
      params: {},
    };
    const { matchRoute } = await import('../utils');
    (matchRoute as Mock).mockReturnValue(mockRoute);

    const { collectStyle } = await import('../utils');
    (collectStyle as Mock).mockResolvedValue('/* styles */');

    const response = await app.inject({
      method: 'GET',
      url: '/some-route',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<html><head></head><script>window.__INITIAL_DATA__ = {}</script></html>');
  });

  it('should serve static files in production mode', async () => {
    options.isDebug = false;
    isDevelopmentValue = false;

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const response = await app.inject({
      method: 'GET',
      url: '/static/file.js',
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('404 Not Found');
  });

  it('should correctly handle not-found handler for SPA routes', async () => {
    options.routes = [];
    isDevelopmentValue = false;

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const { matchRoute } = await import('../utils');
    (matchRoute as Mock).mockReturnValue(undefined);

    const response = await app.inject({
      method: 'GET',
      url: '/spa-route',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<html>');
    expect(response.body).toContain('</html>');
    expect(response.body).toContain('<script type="module" src="/entry-client.js" async=""></script></body>');
    expect(response.body).not.toContain(`${SSRTAG.ssrHead}`);
    expect(response.body).not.toContain(`${SSRTAG.ssrHtml}`);
    expect(response.body).toContain('<link rel="stylesheet" href="/style.css">');
  });

  it('should delegate to callNotFound for requests with file extensions', async () => {
    options.routes = [];
    isDevelopmentValue = false;

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const { matchRoute } = await import('../utils');
    (matchRoute as Mock).mockReturnValue(undefined);

    const response = await app.inject({
      method: 'GET',
      url: '/file.js',
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('404 Not Found');
  });

  it('should return 500 and log error when serving clientHtmlTemplate fails', async () => {
    options.routes = [];
    isDevelopmentValue = false;

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const { matchRoute, getCssLinks } = await import('../utils');
    (matchRoute as Mock).mockReturnValue(undefined);
    (getCssLinks as Mock).mockImplementation(() => {
      throw new Error('Mock getCssLinks Error');
    });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await app.inject({
      method: 'GET',
      url: '/spa-route',
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('Internal Server Error');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to serve clientHtmlTemplate:', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  it('should log rx and tx when a request is made and response finishes in debug mode', async () => {
    vi.resetModules();

    isDevelopmentValue = true;
    options.isDebug = true;

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockServer: {
      middlewares: {
        use: any;
      };
    } = {
      middlewares: {
        use: vi.fn(),
      },
    };

    let middlewareFunction: (req: Record<string, unknown>, res: Record<string, unknown>, next: Record<string, unknown>) => void;

    vi.doMock('vite', () => ({
      createServer: vi.fn(async (viteConfig) => {
        const plugin = viteConfig.plugins.find((p: { name: string }) => p.name === 'taujs-ssr-server-debug-logging');
        mockVitePlugins = viteConfig.plugins || [];

        if (plugin && plugin.configureServer) {
          plugin.configureServer(mockServer);
        }

        middlewareFunction = mockServer.middlewares.use.mock.calls[0][0];

        return {
          close: vi.fn(),
          middlewares: {
            use: vi.fn(),
          },
          transformIndexHtml: vi.fn().mockResolvedValue(`<html${SSRTAG.ssrHead}${SSRTAG.ssrHtml}</html>`),
        };
      }),
      defineConfig: vi.fn((config) => config),
      createViteRuntime: vi.fn(async (_viteServer) => ({
        executeEntrypoint: vi.fn().mockResolvedValue({
          renderStream: vi.fn().mockImplementation((_res, callbacks) => {
            callbacks.onHead('<head></head>');
            callbacks.onFinish({});
          }),
          renderSSR: vi.fn().mockResolvedValue({
            headContent: '<head></head>',
            appHtml: '<div id="app"></div>',
            initialDataScript: '<script>window.__INITIAL_DATA__ = {}</script>',
          }),
        }),
      })),
    }));

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    expect(consoleLogSpy).toHaveBeenCalledWith('τjs debug ssr server started.');
    expect(mockServer.middlewares.use).toHaveBeenCalled();

    const req = { url: '/test-url' };
    const res = {
      on: vi.fn((event: string, callback: () => void) => {
        if (event === 'finish') {
          callback();
        }
      }),
    };
    const next = vi.fn();

    //@ts-ignore
    middlewareFunction(req, res, next);

    expect(consoleLogSpy).toHaveBeenCalledWith('rx: /test-url');
    expect(consoleLogSpy).toHaveBeenCalledWith('tx: /test-url');
    expect(next).toHaveBeenCalled();

    consoleLogSpy.mockRestore();
  });

  it('should handle errors during stream rendering via onError callback', async () => {
    options.routes = [
      {
        path: '/',
        attr: {
          fetch: vi.fn().mockResolvedValue({ options: {}, url: '/api/data' }),
        },
      },
    ];

    vi.doMock('../utils', async (importOriginal) => {
      const actual = await importOriginal();

      return {
        ...(actual as Record<string, unknown>),
        fetchInitialData: vi.fn().mockResolvedValue({}),
      };
    });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const response = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith('Critical rendering onError:', expect.any(Error));
    expect(response.statusCode).toBe(200);

    consoleErrorSpy.mockRestore();
  });

  it('should handle errors in the route handler and return 500', async () => {
    isDevelopmentValue = false;

    vi.doMock('../utils', async (importOriginal) => {
      const actual = await importOriginal();

      return {
        ...(actual as Record<string, unknown>),
        matchRoute: vi.fn(() => {
          throw new Error('Test Error in matchRoute');
        }),
      };
    });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const response = await app.inject({
      method: 'GET',
      url: '/test-path',
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error setting up SSR stream:', expect.any(Error));
    expect(response.statusCode).toBe(500);
    expect(response.body.trim()).toBe('Internal Server Error');

    consoleErrorSpy.mockRestore();
  });

  it('should default to "/" when req.url is undefined', async () => {
    isDevelopmentValue = false;

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    app.addHook('onRequest', (request, _reply, done) => {
      request.raw.url = undefined;
      done();
    });

    const response = await app.inject({
      method: 'GET',
      url: '/test-path',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<html>');
  });

  it('should render using renderSSR when renderType is "ssr"', async () => {
    isDevelopmentValue = false;

    options.routes = [
      {
        path: '/',
        attr: {
          fetch: vi.fn().mockResolvedValue({ options: {}, url: '/api/data' }),
          render: RENDERTYPE.ssr,
        },
      },
    ];

    vi.doMock('../utils', async (importOriginal) => {
      const actual = await importOriginal();

      return {
        ...(actual as Record<string, unknown>),
        matchRoute: vi.fn().mockReturnValue({
          route: options.routes[0],
          params: {},
        }),
        fetchInitialData: vi.fn().mockResolvedValue({}),
      };
    });

    vi.doMock(path.join(options.clientRoot, `${options.clientEntryServer}.js`), () => ({
      renderSSR: vi.fn().mockResolvedValue({
        headContent: '<head></head>',
        appHtml: '<div id="app"></div>',
        initialDataScript: '<script>window.__INITIAL_DATA__ = {}</script>',
      }),
      renderStream: vi.fn(),
    }));

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const response = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<head></head>');
    expect(response.body).toContain('<div id="app"></div>');
    expect(response.body).toContain('<script>window.__INITIAL_DATA__ = {}</script>');
  });
});
