import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as utils from '../';
import { RENDERTYPE } from '../../constants';

import type { ViteDevServer } from 'vite';
import type { MockedFunction } from 'vitest';
import type { RouteAttributes, ServiceRegistry } from '../../SSRServer';

describe('Environment-specific path resolution', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.resetModules();
  });

  it('should return ".." when in development mode', async () => {
    process.env.NODE_ENV = 'development';
    vi.resetModules();

    const { isDevelopment, __dirname } = await import('../');
    const expectedDirname = join(dirname(fileURLToPath(import.meta.url)), '../..');

    expect(isDevelopment).toBe(true);
    expect(__dirname).toBe(expectedDirname);
  });

  it('should return "./" when in production mode', async () => {
    const { isDevelopment, __dirname } = await import('../');
    const expectedDirname = join(dirname(fileURLToPath(import.meta.url)), '../');

    expect(isDevelopment).toBe(false);
    expect(__dirname).toBe(expectedDirname);
  });
});

describe('collectStyle', () => {
  const server = {
    transformRequest: vi.fn(),
    moduleGraph: {
      resolveUrl: vi.fn(async (url) => [null, url]),
      getModuleById: vi.fn(() => null),
    },
  } as unknown as ViteDevServer;

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should return CSS with transformed code when transformRequest resolves', async () => {
    const url = '/style.css';

    (server.transformRequest as MockedFunction<ViteDevServer['transformRequest']>).mockResolvedValue({ code: 'transformed-css-code', map: null });

    const result = await utils.collectStyle(server, [url]);

    expect(server.transformRequest).toHaveBeenCalledWith(url);
    expect(server.transformRequest).toHaveBeenCalledWith(`${url}?direct`);
    expect(result).toContain(`/* [collectStyle] ${url} */`);
    expect(result).toContain('transformed-css-code');
  });

  it('should return an empty string if no CSS files are found', async () => {
    const server = {
      transformRequest: vi.fn(() => Promise.resolve(null)),
      moduleGraph: {
        resolveUrl: vi.fn(() => Promise.resolve([null, 'entry.css-id'])),
        getModuleById: vi.fn(() => null),
      },
    } as unknown as ViteDevServer;
    const entries = ['entry.css'];
    const result = await utils.collectStyle(server, entries);

    expect(result).toBe('');
  });

  it('should not traverse or transform if modules have already been visited', async () => {
    const server = {
      transformRequest: vi.fn(() => Promise.resolve(null)),
      moduleGraph: {
        resolveUrl: vi.fn(() => Promise.resolve([null, 'entry.css-id'])),
        getModuleById: vi.fn(() => ({
          importedModules: new Set([{ url: 'module1.css' }, { url: 'module1.css' }]),
        })),
      },
    } as unknown as ViteDevServer;
    const entries = ['entry.css'];
    const result = await utils.collectStyle(server, entries);

    expect(result).toBe('');
  });
});

describe('renderPreloadLinks', () => {
  it('should render preload links for modules', () => {
    const manifest = {
      module1: ['file1.js', 'file1.css'],
      module2: ['file2.js'],
    };
    const result = utils.renderPreloadLinks(manifest);

    expect(result).toContain('<link rel="modulepreload" href="file1.js">');
    expect(result).toContain('<link rel="stylesheet" href="file1.css">');
    expect(result).toContain('<link rel="modulepreload" href="file2.js">');
  });
});

describe('renderPreloadLink', () => {
  it('should return appropriate preload link based on file type', () => {
    expect(utils.renderPreloadLink('file.js')).toBe('<link rel="modulepreload" href="file.js">');
    expect(utils.renderPreloadLink('file.css')).toBe('<link rel="stylesheet" href="file.css">');
    expect(utils.renderPreloadLink('file.png')).toBe('<link rel="preload" href="file.png" as="image" type="image/png">');
  });

  it('should return an empty string for unsupported file types', () => {
    expect(utils.renderPreloadLink('file.txt')).toBe('');
  });

  it('should return correct preload link for woff font files', () => {
    const result = utils.renderPreloadLink('font.woff');

    expect(result).toBe('<link rel="preload" href="font.woff" as="font" type="font/woff" crossorigin>');
  });

  it('should return correct preload link for woff2 font files', () => {
    const result = utils.renderPreloadLink('font.woff2');

    expect(result).toBe('<link rel="preload" href="font.woff2" as="font" type="font/woff2" crossorigin>');
  });

  it('should return correct preload link for gif image files', () => {
    const result = utils.renderPreloadLink('image.gif');

    expect(result).toBe('<link rel="preload" href="image.gif" as="image" type="image/gif">');
  });

  it('should return correct preload link for jpeg image files', () => {
    const result = utils.renderPreloadLink('image.jpeg');

    expect(result).toBe('<link rel="preload" href="image.jpeg" as="image" type="image/jpeg">');
  });

  it('should return correct preload link for jpg image files', () => {
    const result = utils.renderPreloadLink('image.jpg');

    expect(result).toBe('<link rel="preload" href="image.jpg" as="image" type="image/jpg">');
  });

  it('should return correct preload link for png image files', () => {
    const result = utils.renderPreloadLink('image.png');

    expect(result).toBe('<link rel="preload" href="image.png" as="image" type="image/png">');
  });

  it('should return correct preload link for svg image files', () => {
    const result = utils.renderPreloadLink('image.svg');

    expect(result).toBe('<link rel="preload" href="image.svg" as="image" type="image/svg+xml">');
  });

  it('should return an empty string for unsupported file types', () => {
    const result = utils.renderPreloadLink('file.txt');

    expect(result).toBe('');
  });
});

