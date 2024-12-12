// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RENDERTYPE, SSRTAG } from '../constants';

import type { FastifyInstance } from 'fastify';
import type { Mock } from 'vitest';
import type { Config, SSRServerOptions } from '../SSRServer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mockVitePlugins: Record<string, unknown>[] = [];
let mockViteDevServer: any;

vi.mock('vite', () => ({
  createServer: vi.fn(async (viteConfig) => {
    mockVitePlugins = viteConfig.plugins || [];
    mockViteDevServer = {
      close: vi.fn(),
      middlewares: {
        use: vi.fn(),
      },
      transformIndexHtml: vi.fn().mockResolvedValue(`<html>${SSRTAG.ssrHead}${SSRTAG.ssrHtml}</html>`),
    };

    for (const plugin of mockVitePlugins) {
      if (plugin && typeof plugin.configureServer === 'function') {
        plugin.configureServer(mockViteDevServer);
      }
    }

    return mockViteDevServer;
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

let isDevelopmentValue = true;

vi.mock('../utils', () => ({
  __dirname: __dirname,
  collectStyle: vi.fn().mockResolvedValue('/* styles */'),
  fetchInitialData: vi.fn().mockResolvedValue({}),
  getCssLinks: vi.fn().mockImplementation((_manifest, prefix = '') => `<link rel="stylesheet" href="${prefix}/style.css">`),
  matchRoute: vi.fn().mockReturnValue(undefined),
  overrideCSSHMRConsoleError: vi.fn(),
  renderPreloadLinks: vi.fn().mockImplementation((_manifest, prefix = '') => `<link rel="modulepreload" href="${prefix}/entry-client.js">`),
  get isDevelopment() {
    return isDevelopmentValue;
  },
  ensureNonNull: vi.fn((value, errorMessage) => {
    if (value === undefined || value === null) {
      throw new Error(errorMessage);
    }
    return value;
  }),
  processConfigs: vi.fn((configs, baseClientRoot, templateDefaults) => {
    return configs.map((config: Config) => {
      const clientRoot = path.resolve(baseClientRoot, config.entryPoint);
      return {
        clientRoot,
        entryClient: config.entryClient || templateDefaults.defaultEntryClient,
        entryServer: config.entryServer || templateDefaults.defaultEntryServer,
        htmlTemplate: config.htmlTemplate || templateDefaults.defaultHtmlTemplate,
        appId: config.appId,
      };
    });
  }),
}));

const originalFsReadFile = vi.fn(async (filePath: string) => {
  if (filePath.endsWith('index.html')) {
    return `<html><head><style type="text/css">.original-style { color: blue; }</style>${SSRTAG.ssrHead}</head><body>${SSRTAG.ssrHtml}</body></html>`;
  } else if (filePath.includes('.vite/ssr-manifest.json')) {
    return JSON.stringify({ 'entry-server.js': ['entry-server.js'] });
  } else if (filePath.includes('.vite/manifest.json')) {
    return JSON.stringify({
      'entry-client.tsx': {
        file: 'entry-client.js',
        css: ['entry-client.css'],
      },
    });
  }
  return `<html><head>${SSRTAG.ssrHead}</head><body>${SSRTAG.ssrHtml}</body></html>`;
});

let fsReadFileMock = vi.fn(originalFsReadFile);

vi.mock('node:fs/promises', () => ({
  readFile: (filePath: string) => fsReadFileMock(filePath),
}));

describe('SSRServer Plugin (New)', () => {
  let app: FastifyInstance;
  let options: SSRServerOptions;
  const baseClientRoot = './test';
  const defaultConfig = {
    appId: '',
    entryPoint: '.',
    entryClient: 'entry-client',
    entryServer: 'entry-server',
    htmlTemplate: 'index.html',
  };

  beforeEach(async () => {
    vi.resetModules();
    fsReadFileMock = vi.fn(originalFsReadFile);

    app = fastify();
    options = {
      alias: {},
      clientRoot: baseClientRoot,
      configs: [defaultConfig],
      routes: [{ path: '/dev-ssr', attr: { render: RENDERTYPE.ssr } }],
      serviceRegistry: {},
      isDebug: false,
    };
    isDevelopmentValue = true;
    mockVitePlugins = [];
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
    mockVitePlugins = [];
  });

  it('registers plugin in development mode without errors', async () => {
    isDevelopmentValue = true;
    const { SSRServer } = await import('../SSRServer');

    await app.register(SSRServer, options);
    expect(app.hasPlugin('taujs-ssr-server')).toBe(true);
  });

  it('registers plugin in development mode with default templates', async () => {
    isDevelopmentValue = true;
    const { SSRServer } = await import('../SSRServer');
    const optionsConfigBlank = {
      ...options,
      configs: [
        {
          appId: '',
          entryPoint: '.',
          entryClient: '',
          entryServer: '',
          htmlTemplate: '',
        },
      ],
    };

    await app.register(SSRServer, optionsConfigBlank);
    expect(app.hasPlugin('taujs-ssr-server')).toBe(true);
  });

  it('registers plugin in development debug mode and logs', async () => {
    isDevelopmentValue = true;
    options.isDebug = true;
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const debugPlugin = mockVitePlugins.find((p) => p.name === 'taujs-development-server-debug-logging');
    expect(debugPlugin).toBeDefined();
    expect(consoleLogSpy).toHaveBeenCalledWith('τjs development server debug started.');

    consoleLogSpy.mockRestore();
  });

  it('registers plugin in production mode without errors', async () => {
    isDevelopmentValue = false;
    const { SSRServer } = await import('../SSRServer');

    await app.register(SSRServer, options);
    expect(app.hasPlugin('taujs-ssr-server')).toBe(true);
  });

  it('registers plugin in production mode with default templates', async () => {
    isDevelopmentValue = false;
    const { SSRServer } = await import('../SSRServer');
    const optionsConfigBlank = {
      ...options,
      configs: [
        {
          appId: '',
          entryPoint: '.',
          entryClient: '',
          entryServer: '',
          htmlTemplate: '',
        },
      ],
    };

    await app.register(SSRServer, optionsConfigBlank);
    expect(app.hasPlugin('taujs-ssr-server')).toBe(true);
  });

  it('serves static files in production mode', async () => {
    isDevelopmentValue = false;
    const { SSRServer } = await import('../SSRServer');

    await app.register(SSRServer, options);
    const response = await app.inject({ method: 'GET', url: '/static/file.js' });
    expect(response.statusCode).toBe(404);
  });

  it('should handle no matched route and calls notFound', async () => {
    isDevelopmentValue = false;
    const utils = await import('../utils');
    (utils.matchRoute as Mock).mockReturnValue(undefined);

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const response = await app.inject({ method: 'GET', url: '/no-route' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<html>');
  });

  it('should handle file requests and returns 404', async () => {
    isDevelopmentValue = false;
    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const response = await app.inject({ method: 'GET', url: '/image.png' });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('404 Not Found');
  });

  it('should handle missing config for matched route', async () => {
    isDevelopmentValue = false;
    options.routes = [{ path: '/app', attr: { render: RENDERTYPE.ssr }, appId: 'unknown-app' }];
    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const utils = await import('../utils');
    (utils.matchRoute as Mock).mockReturnValue({ route: options.routes[0], params: {} });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await app.inject({ method: 'GET', url: '/app' });
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('Internal Server Error');
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('should handle error reading template at request time in production', async () => {
    const failingConfig = {
      entryPoint: 'non-existent',
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'no-template.html',
      appId: 'failing',
    };
    options.configs.push(failingConfig);
    options.routes = [{ path: '/failing', attr: { render: RENDERTYPE.ssr }, appId: 'failing' }];
    isDevelopmentValue = false;

    fsReadFileMock.mockImplementationOnce(async (filePath: string) => {
      if (filePath.endsWith('index.html')) {
        return `<html><head>${SSRTAG.ssrHead}</head><body>${SSRTAG.ssrHtml}</body></html>`;
      }
      return originalFsReadFile(filePath);
    });

    fsReadFileMock.mockImplementationOnce((filePath: string) => {
      if (filePath.endsWith('no-template.html')) {
        throw new Error('File not found');
      }
      return originalFsReadFile(filePath);
    });

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const utils = await import('../utils');
    (utils.matchRoute as Mock).mockReturnValue({ route: options.routes[0], params: {} });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await app.inject({ method: 'GET', url: '/failing' });
    expect(response.statusCode).toBe(500);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error setting up SSR stream:', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  it('should handle error in notFoundHandler if no default config', async () => {
    isDevelopmentValue = false;
    options.configs = [];

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const utils = await import('../utils');
    (utils.matchRoute as Mock).mockReturnValue(undefined);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await app.inject({ method: 'GET', url: '/no-route' });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('Internal Server Error');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to serve clientHtmlTemplate:', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  it('should handle SSR render (RENDERTYPE.ssr)', async () => {
    isDevelopmentValue = false;
    options.routes = [{ path: '/', attr: { render: RENDERTYPE.ssr } }];

    const importedModule = {
      renderSSR: vi.fn().mockResolvedValue({
        headContent: '<head></head>',
        appHtml: '<div id="app"></div>',
        initialDataScript: '<script>window.__INITIAL_DATA__ = {}</script>',
      }),
      renderStream: vi.fn(),
    };
    vi.doMock(path.join(path.resolve(baseClientRoot, '.'), 'entry-server.js'), () => importedModule);

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const utils = await import('../utils');
    (utils.matchRoute as Mock).mockReturnValue({ route: options.routes[0], params: {} });

    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<div id="app"></div>');
    expect(importedModule.renderSSR).toHaveBeenCalled();
  });

  it('should handle streaming render (RENDERTYPE.streaming)', async () => {
    isDevelopmentValue = false;
    options.routes = [{ path: '/', attr: { render: RENDERTYPE.streaming } }];

    const importedModule = {
      renderSSR: vi.fn(),
      renderStream: vi.fn().mockImplementation((_res, callbacks) => {
        callbacks.onHead('<head></head>');
        callbacks.onFinish({});
      }),
    };
    vi.doMock(path.join(path.resolve(baseClientRoot, '.'), 'entry-server.js'), () => importedModule);

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const utils = await import('../utils');
    (utils.matchRoute as Mock).mockReturnValue({ route: options.routes[0], params: {} });

    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<head></head>');
    expect(importedModule.renderStream).toHaveBeenCalled();
  });

  it('should handle streaming error via onError callback', async () => {
    isDevelopmentValue = false;
    options.routes = [{ path: '/', attr: { render: RENDERTYPE.streaming } }];

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const importedModule = {
      renderSSR: vi.fn(),
      renderStream: vi.fn().mockImplementation((_res, callbacks) => {
        callbacks.onError(new Error('Stream error'));
      }),
    };
    vi.doMock(path.join(path.resolve(baseClientRoot, '.'), 'entry-server.js'), () => importedModule);

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const utils = await import('../utils');
    (utils.matchRoute as Mock).mockReturnValue({ route: options.routes[0], params: {} });

    const response = await app.inject({ method: 'GET', url: '/' });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Critical rendering onError:', expect.any(Error));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('Internal Server Error');

    consoleErrorSpy.mockRestore();
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

  it('should handle manifest missing entry client file', async () => {
    isDevelopmentValue = false;
    options.configs = [
      {
        appId: 'test-app',
        entryPoint: '.',
        entryClient: 'no-entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
      },
    ];

    fsReadFileMock.mockImplementationOnce(async (filePath: string) => {
      if (filePath.endsWith('index.html')) {
        return `<html><head>${SSRTAG.ssrHead}</head><body>${SSRTAG.ssrHtml}</body></html>`;
      }
      return originalFsReadFile(filePath);
    });
    fsReadFileMock.mockImplementationOnce(async (filePath: string) => {
      if (filePath.endsWith('ssr-manifest.json')) {
        return JSON.stringify({ 'entry-server.js': ['entry-server.js'] });
      }
      return originalFsReadFile(filePath);
    });
    fsReadFileMock.mockImplementationOnce(async (filePath: string) => {
      if (filePath.endsWith('manifest.json')) {
        return JSON.stringify({
          'entry-client.tsx': {
            file: 'entry-client.js',
            css: ['entry-client.css'],
          },
        });
      }
      return originalFsReadFile(filePath);
    });

    const { SSRServer } = await import('../SSRServer');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await app.register(SSRServer, options);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('Entry client file not found in manifest for no-entry-client.tsx');
    }

    consoleErrorSpy.mockRestore();
  });

  it('should handle errors from fetchInitialData', async () => {
    isDevelopmentValue = false;
    options.routes = [{ path: '/', attr: { render: RENDERTYPE.ssr } }];

    const utils = await import('../utils');
    (utils.fetchInitialData as Mock).mockRejectedValueOnce(new Error('fetchInitialData error'));
    (utils.matchRoute as Mock).mockReturnValue({ route: options.routes[0], params: {} });

    const importedModule = {
      renderSSR: vi.fn(),
      renderStream: vi.fn(),
    };
    vi.doMock(path.join(path.resolve(baseClientRoot, '.'), 'entry-server.js'), () => importedModule);

    const { SSRServer } = await import('../SSRServer');

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await app.register(SSRServer, options);

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('Internal Server Error');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error setting up SSR stream:', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  it('should handle debug logging middleware in dev mode', async () => {
    isDevelopmentValue = true;
    options.isDebug = true;
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const debugPlugin = mockVitePlugins.find((p) => p.name === 'taujs-development-server-debug-logging');
    expect(debugPlugin).toBeDefined();

    const req = { url: '/test-url' };
    const res = {
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'finish') cb();
      }),
    };
    const next = vi.fn();

    mockViteDevServer.middlewares.use.mock.calls[0][0](req, res, next);

    expect(consoleLogSpy).toHaveBeenCalledWith('rx: /test-url');
    expect(consoleLogSpy).toHaveBeenCalledWith('tx: /test-url');
    expect(next).toHaveBeenCalled();

    consoleLogSpy.mockRestore();
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
    expect(response.body).toContain('<link rel="preload stylesheet" as="style" type="text/css" href="/entry-client.css">');
  });

  it('should process development-specific code when isDevelopment is true', async () => {
    vi.resetModules();
    isDevelopmentValue = true;

    vi.doMock('../utils', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...(actual as Record<string, unknown>),
        matchRoute: vi.fn().mockReturnValue({
          route: { path: '/some-route', attr: {} },
          params: {},
        }),
        collectStyle: vi.fn().mockResolvedValue('/* styles */'),
        get isDevelopment() {
          return isDevelopmentValue;
        },
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

    const utils = await import('../utils');
    (utils.matchRoute as Mock).mockReturnValue({ route: options.routes[0], params: {} });
    // (utils.collectStyle as Mock).mockResolvedValue('.test-class { color: red; }');

    await app.register(SSRServer, options);

    const response = await app.inject({
      method: 'GET',
      url: '/dev-ssr',
    });

    expect(response.statusCode).toBe(200);
    const body = response.body;

    expect(body).not.toContain('/@vite/client');

    expect(body).not.toContain('.original-style { color: blue; }');
    // expect(body).toContain('.test-class { color: red; }');

    expect(body).toContain(
      '<html><head></head><div id="app"></div><script>window.__INITIAL_DATA__ = {}</script><script type="module" src="/entry-client" async=""></script></html>',
    );
  });

  // it('loads template at request time if not cached in templates map', async () => {
  //   vi.resetModules();
  //   isDevelopmentValue = false;

  //   const secondConfig = {
  //     appId: 'second-app',
  //     entryPoint: 'another-app',
  //     entryClient: 'entry-client',
  //     entryServer: 'entry-server',
  //     htmlTemplate: 'custom.html',
  //   };

  //   options.configs.push(secondConfig);

  //   fsReadFileMock.mockImplementation(async (filePath: string) => {
  //     if (filePath.includes('another-app') && filePath.endsWith('custom.html')) {
  //       return `<html><head><title>Another App</title>${SSRTAG.ssrHead}</head><body>${SSRTAG.ssrHtml}</body></html>`;
  //     }

  //     return originalFsReadFile(filePath);
  //   });

  //   options.routes = [{ path: '/second', attr: { render: RENDERTYPE.ssr }, appId: 'another-app' }];

  //   const importedModuleSecond = {
  //     renderSSR: vi.fn().mockResolvedValue({
  //       headContent: '<head><meta name="test" content="from-second-app"></head>',
  //       appHtml: '<div id="app"></div>',
  //       initialDataScript: '<script>window.__INITIAL_DATA__ = { second: true }</script>',
  //     }),
  //     renderStream: vi.fn(),
  //   };

  //   vi.doMock(path.join(path.resolve(baseClientRoot, 'another-app'), 'entry-server.js'), () => importedModuleSecond);

  //   const { SSRServer } = await import('../SSRServer');
  //   await app.register(SSRServer, options);

  //   const utils = await import('../utils');
  //   (utils.matchRoute as Mock).mockReturnValue({ route: options.routes[0], params: {} });

  //   const response = await app.inject({ method: 'GET', url: '/second' });

  //   expect(response.statusCode).toBe(200);
  //   expect(response.body).toContain('<meta name="test" content="from-second-app">');
  //   expect(response.body).toContain('<div id="app"></div>');
  //   expect(importedModuleSecond.renderSSR).toHaveBeenCalled();
  // });

  it('should handle loading template when not cached in templates map', async () => {
    isDevelopmentValue = false;

    const secondConfig = {
      entryPoint: 'another-app',
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
      appId: 'second-app',
    };
    options.configs.push(secondConfig);
    options.routes = [{ path: '/second', attr: { render: RENDERTYPE.ssr }, appId: 'second-app' }];

    const importedModuleDefault = {
      renderSSR: vi.fn().mockResolvedValue({
        headContent: '<head></head>',
        appHtml: '<div id="app"></div>',
        initialDataScript: '<script>window.__INITIAL_DATA__ = {}</script>',
      }),
      renderStream: vi.fn(),
    };
    vi.doMock(path.join(path.resolve(baseClientRoot, '.'), 'entry-server.js'), () => importedModuleDefault);

    const importedModuleSecond = {
      renderSSR: vi.fn().mockResolvedValue({
        headContent: '<head></head>',
        appHtml: '<div id="app"></div>',
        initialDataScript: '<script>window.__INITIAL_DATA__ = {}</script>',
      }),
      renderStream: vi.fn(),
    };
    vi.doMock(path.join(path.resolve(baseClientRoot, 'another-app'), 'entry-server.js'), () => importedModuleSecond);

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const utils = await import('../utils');
    (utils.matchRoute as Mock).mockReturnValue({ route: options.routes[0], params: {} });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.inject({ method: 'GET', url: '/second' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="app"></div>');
    consoleErrorSpy.mockRestore();
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
    expect(response.body).toContain('<link rel="preload stylesheet" as="style" type="text/css" href="/entry-client.css">');
  });

  it('should correctly handle not-found handler for SPA routes defaulting to "/" when req.url is undefined', async () => {
    options.routes = [];
    isDevelopmentValue = false;

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    app.addHook('onRequest', (request, _reply, done) => {
      request.raw.url = undefined;
      done();
    });

    const utils = await import('../utils');
    (utils.matchRoute as Mock).mockReturnValue(undefined);

    const response = await app.inject({
      method: 'GET',
      url: '/spa-route',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<html>');
    expect(response.body).toContain('</html>');
  });

  it('should default to RENDERTYPE.ssr when attr.render is undefined', async () => {
    isDevelopmentValue = false;
    options.routes = [{ path: '/default-render', attr: {} }];

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const utils = await import('../utils');
    (utils.matchRoute as Mock).mockReturnValue({ route: options.routes[0], params: {} });

    const importedModule = {
      renderSSR: vi.fn().mockResolvedValue({
        headContent: '<head></head>',
        appHtml: '<div id="app"></div>',
        initialDataScript: '<script>window.__INITIAL_DATA__ = {}</script>',
      }),
      renderStream: vi.fn(),
    };
    vi.doMock(path.join(path.resolve(baseClientRoot, '.'), 'entry-server.js'), () => importedModule);

    const response = await app.inject({ method: 'GET', url: '/default-render' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<div id="app"></div>');
    expect(importedModule.renderSSR).toHaveBeenCalled();
  });

  it('should throw an error when no configuration is found for the request', async () => {
    isDevelopmentValue = false;

    options.configs = [];
    options.routes = [{ path: '/test-route', attr: { render: RENDERTYPE.ssr }, appId: 'unknown-app' }];

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { SSRServer } = await import('../SSRServer');
    await app.register(SSRServer, options);

    const response = await app.inject({
      method: 'GET',
      url: '/test-route',
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('Internal Server Error');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error setting up SSR stream:'),
      expect.objectContaining({ message: 'No configuration found for the request.' }),
    );
    consoleErrorSpy.mockRestore();
  });

  it('should handle errors in the SSR stream setup', async () => {
    isDevelopmentValue = false;

    options.configs = [
      {
        appId: 'error-triggering-app',
        entryPoint: 'invalid-path',
        entryClient: 'entry-client',
        entryServer: 'mock-entry-server',
        htmlTemplate: 'non-existent.html',
      },
    ];

    options.routes = [{ path: '/error-trigger', attr: { render: RENDERTYPE.ssr }, appId: 'error-triggering-app' }];

    const { SSRServer } = await import('../SSRServer');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await app.register(SSRServer, options);

    const utils = await import('../utils');
    (utils.matchRoute as Mock).mockReturnValue({ route: options.routes[0], params: {} });

    const response = await app.inject({ method: 'GET', url: '/error-trigger' });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('Internal Server Error');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error setting up SSR stream:'), expect.any(Error));

    consoleErrorSpy.mockRestore();
  });
});

describe('processConfigs', () => {
  it('processConfigs should process configurations correctly', async () => {
    const { processConfigs } = await import('../SSRServer');
    const mockConfigs = [
      { entryPoint: 'entry1', appId: 'app1' },
      { entryPoint: 'entry2', entryClient: 'client2', appId: 'app2' },
    ];
    const mockBaseClientRoot = '/base/root';
    const mockTemplateDefaults = {
      defaultEntryClient: 'defaultClient',
      defaultEntryServer: 'defaultServer',
      defaultHtmlTemplate: 'defaultTemplate',
    };

    const result = processConfigs(mockConfigs, mockBaseClientRoot, mockTemplateDefaults);

    expect(result).toEqual([
      {
        clientRoot: path.resolve(mockBaseClientRoot, 'entry1'),
        entryClient: 'defaultClient',
        entryPoint: 'entry1',
        entryServer: 'defaultServer',
        htmlTemplate: 'defaultTemplate',
        appId: 'app1',
      },
      {
        clientRoot: path.resolve(mockBaseClientRoot, 'entry2'),
        entryClient: 'client2',
        entryPoint: 'entry2',
        entryServer: 'defaultServer',
        htmlTemplate: 'defaultTemplate',
        appId: 'app2',
      },
    ]);
  });
});
