import { fileURLToPath } from 'node:url';
import path, { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as utils from '../';

import type { ViteDevServer } from 'vite';
import type { MockedFunction, MockInstance } from 'vitest';
import type { FetchConfig, RouteAttributes, RouteParams, ServiceRegistry } from '../../SSRServer';

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

describe('fetchData', () => {
  const baseMockResponse = {
    ok: true,
    json: () => Promise.resolve({ data: 'test' }),
    headers: new Headers(),
    redirected: false,
    status: 200,
    statusText: 'OK',
    type: 'basic',
    url: 'https://example.com',
    clone: () => ({}),
    body: null,
    bodyUsed: false,
    text: () => Promise.resolve(''),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
  } as Response;

  it('should fetch data from a URL and return the parsed JSON', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ...baseMockResponse,
        ok: true,
        json: () => Promise.resolve({ data: 'test' }),
      } as Response),
    );
    const result = await utils.fetchData({ url: 'https://example.com', options: {} });

    expect(result).toEqual({ data: 'test' });
  });

  it('should throw an error if the fetch fails', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ...baseMockResponse,
        ok: false,
        json: () => Promise.resolve({ data: 'test' }),
      } as Response),
    );

    await expect(utils.fetchData({ url: 'https://example.com', options: {} })).rejects.toThrow('Failed to fetch data from https://example.com');
  });

  it('should throw an error if the fetched data is not an object', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ...baseMockResponse,
        ok: true,
        json: () => Promise.resolve('not-an-object'),
      } as Response),
    );
    const fetchConfig = { url: 'https://example.com', options: {} };

    await expect(utils.fetchData(fetchConfig)).rejects.toThrow('Expected object response from https://example.com, but got string');
  });

  it('should throw an error if the fetched data is null', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ...baseMockResponse,
        ok: true,
        json: () => Promise.resolve(null),
      } as Response),
    );
    const fetchConfig = { url: 'https://example.com', options: {} };

    await expect(utils.fetchData(fetchConfig)).rejects.toThrow('Expected object response from https://example.com, but got object');
  });

  it('should throw an error if URL is not provided', async () => {
    const fetchConfig = { url: '', options: {} };

    await expect(utils.fetchData(fetchConfig)).rejects.toThrow('URL must be provided to fetch data');
  });

  it('should throw an error if the fetch request fails', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ...baseMockResponse,
        ok: false,
        json: () => Promise.resolve(null),
      } as Response),
    );
    const fetchConfig = { url: 'https://example.com', options: {} };

    await expect(utils.fetchData(fetchConfig)).rejects.toThrow('Failed to fetch data from https://example.com');
  });

  it('should return the fetched data if it is a valid object', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ...baseMockResponse,
        ok: true,
        json: () => Promise.resolve({ success: true }),
      } as Response),
    );
    const fetchConfig = { url: 'https://example.com', options: {} };
    const result = await utils.fetchData(fetchConfig);

    expect(result).toEqual({ success: true });
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
  let attr: RouteAttributes<RouteParams> | undefined;
  let params: Partial<Record<string, string | string[]>>;
  let mockFetchData: MockInstance<({ url, options }: FetchConfig) => Promise<Record<string, unknown>>>;
  let mockCallServiceMethod: MockInstance;

  beforeEach(() => {
    vi.resetAllMocks();
    serviceRegistry = {
      exampleService: {
        exampleMethod: vi.fn().mockResolvedValue({ serviceData: 'success' }),
      },
    };
    attr = undefined;
    params = {};

    mockFetchData = vi.spyOn(utils, 'fetchData').mockResolvedValue({ fetchedData: true });
    mockCallServiceMethod = vi.spyOn(utils, 'callServiceMethod').mockResolvedValue({ serviceData: 'success' });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ fetchedData: true }),
    } as unknown as Response);
  });

  it('should return an empty object when attr is undefined', async () => {
    const result = await utils.fetchInitialData(undefined, params, serviceRegistry);
    expect(result).toEqual({});
  });

  it('should return an empty object when attr.fetch is not a function', async () => {
    attr = {
      // @ts-ignore
      fetch: 'not-a-function',
    };
    const result = await utils.fetchInitialData(attr, params, serviceRegistry);
    expect(result).toEqual({});
  });

  it('should call attr.fetch and fetchData when serviceName and serviceMethod are not present', async () => {
    attr = {
      fetch: vi.fn().mockResolvedValue({ url: 'https://example.com', options: {} }),
    };

    const result = await utils.fetchInitialData(attr, params, serviceRegistry);

    expect(attr.fetch).toHaveBeenCalledWith(params, {
      headers: { 'Content-Type': 'application/json' },
      params,
    });
    expect(result).toEqual({ fetchedData: true });
  });

  it('should call callServiceMethod when serviceName and serviceMethod are present', async () => {
    attr = {
      fetch: vi.fn().mockResolvedValue({
        serviceName: 'exampleService',
        serviceMethod: 'exampleMethod',
        options: { params: { key: 'value' } },
      }),
    };

    const result = await utils.fetchInitialData(attr, params, serviceRegistry);

    expect(attr.fetch).toHaveBeenCalledWith(params, {
      headers: { 'Content-Type': 'application/json' },
      params,
    });
    expect(result).toEqual({ serviceData: 'success' });
  });

  it('should call callServiceMethod with empty params when data.options.params is undefined', async () => {
    attr = {
      fetch: vi.fn().mockResolvedValue({
        serviceName: 'exampleService',
        serviceMethod: 'exampleMethod',
        options: {},
      }),
    };

    const result = await utils.fetchInitialData(attr, params, serviceRegistry);

    expect(attr.fetch).toHaveBeenCalledWith(params, {
      headers: { 'Content-Type': 'application/json' },
      params,
    });
    expect(result).toEqual({ serviceData: 'success' });
  });

  it('should throw an error if attr.fetch rejects', async () => {
    const error = new Error('Fetch failed');
    attr = { fetch: vi.fn().mockRejectedValue(error) };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(utils.fetchInitialData(attr, params, serviceRegistry)).rejects.toThrow('Fetch failed');

    expect(attr.fetch).toHaveBeenCalledWith(params, {
      headers: { 'Content-Type': 'application/json' },
      params,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error fetching initial data:', error);

    consoleErrorSpy.mockRestore();
  });

  it('should throw an error if fetch config has neither serviceName/method nor url', async () => {
    const attr = {
      fetch: vi.fn().mockResolvedValue({}),
    };

    await expect(utils.fetchInitialData(attr, {}, {} as ServiceRegistry)).rejects.toThrow(
      'Invalid fetch configuration: must have either serviceName+serviceMethod or url',
    );

    expect(attr.fetch).toHaveBeenCalledWith(
      {},
      {
        headers: { 'Content-Type': 'application/json' },
        params: {},
      },
    );
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