describe('callServiceMethod', () => {
  it('should call the specified service method and return data', async () => {
    const mockMethod = vi.fn().mockResolvedValue({ data: 'test' });
    const serviceRegistry: ServiceRegistry = {
      myService: {
        myMethod: mockMethod,
      },
    };
    const result = await utils.callServiceMethod(serviceRegistry, 'myService', 'myMethod', {});

    expect(mockMethod).toHaveBeenCalledWith({});
    expect(result).toEqual({ data: 'test' });
  });

  it('should throw an error if service method does not exist', async () => {
    const serviceRegistry: ServiceRegistry = {
      myService: {},
    };

    await expect(utils.callServiceMethod(serviceRegistry, 'myService', 'nonexistentMethod', {})).rejects.toThrow(
      'Service method nonexistentMethod does not exist on myService',
    );
  });

  it('should throw an error if the response is not an object', async () => {
    const mockMethod = vi.fn().mockResolvedValue('not-an-object');
    const serviceRegistry: ServiceRegistry = {
      myService: {
        myMethod: mockMethod,
      },
    };

    await expect(utils.callServiceMethod(serviceRegistry, 'myService', 'myMethod', {})).rejects.toThrow(
      'Expected object response from myService.myMethod, but got string',
    );
  });

  it('should throw an error if the response is null', async () => {
    const mockMethod = vi.fn().mockResolvedValue(null);
    const serviceRegistry: ServiceRegistry = {
      myService: {
        myMethod: mockMethod,
      },
    };

    await expect(utils.callServiceMethod(serviceRegistry, 'myService', 'myMethod', {})).rejects.toThrow(
      'Expected object response from myService.myMethod, but got object',
    );
  });

  it('should not throw an error if the response is a valid object', async () => {
    const mockMethod = vi.fn().mockResolvedValue({ success: true });
    const serviceRegistry: ServiceRegistry = {
      myService: {
        myMethod: mockMethod,
      },
    };
    const result = await utils.callServiceMethod(serviceRegistry, 'myService', 'myMethod', {});

    expect(result).toEqual({ success: true });
  });

  it('should throw an error if the service does not exist in the registry', async () => {
    const serviceRegistry: ServiceRegistry = {};

    await expect(utils.callServiceMethod(serviceRegistry, 'nonexistentService' as any, 'someMethod' as any, {})).rejects.toThrow(
      'Service nonexistentService does not exist in the registry',
    );
  });
});

describe('matchRoute', () => {
  it('should match a URL to a route', () => {
    const routes = [{ path: '/test' }];
    const result = utils.matchRoute('/test', routes);

    expect(result).toBeTruthy();
    expect(result?.route.path).toBe('/test');
  });

  it('should return null if no route matches', () => {
    const routes = [{ path: '/test' }];
    const result = utils.matchRoute('/nomatch', routes);

    expect(result).toBeNull();
  });
});

describe('getCssLinks', () => {
  it('should return a list of preload CSS links from the manifest', () => {
    const manifest = {
      module1: { css: ['style1.css', 'style2.css'], file: 'module1.js' },
    };
    const result = utils.getCssLinks(manifest);

    expect(result).toContain('<link rel="preload stylesheet" as="style" type="text/css" href="/style1.css">');
    expect(result).toContain('<link rel="preload stylesheet" as="style" type="text/css" href="/style2.css">');
  });
});

describe('overrideCSSHMRConsoleError', () => {
  it('should suppress specific HMR CSS errors', () => {
    const originalConsoleError = console.error;
    const spy = vi.spyOn(console, 'error');

    utils.overrideCSSHMRConsoleError();

    console.error('css hmr is not supported in runtime mode');
    expect(spy).not.toHaveBeenCalledWith('css hmr is not supported in runtime mode');

    console.error('some other error');
    expect(spy).toHaveBeenCalledWith('some other error');

    console.error = originalConsoleError;
  });
});

describe('fetchInitialData', () => {
  let serviceRegistry: ServiceRegistry;
  let attr: RouteAttributes | undefined;
  let params: Partial<Record<string, string | string[]>>;
  let ctx: { headers: Record<string, string> };
  let callServiceMethodMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    serviceRegistry = {
      exampleService: {
        exampleMethod: vi.fn().mockResolvedValue({ serviceData: 'success' }),
      },
    };
    attr = undefined;
    params = {};
    ctx = { headers: { 'x-test': '1' } };
    callServiceMethodMock = vi.fn();
  });

  it('returns an empty object when attr is undefined', async () => {
    const result = await utils.fetchInitialData(undefined, params, serviceRegistry, ctx);
    expect(result).toEqual({});
  });

  it('returns an empty object when attr.fetch is not a function', async () => {
    // @ts-expect-error
    attr = { render: RENDERTYPE.ssr, fetch: 'not-a-function' };
    const result = await utils.fetchInitialData(attr, params, serviceRegistry, ctx);
    expect(result).toEqual({});
  });

  it('returns directly resolved object from attr.fetch', async () => {
    attr = {
      render: RENDERTYPE.ssr,
      data: vi.fn().mockResolvedValue({ some: 'data' }),
    };

    const result = await utils.fetchInitialData(attr, params, serviceRegistry, ctx);

    expect(attr.data).toHaveBeenCalledWith(params, ctx);
    expect(result).toEqual({ some: 'data' });
  });

  it('calls injected callServiceMethod when service descriptor is returned', async () => {
    const mockCallServiceMethod = vi.fn().mockResolvedValue({ result: 'fromService' });

    attr = {
      render: RENDERTYPE.ssr,
      data: vi.fn().mockResolvedValue({
        serviceName: 'exampleService',
        serviceMethod: 'exampleMethod',
        args: { foo: 'bar' },
      }),
    };

    const result = await utils.fetchInitialData(attr, params, serviceRegistry, ctx, mockCallServiceMethod);

    expect(mockCallServiceMethod).toHaveBeenCalledWith(serviceRegistry, 'exampleService', 'exampleMethod', { foo: 'bar' });
    expect(result).toEqual({ result: 'fromService' });
  });

  it('calls callServiceMethod with empty args if not provided in service descriptor', async () => {
    callServiceMethodMock.mockResolvedValue({ fallback: true });

    attr = {
      render: RENDERTYPE.ssr,
      data: vi.fn().mockResolvedValue({
        serviceName: 'exampleService',
        serviceMethod: 'exampleMethod',
      }),
    };

    const result = await utils.fetchInitialData(attr, params, serviceRegistry, ctx, callServiceMethodMock);

    expect(callServiceMethodMock).toHaveBeenCalledWith(serviceRegistry, 'exampleService', 'exampleMethod', {});
    expect(result).toEqual({ fallback: true });
  });

  it('throws if service descriptor is invalid', async () => {
    attr = {
      render: RENDERTYPE.ssr,
      data: vi.fn().mockResolvedValue({
        serviceName: 'missingService',
        serviceMethod: 'missingMethod',
        args: {},
      }),
    };

    await expect(utils.fetchInitialData(attr, params, serviceRegistry, ctx)).rejects.toThrow(
      'Invalid service fetch: serviceName=missingService, method=missingMethod',
    );
  });

  it('throws error if fetch result is not an object', async () => {
    attr = {
      render: RENDERTYPE.ssr,
      data: vi.fn().mockResolvedValue(123 as any),
    };

    await expect(utils.fetchInitialData(attr, params, serviceRegistry, ctx, callServiceMethodMock)).rejects.toThrow('Invalid result from attr.fetch');

    expect(callServiceMethodMock).not.toHaveBeenCalled();
  });

  it('throws if attr.fetch throws an error', async () => {
    const error = new Error('fetch failed');
    attr = {
      render: RENDERTYPE.ssr,
      data: vi.fn().mockRejectedValue(error),
    };

    await expect(utils.fetchInitialData(attr, params, serviceRegistry, ctx, callServiceMethodMock)).rejects.toThrow('fetch failed');
  });
});

describe('ensureNonNull', () => {
  it('should return the value if it is not null or undefined', () => {
    const value = 'hello';
    const result = utils.ensureNonNull(value, 'Value is required');
    expect(result).toBe(value);
  });

  it('should throw an error if the value is null', () => {
    expect(() => utils.ensureNonNull(null, 'Value is required')).toThrowError('Value is required');
  });

  it('should throw an error if the value is undefined', () => {
    expect(() => utils.ensureNonNull(undefined, 'Value is required')).toThrowError('Value is required');
  });

  it('should allow complex types and preserve their structure', () => {
    const obj = { key: 'value' };
    const result = utils.ensureNonNull(obj, 'Object is required');
    expect(result).toBe(obj);
  });
});
