import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { handleRender } from '../HandleRender';
import * as DataRoutes from '../DataRoutes';
import * as Templates from '../Templates';
import * as System from '../System';
import { AppError } from '../../logging/AppError';
import { createLogger } from '../../logging/Logger';

import type { Mock } from 'vitest';

vi.mock('../DataRoutes');
vi.mock('../Templates');
vi.mock('../System');
vi.mock('../../logging/AppError', async () => {
  const actual = await vi.importActual<any>('../../logging/AppError');
  const { normaliseError, toReason } = actual;

  class FakeAppError extends Error {
    kind: string;
    httpStatus?: number;
    details?: unknown;
    safeMessage: string;

    constructor(message: string, kind: any = 'infra', opts?: any) {
      super(message);
      this.kind = kind;
      this.safeMessage = message;
      this.details = opts?.details;
    }
  }

  const internalSpy = vi.fn((message: string, optsOrCause?: any, detailsMaybe?: any) => {
    const err = new FakeAppError(
      message,
      'infra',
      optsOrCause && typeof optsOrCause === 'object' && 'details' in optsOrCause ? optsOrCause : { details: detailsMaybe },
    );
    return err as any;
  });

  (FakeAppError as any).internal = internalSpy;

  return {
    ...actual,
    AppError: FakeAppError,
    normaliseError,
    toReason,
  };
});

vi.mock('../../logging/Logger');
vi.mock('node:stream', () => {
  class MockPassThrough {
    private _dest: any = null;
    listeners: Record<string, Function[]> = {};
    writableEnded = false;

    on(event: string, cb: Function) {
      (this.listeners[event] ||= []).push(cb);
      return this;
    }

    once(event: string, cb: Function) {
      const wrapper = (...args: any[]) => {
        this.removeListener(event, wrapper);
        cb(...args);
      };
      return this.on(event, wrapper);
    }

    removeListener(event: string, cb: Function) {
      const arr = this.listeners[event];
      if (arr) this.listeners[event] = arr.filter((fn) => fn !== cb);
      return this;
    }

    removeAllListeners(event?: string) {
      if (event) delete this.listeners[event];
      else this.listeners = {};
      return this;
    }

    emit(event: string, ...args: any[]) {
      (this.listeners[event] || []).forEach((cb) => cb(...args));
      return true;
    }

    pipe(dest: any) {
      this._dest = dest;
      return dest;
    }

    write(chunk: any) {
      if (this._dest?.write) this._dest.write(chunk);
      this.emit('data', chunk);
      return true;
    }

    end(chunk?: any) {
      if (chunk !== undefined) this.write(chunk);
      this.writableEnded = true;
      if (this._dest?.end) this._dest.end();
      this.emit('finish');
      this.emit('end');
      return this;
    }

    destroy(err?: any) {
      if (err) this.emit('error', err);
      this.writableEnded = true;
      this.emit('close');
    }

    cork() {}
    uncork() {}
  }

  const mod = { PassThrough: MockPassThrough };
  return { ...mod, default: mod };
});

describe('handleRender', () => {
  let mockReq: any;
  let mockReply: any;
  let mockRouteMatchers: any[];
  let mockProcessedConfigs: any[];
  let mockServiceRegistry: any;
  let mockMaps: any;
  let mockLogger: any;
  let mockViteDevServer: any;
  let abortControllers: { abort: ReturnType<typeof vi.fn> }[] = [];

  const OriginalAbortController = globalThis.AbortController;

  const createMockRouteMatch = (attr: any = {}, appId = 'test-app', params: any = {}): any => ({
    route: { attr, appId },
    params,
    keys: [],
  });

  beforeEach(() => {
    mockLogger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    abortControllers = [];
    (globalThis as any).AbortController = vi.fn().mockImplementation(() => {
      const api = { abort: vi.fn(), signal: { aborted: false } };
      abortControllers.push(api);
      return api;
    });

    vi.mocked(createLogger).mockReturnValue(mockLogger as any);

    mockReq = {
      url: '/test-path',
      raw: {
        url: '/test-path',
        on: vi.fn(),
        off: vi.fn(),
      },
      headers: { host: 'localhost' },
      cspNonce: 'test-nonce-123',
    };

    mockReply = {
      callNotFound: vi.fn(),
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn(),
      getHeader: vi.fn().mockReturnValue('default-src self'),
      getHeaders: vi.fn().mockReturnValue({}),
      raw: {
        writeHead: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        once: vi.fn(function (this: any, event: string, cb: any) {
          return (this.on as any)(event, cb);
        }),
        flushHeaders: vi.fn(),
        writableEnded: false,
        destroyed: false,
        destroy: vi.fn(function (this: any, err?: any) {
          this.destroyed = true;
          this.writableEnded = true;
        }),
      },
    };

    mockRouteMatchers = [];
    mockProcessedConfigs = [
      {
        appId: 'test-app',
        clientRoot: '/test/client',
        entryServer: 'entry-server',
      },
    ];
    mockServiceRegistry = {};

    mockMaps = {
      bootstrapModules: new Map([['/test/client', '/assets/entry-client.js']]),
      cssLinks: new Map([['/test/client', '<link rel="stylesheet" href="/app.css">']]),
      manifests: new Map([['/test/client', {}]]),
      preloadLinks: new Map([['/test/client', '<link rel="preload">']]),
      renderModules: new Map(),
      ssrManifests: new Map([['/test/client', {}]]),
      templates: new Map([['/test/client', '<html><head><!--ssr-head--></head><body><!--ssr-html--></body></html>']]),
    };

    mockViteDevServer = {
      ssrLoadModule: vi.fn(),
      transformIndexHtml: vi.fn(),
    };

    vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(false);
  });

  afterEach(() => {
    vi.resetAllMocks();
    (globalThis as any).AbortController = OriginalAbortController;
  });

  describe('Asset file handling', () => {
    it('should call not found handler for asset files', async () => {
      mockReq.raw.url = '/static/image.png';

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockReply.callNotFound).toHaveBeenCalled();
    });

    it('should call not found handler for various asset extensions', async () => {
      const extensions = ['.js', '.css', '.jpg', '.svg', '.woff2', '.json'];

      for (const ext of extensions) {
        vi.clearAllMocks();
        mockReq.raw.url = `/asset${ext}`;

        await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

        expect(mockReply.callNotFound).toHaveBeenCalled();
      }
    });
  });

  describe('CSP nonce handling', () => {
    it('should handle valid nonce', async () => {
      mockReq.cspNonce = 'valid-nonce';

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete with nonce</html>');

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Test</title>',
          appHtml: '<div>Test</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(Templates.rebuildTemplate).toHaveBeenCalledWith(expect.any(Object), expect.any(String), expect.stringContaining('nonce="valid-nonce"'));
    });

    it('should handle empty nonce', async () => {
      mockReq.cspNonce = '';

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Test</title>',
          appHtml: '<div>Test</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      const bodyContent = vi.mocked(Templates.rebuildTemplate).mock.calls[0]?.[2]!;

      expect(bodyContent).not.toContain('nonce=');
    });

    it('should handle null nonce', async () => {
      mockReq.cspNonce = null;

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Test</title>',
          appHtml: '<div>Test</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      const bodyContent = vi.mocked(Templates.rebuildTemplate).mock.calls[0]?.[2]!;

      expect(bodyContent).not.toContain('nonce=');
    });
  });

  describe('Route matching', () => {
    it('should call not found when no route matches', async () => {
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(null);

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockReply.callNotFound).toHaveBeenCalled();
    });

    it('should throw error when config not found for appId', async () => {
      const mockRoute = createMockRouteMatch({}, 'non-existent-app');
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);

      const mockError = new AppError('Config not found', 'infra');
      vi.mocked(AppError.internal).mockReturnValue(mockError);

      await expect(handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();

      expect(AppError.internal).toHaveBeenCalledWith(
        'No configuration found for the request',
        expect.objectContaining({
          details: expect.objectContaining({
            appId: 'non-existent-app',
          }),
        }),
      );
    });
  });

  describe('SSR rendering', () => {
    it('should render SSR successfully with all assets', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Test</title>',
          appHtml: '<div>Test</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({ test: 'data' });

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockRenderModule.renderSSR).toHaveBeenCalled();
      expect(mockReply.status).toHaveBeenCalledWith(200);
      expect(mockReply.header).toHaveBeenCalledWith('Content-Type', 'text/html');
      expect(mockReply.send).toHaveBeenCalledWith('<html>complete</html>');
    });

    it('should render SSR without hydration when hydrate is false', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr', hydrate: false });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Test</title>',
          appHtml: '<div>Test</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockImplementation((parts, head, body) => {
        expect(body).not.toContain('type="module"');
        return '<html>no-hydrate</html>';
      });

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockReply.send).toHaveBeenCalled();
    });

    it('should handle meta in SSR rendering', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr', meta: { title: 'Test Page' } });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Test</title>',
          appHtml: '<div>Test</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      const renderSSRMock = mockRenderModule.renderSSR as Mock;
      expect(renderSSRMock).toHaveBeenCalled(); // ensures at least one call

      const [data, url, meta, signal, options] = renderSSRMock.mock.calls[0] as any[];

      expect(data).toEqual({});
      expect(url).toBe(mockReq.url);
      expect(meta).toEqual({ title: 'Test Page' });
      expect(signal).toEqual(expect.objectContaining({ aborted: false }));
      expect(options).toEqual(expect.objectContaining({ logger: mockLogger }));
    });

    it('should throw error when renderSSR is missing', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {};
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const mockError = new AppError('Missing renderSSR', 'infra');
      vi.mocked(AppError.internal).mockReturnValue(mockError);

      await expect(handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();
    });

    it('should escape JSON data in initial data script', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Test</title>',
          appHtml: '<div>Test</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({ html: '<script>alert("xss")</script>' });

      let capturedBody = '';
      vi.mocked(Templates.rebuildTemplate).mockImplementation((parts, head, body) => {
        capturedBody = body;
        return '<html>complete</html>';
      });

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(capturedBody).toContain('\\u003c');
    });

    it('wires onAborted to call abort("client_aborted")', async () => {
      const abortSpy = vi.fn(function (this: any, reason?: any) {
        // flip the flag like a real AbortController would do
        (this as any)._signal.aborted = true;
      });

      (globalThis as any).AbortController = vi.fn().mockImplementation(() => {
        const api = { _signal: { aborted: false }, abort: abortSpy } as any;
        Object.defineProperty(api, 'signal', {
          get() {
            return this._signal;
          },
        });
        return api;
      });

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      const mockRenderModule = { renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '' }) };
      mockMaps.renderModules.set('/test/client', mockRenderModule);
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      // capture the 'aborted' handler installed on req.raw
      let abortedHandler: (() => void) | undefined;
      mockReq.raw.on = vi.fn((event: string, cb: any) => {
        if (event === 'aborted') abortedHandler = cb;
        return mockReq.raw;
      });

      const p = handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);
      // fire it after wiring
      abortedHandler?.();
      await p;

      expect(abortSpy).toHaveBeenCalledWith('client_aborted');
    });

    it('aborts with "socket_closed" on reply close when not ended', async () => {
      const abortSpy = vi.fn();
      (globalThis as any).AbortController = vi.fn().mockImplementation(() => ({ abort: abortSpy, signal: { aborted: false } }));

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      const mockRenderModule = { renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '' }) };
      mockMaps.renderModules.set('/test/client', mockRenderModule);
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      let closeHandler: (() => void) | undefined;
      mockReply.raw.on = vi.fn((event: string, cb: any) => {
        if (event === 'close') closeHandler = cb;
        return mockReply.raw;
      });

      const p = handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      mockReply.raw.writableEnded = false; // required to take the abort path
      closeHandler?.();

      await p;
      expect(abortSpy).toHaveBeenCalledWith('socket_closed');
    });

    it('skips SSR immediately when signal is already aborted', async () => {
      (globalThis as any).AbortController = vi.fn().mockImplementation(() => ({ abort: vi.fn(), signal: { aborted: true } }));

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      const mockRenderModule = { renderSSR: vi.fn() };
      mockMaps.renderModules.set('/test/client', mockRenderModule);
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.warn).toHaveBeenCalledWith({ url: mockReq.url }, 'SSR skipped; already aborted');
      expect(mockRenderModule.renderSSR).not.toHaveBeenCalled();
    });

    it('warns and returns on benign SSR render error', async () => {
      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const renderSSR = vi.fn().mockRejectedValue(new Error('socket hang up')); // <- benign by regex
      mockMaps.renderModules.set('/test/client', { renderSSR });

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url, reason: 'socket hang up' }), 'SSR aborted mid-render (benign)');
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.any(Object), 'SSR render failed');
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    it('logs error and rethrows on non-benign SSR render error', async () => {
      vi.mocked(AppError.internal).mockReset(); // same rationale as above

      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html><head></head><body></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const renderSSR = vi.fn().mockRejectedValue(new Error('boom'));
      const viteDevServer = {
        ssrLoadModule: vi.fn().mockResolvedValue({ renderSSR }),
        transformIndexHtml: vi.fn().mockResolvedValue('<html><head></head><body></body></html>'),
      } as any;

      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await expect(handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer })).rejects.toThrow(
        'handleRender failed',
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          url: mockReq.url,
          error: expect.objectContaining({ message: 'boom' }),
        }),
        'SSR render failed',
      );
    });

    it('warns and returns on benign SSR send failure', async () => {
      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      mockMaps.renderModules.set('/test/client', {
        renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '<div/>' }),
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      // throw benign error from send
      mockReply.send = vi.fn(() => {
        throw new Error('EPIPE');
      });

      await expect(handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps)).resolves.toBeUndefined();

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url, reason: 'EPIPE' }), 'SSR send aborted (benign)');
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.any(Object), 'SSR send failed');
    });

    it('logs error on non-benign SSR send failure', async () => {
      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      mockMaps.renderModules.set('/test/client', {
        renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '<div/>' }),
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const kaboom = new Error('kaboom');
      mockReply.send = vi.fn(() => {
        throw kaboom;
      });

      await expect(handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps)).resolves.toBeUndefined();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ url: mockReq.url, error: expect.objectContaining({ message: 'kaboom' }) }),
        'SSR send failed',
      );
      expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.any(Object), 'SSR send aborted (benign)');
    });

    it('SSR render catch: benign via string err (uses ?? err)', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);

      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html><head></head><body></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const renderSSR = vi.fn().mockRejectedValue('aborted'); // no .message -> hits "?? err"
      const viteDevServer = {
        ssrLoadModule: vi.fn().mockResolvedValue({ renderSSR }),
        transformIndexHtml: vi.fn().mockResolvedValue('<html><head></head><body></body></html>'),
      } as any;

      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps, {
        viteDevServer,
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url, reason: 'aborted' }), 'SSR aborted mid-render (benign)');
    });

    it('SSR render catch: non-benign via undefined err (uses ?? "")', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);

      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html><head></head><body></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const renderSSR = vi.fn().mockRejectedValue(undefined); // triggers ?? ''
      const viteDevServer = {
        ssrLoadModule: vi.fn().mockResolvedValue({ renderSSR }),
        transformIndexHtml: vi.fn().mockResolvedValue('<html><head></head><body></body></html>'),
      } as any;

      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await expect(handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer })).rejects.toEqual(
        expect.objectContaining({ message: 'handleRender failed' }),
      );

      expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url, error: expect.any(Object) }), 'SSR render failed');
    });

    it('SSR send catch: benign via string err (uses ?? err)', async () => {
      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);

      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      const renderSSR = vi.fn().mockResolvedValue({ headContent: '', appHtml: '' });
      mockMaps.renderModules.set('/test/client', { renderSSR } as any);
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      mockReply.send = vi.fn(() => {
        throw 'premature'; // plain string -> uses ?? err
      }) as any;

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url, reason: 'premature' }), 'SSR send aborted (benign)');
    });

    it('SSR send catch: non-benign via undefined err (uses ?? "")', async () => {
      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);

      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      const renderSSR = vi.fn().mockResolvedValue({ headContent: '', appHtml: '' });
      mockMaps.renderModules.set('/test/client', { renderSSR } as any);
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      mockReply.send = vi.fn(() => {
        throw undefined; // triggers ?? ''
      }) as any;

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url, error: expect.any(Object) }), 'SSR send failed');
    });

    it('unsubscribes the aborted listener on reply finish', async () => {
      const mockRoute = {
        route: { attr: { render: 'ssr' }, appId: 'test-app' },
        params: {},
        keys: [],
      } as any;

      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '',
          appHtml: '<div>ok</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      const finishCall = (mockReply.raw.on as unknown as Mock).mock.calls.find(([event]) => event === 'finish');

      expect(finishCall).toBeTruthy();
      const finishHandler = finishCall![1] as () => void;

      const abortedCall = (mockReq.raw.on as unknown as Mock).mock.calls.find(([event]) => event === 'aborted');
      expect(abortedCall).toBeTruthy();
      const abortedHandler = abortedCall![1] as () => void;

      finishHandler();

      expect(mockReq.raw.off).toHaveBeenCalledWith('aborted', abortedHandler);
    });

    it('should unsubscribe aborted listener on reply finish in streaming mode', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      let abortedHandler: (() => void) | undefined;
      let finishHandler: (() => void) | undefined;

      mockReq.raw.on = vi.fn((event: string, cb: any) => {
        if (event === 'aborted') abortedHandler = cb;
        return mockReq.raw;
      });

      mockReply.raw.on = vi.fn((event: string, cb: any) => {
        if (event === 'finish') finishHandler = cb;
        return mockReply.raw;
      });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onShellReady?.();
        callbacks.onAllReady?.({ data: 'test' });

        setTimeout(() => {
          writable.emit('finish');
        }, 0);

        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockReq.raw.on).toHaveBeenCalledWith('aborted', expect.any(Function));
      expect(abortedHandler).toBeDefined();

      expect(mockReply.raw.on).toHaveBeenCalledWith('finish', expect.any(Function));
      expect(finishHandler).toBeDefined();

      finishHandler?.();

      expect(mockReq.raw.off).toHaveBeenCalledWith('aborted', abortedHandler);
    });
  });

  describe('Streaming rendering', () => {
    it('should render streaming successfully', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        writable.on = vi.fn((event: string, handler: any) => {
          if (event === 'finish') {
            handler();
          }
        });

        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onShellReady?.();
        callbacks.onAllReady?.({ streamed: 'data' });

        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockReply.raw.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockReply.raw.write).toHaveBeenCalled();
    });

    it('should handle streaming without hydration', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', hydrate: false, meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable, callbacks, initialData, location, bootstrapModules) => {
        expect(bootstrapModules).toBeUndefined();

        writable.on = vi.fn();
        callbacks.onHead?.('<title>Stream</title>');

        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockRenderStream).toHaveBeenCalled();
    });

    it('should abort stream when request is aborted', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      let abortCallback: (() => void) | undefined;
      mockReq.raw.on = vi.fn((event: string, cb: any) => {
        if (event === 'aborted') abortCallback = cb;
      });

      const mockRenderStream = vi.fn((writable) => {
        writable.on = vi.fn();
        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      abortCallback?.();

      expect(mockReq.raw.on).toHaveBeenCalledWith('aborted', expect.any(Function));
    });

    it('should handle reply close event', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      let closeCallback: (() => void) | undefined;
      mockReply.raw.on = vi.fn((event: string, cb: any) => {
        if (event === 'close') closeCallback = cb;
      });

      const mockRenderStream = vi.fn((writable) => {
        writable.on = vi.fn();
        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      mockReply.raw.writableEnded = false;
      closeCallback?.();

      expect(mockReply.raw.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should handle benign socket errors in PassThrough', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable) => {
        writable.on = vi.fn((event: string, handler: any) => {
          if (event === 'error') {
            handler(new Error('ECONNRESET'));
          }
        });

        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.error).not.toHaveBeenCalledWith('PassThrough error:', expect.any(Object));
    });

    it('should log non-benign socket errors in PassThrough', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable) => {
        writable.emit('error', new Error('Unknown error'));
        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Object), 'PassThrough error:');
    });

    it('should handle onError with client disconnect', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        writable.on = vi.fn();
        callbacks.onError?.(new Error('EPIPE'));
        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.warn).toHaveBeenCalledWith({}, 'Client disconnected before stream finished');
      expect(mockReply.raw.write.mock.calls.some((args: any[]) => String(args[0]).includes('__INITIAL_DATA__'))).toBe(false);
    });

    it('should handle finish event when already aborted', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onError?.(new Error('EPIPE'));
        writable.emit('finish');
        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockReply.raw.write).not.toHaveBeenCalledWith(expect.stringContaining('__INITIAL_DATA__'));
    });

    it('should handle finish event when already ended', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      mockReply.raw.writableEnded = true;

      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Test</title>');

        writable.on = vi.fn((event: string, handler: any) => {
          if (event === 'finish') {
            handler();
          }
        });

        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockReply.raw.end).not.toHaveBeenCalled();
    });

    it('should throw error when renderStream is missing', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {};
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const mockError = new AppError('Missing renderStream', 'infra');
      vi.mocked(AppError.internal).mockReturnValue(mockError);

      await expect(handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();
    });

    it('should escape JSON in streaming initial data', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onAllReady?.({ html: '<script>alert("xss")</script>' });

        writable.on = vi.fn((event: string, handler: any) => {
          if (event === 'finish') {
            handler();
          }
        });

        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockReply.raw.write).toHaveBeenCalledWith(expect.stringContaining('\\u003c'));
    });

    it('should dispatch taujs:data-ready event in streaming', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onAllReady?.({ data: 'test' });

        writable.on = vi.fn((event: string, handler: any) => {
          if (event === 'finish') {
            handler();
          }
        });

        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockReply.raw.write).toHaveBeenCalledWith(expect.stringContaining("window.dispatchEvent(new Event('taujs:data-ready'))"));
    });

    it('benign onError logs "destroy() failed" when destroy throws', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      mockReply.raw.destroy = vi.fn(() => {
        throw new Error('destroy fail (benign)');
      });

      const benign = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        writable.on = vi.fn();
        callbacks.onError?.(benign);
        writable.emit?.('finish');
        return { abort: vi.fn() };
      });

      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'ssr',
        expect.objectContaining({
          error: expect.objectContaining({ message: 'destroy fail (benign)' }),
        }),
        'stream teardown: destroy() failed',
      );
    });

    it('critical onError logs "abort() failed" when AbortController.abort throws', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const OriginalAbortController = globalThis.AbortController;
      (globalThis as any).AbortController = vi.fn().mockImplementation(() => ({
        abort: vi.fn(() => {
          throw new Error('abort fail');
        }),
      }));
      mockReply.raw.destroy = vi.fn();

      const mockRenderStream = vi.fn((writable, callbacks) => {
        writable.on = vi.fn();
        callbacks.onError?.(new Error('boom'));
        writable.emit?.('finish');
        return { abort: vi.fn() };
      });

      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'ssr',
        expect.objectContaining({
          error: expect.objectContaining({ message: 'abort fail' }),
        }),
        'stream teardown: abort() failed',
      );

      (globalThis as any).AbortController = OriginalAbortController;
    });

    it('critical onError logs "destroy() failed" when reply.raw.destroy throws', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const OriginalAbortController = globalThis.AbortController;
      (globalThis as any).AbortController = vi.fn().mockImplementation(() => ({ abort: vi.fn() }));
      mockReply.raw.destroy = vi.fn(() => {
        throw new Error('destroy fail (critical)');
      });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        writable.on = vi.fn();
        callbacks.onError?.(new Error('boom'));
        writable.emit?.('finish');
        return { abort: vi.fn() };
      });

      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'ssr',
        expect.objectContaining({
          error: expect.objectContaining({ message: 'destroy fail (critical)' }),
        }),
        'stream teardown: destroy() failed',
      );

      (globalThis as any).AbortController = OriginalAbortController;
    });

    it('streaming initialDataScript includes nonce attribute when cspNonce is present', async () => {
      mockReq.cspNonce = 'nonce-abc-123';

      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({ foo: 'bar' });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        writable.on = vi.fn((event: string, handler: any) => {
          if (event === 'finish') handler();
        });
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onAllReady?.({ hello: 'world' });
        return { abort: vi.fn() };
      });

      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      const scriptWrite = mockReply.raw.write.mock.calls.find((c: any[]) => String(c[0]).includes('window.__INITIAL_DATA__'))?.[0];

      expect(scriptWrite).toContain('nonce="nonce-abc-123"');
    });

    it('streaming initialDataScript omits nonce attribute when cspNonce is empty', async () => {
      mockReq.cspNonce = '';

      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({ foo: 'bar' });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        writable.on = vi.fn((event: string, handler: any) => {
          if (event === 'finish') handler();
        });
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onAllReady?.({ ok: true });
        return { abort: vi.fn() };
      });

      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      const scriptWrite = mockReply.raw.write.mock.calls.find((c: any[]) => String(c[0]).includes('window.__INITIAL_DATA__'))?.[0];

      expect(scriptWrite).toContain('<script');
      expect(scriptWrite).not.toContain('nonce=');
    });
  });

  describe('Development mode', () => {
    beforeEach(() => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);
    });

    it('should load module from Vite in dev mode', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html><head></head><body></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Dev</title>',
          appHtml: '<div>Dev</div>',
        }),
      };

      mockViteDevServer.ssrLoadModule.mockResolvedValue(mockRenderModule);
      mockViteDevServer.transformIndexHtml.mockResolvedValue('<html>transformed</html>');

      vi.mocked(Templates.collectStyle).mockResolvedValue('.dev { color: red; }');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer });

      expect(mockViteDevServer.ssrLoadModule).toHaveBeenCalledWith('/test/client/entry-server.tsx');
      expect(mockViteDevServer.transformIndexHtml).toHaveBeenCalled();
      expect(Templates.collectStyle).toHaveBeenCalled();
    });

    it('should strip Vite client script in dev mode', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);

      const templateWithVite = '<html><head><script type="module" src="/@vite/client"></script></head><body></body></html>';
      vi.mocked(Templates.ensureNonNull).mockReturnValue(templateWithVite);
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Dev</title>',
          appHtml: '<div>Dev</div>',
        }),
      };

      mockViteDevServer.ssrLoadModule.mockResolvedValue(mockRenderModule);
      mockViteDevServer.transformIndexHtml.mockImplementation((_url: any, html: any) => {
        expect(html).not.toContain('/@vite/client');
        return Promise.resolve(html);
      });

      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer });

      expect(mockViteDevServer.transformIndexHtml).toHaveBeenCalled();
    });

    it('should strip existing style tags in dev mode', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);

      const templateWithStyles = '<html><head><style type="text/css">.old { color: blue; }</style></head><body></body></html>';
      vi.mocked(Templates.ensureNonNull).mockReturnValue(templateWithStyles);
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Dev</title>',
          appHtml: '<div>Dev</div>',
        }),
      };

      mockViteDevServer.ssrLoadModule.mockResolvedValue(mockRenderModule);
      mockViteDevServer.transformIndexHtml.mockImplementation((_url: any, html: any) => {
        expect(html).not.toContain('.old { color: blue; }');
        return Promise.resolve(html);
      });

      vi.mocked(Templates.collectStyle).mockResolvedValue('.new { color: red; }');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer });

      expect(mockViteDevServer.transformIndexHtml).toHaveBeenCalled();
    });

    it('should handle dev mode asset loading errors', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const loadError = new Error('Failed to load module');
      mockViteDevServer.ssrLoadModule.mockRejectedValue(loadError);

      const mockError = new AppError('Dev load failed', 'infra');
      vi.mocked(AppError.internal).mockReturnValue(mockError);

      await expect(
        handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer }),
      ).rejects.toThrow();

      expect(AppError.internal).toHaveBeenCalledWith(
        'Failed to load dev assets',
        expect.objectContaining({
          cause: loadError,
        }),
      );
    });

    it('does not treat empty raw.url as an asset (covers url ?? "")', async () => {
      mockReq.raw.url = undefined;
      mockReq.url = '/';

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      const mockRenderModule = { renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '' }) };
      mockMaps.renderModules.set('/test/client', mockRenderModule);
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html/>');

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(DataRoutes.matchRoute).toHaveBeenCalled();
      expect(mockReply.callNotFound).not.toHaveBeenCalled();
    });

    it('injects collected styles with a nonce attribute in dev mode', async () => {
      mockReq.cspNonce = 'stylenonce-777';

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      // include <head> so our <style> injection can be verified
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html><head></head><body></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Dev</title>',
          appHtml: '<div>Dev</div>',
        }),
      };

      mockViteDevServer.ssrLoadModule.mockResolvedValue(mockRenderModule);
      vi.mocked(Templates.collectStyle).mockResolvedValue('.dev-style { display:block }');

      // Assert the <style> tag carries the nonce after collectStyle runs
      mockViteDevServer.transformIndexHtml.mockImplementation(async (_url: any, html: string) => {
        expect(html).toContain('<style type="text/css" nonce="stylenonce-777">.dev-style { display:block }</style>');
        return html;
      });

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>done</html>');

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer });
    });

    it('omits nonce on collected <style> when cspNonce is falsy in dev mode', async () => {
      // ensure dev
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

      // falsy nonce triggers the ": ''" branch of the ternary
      mockReq.cspNonce = '';

      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);

      // make sure </head> exists so replacement happens
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html><head></head><body></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mod = { renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '' }) };
      mockViteDevServer.ssrLoadModule.mockResolvedValue(mod);

      // non-empty styles so the injected tag is visible
      vi.mocked(Templates.collectStyle).mockResolvedValue('.x{y:z}');

      // assert *no* nonce on the injected <style>
      mockViteDevServer.transformIndexHtml.mockImplementation(async (_url: any, html: string) => {
        expect(html).toContain('<style type="text/css">.x{y:z}</style>');
        expect(html).not.toContain('nonce=');
        return html;
      });

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>ok</html>');

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer });
    });
  });

  describe('Production mode', () => {
    it('should use preloaded render module in production', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Prod</title>',
          appHtml: '<div>Prod</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockRenderModule.renderSSR).toHaveBeenCalled();
    });

    it('should throw error when render module not preloaded', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      mockMaps.renderModules.clear();

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const mockError = new AppError('Module not preloaded', 'infra');
      vi.mocked(AppError.internal).mockReturnValue(mockError);

      await expect(handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();
    });
  });

  describe('Initial data handling', () => {
    it('should build initial data input successfully', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' }, 'test-app', { id: '123' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Test</title>',
          appHtml: '<div>Test</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({ id: '123', name: 'Test' });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(DataRoutes.fetchInitialData).toHaveBeenCalledWith(
        mockRoute.route.attr,
        { id: '123' },
        mockServiceRegistry,
        expect.objectContaining({
          traceId: expect.any(String),
          headers: expect.objectContaining({ host: 'localhost' }),
          logger: expect.objectContaining({
            info: expect.any(Function),
            warn: expect.any(Function),
            error: expect.any(Function),
          }),
        }),
      );
    });

    it('should throw error when initial data input fails', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Test</title>',
          appHtml: '<div>Test</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      const dataError = new Error('Data fetch failed');

      vi.mocked(DataRoutes.fetchInitialData).mockRejectedValue(dataError);

      await expect(handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();

      expect(AppError.internal).toHaveBeenCalledWith(
        'handleRender failed',
        dataError,
        expect.objectContaining({
          url: mockReq.url,
        }),
      );
    });
  });

  describe('URL parsing', () => {
    it('should handle URL with query parameters', async () => {
      mockReq.url = '/test-path?query=value';

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Test</title>',
          appHtml: '<div>Test</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(DataRoutes.matchRoute).toHaveBeenCalledWith('/test-path', mockRouteMatchers);
    });

    it('should handle missing URL defaulting to root', async () => {
      mockReq.url = undefined;

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Test</title>',
          appHtml: '<div>Test</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(DataRoutes.matchRoute).toHaveBeenCalledWith('/', mockRouteMatchers);
    });
  });

  describe('Error handling', () => {
    it('should wrap non-AppError errors', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockImplementation(() => {
        throw new Error('Template error');
      });

      const mockError = new AppError('Wrapped error', 'infra');
      vi.mocked(AppError.internal).mockReturnValue(mockError);

      await expect(handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();

      expect(AppError.internal).toHaveBeenCalledWith(
        'handleRender failed',
        expect.any(Error),
        expect.objectContaining({
          url: mockReq.url,
        }),
      );
    });

    it('should rethrow AppError as-is', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);

      const appError = new AppError('Original AppError', 'domain');
      vi.mocked(Templates.ensureNonNull).mockImplementation(() => {
        throw appError;
      });

      await expect(handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toBe(appError);
    });

    describe('onError message extraction coverage', () => {
      const setupStreamAndFire = async (errValue: any) => {
        const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
        vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
        vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
        vi.mocked(Templates.processTemplate).mockReturnValue({
          beforeHead: '<html><head>',
          afterHead: '</head>',
          beforeBody: '<body>',
          afterBody: '</body></html>',
        });
        vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

        const mockRenderStream = vi.fn((writable, callbacks) => {
          if (!writable.on) writable.on = vi.fn();
          callbacks.onError?.(errValue);
          writable.emit?.('finish');
          return { abort: vi.fn() };
        });

        mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

        await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);
      };

      it.each([
        { label: 'Error with message', value: new Error('boom') },
        { label: 'plain string', value: 'aborted' },
        { label: 'object with message', value: { message: 'socket hang up' } },
        { label: 'number', value: 404 },
        { label: 'null', value: null },
        { label: 'undefined', value: undefined },
      ])('covers String((e as any)?.message ?? e ?? "") – $label', async ({ value }) => {
        await setupStreamAndFire(value);

        expect(mockReply.raw.destroy).toHaveBeenCalledTimes(1);
        expect(mockLogger.error.mock.calls.length + mockLogger.warn.mock.calls.length).toBeGreaterThan(0);
      });
    });

    it('includes routeOptions.url in wrapped error details', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);

      mockReq.routeOptions = { url: '/internal-route' };

      vi.mocked(Templates.ensureNonNull).mockImplementation(() => {
        throw new Error('boom in template');
      });

      await expect(handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();

      expect(AppError.internal).toHaveBeenCalledWith(
        'handleRender failed',
        expect.any(Error),
        expect.objectContaining({
          url: mockReq.url,
          route: '/internal-route',
        }),
      );
    });
  });

  describe('Logger configuration', () => {
    it('should use provided logger', async () => {
      const customLogger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };

      mockReq.raw.url = '/asset.png';

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps, { logger: customLogger as any });

      expect(createLogger).not.toHaveBeenCalled();
    });

    it('should create logger with dev settings in development', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

      mockReq.raw.url = '/asset.png';

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(createLogger).toHaveBeenCalledWith(
        expect.objectContaining({
          minLevel: 'debug',
          includeStack: expect.any(Function),
        }),
      );
    });

    it('should create logger with production settings in production', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(false);

      mockReq.raw.url = '/asset.png';

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(createLogger).toHaveBeenCalledWith(
        expect.objectContaining({
          minLevel: 'info',
        }),
      );
    });

    it('logs HTTP socket error only when not benign', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const handlers: Record<string, Function[]> = {};
      mockReply.raw.on = vi.fn((event: string, cb: any) => {
        (handlers[event] ||= []).push(cb);
        return mockReply.raw;
      });

      const mockRenderStream = vi.fn((writable) => {
        setTimeout(() => writable.emit('finish'), 0);
        return { abort: vi.fn() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      const p = handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      handlers['error']?.forEach((cb) => cb(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })));
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.any(Object), 'HTTP socket error:');

      handlers['error']?.forEach((cb) => cb(new Error('kaboom')));
      expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), 'HTTP socket error:');

      await expect(p).resolves.toBeUndefined();
    });

    it('includeStack returns true only for "error" in production', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(false);

      mockReq.raw.url = '/asset.png';
      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      type LoggerOpts = Parameters<typeof createLogger>[0];
      const args = ((vi.mocked(createLogger).mock.calls[0]?.[0] ?? {}) as LoggerOpts) || {};

      const includeStack = typeof args.includeStack === 'function' ? args.includeStack : () => Boolean(args.includeStack);

      expect(includeStack('error')).toBe(true);
      expect(includeStack('warn')).toBe(false);
      expect(includeStack('info')).toBe(false);
      expect(includeStack('debug')).toBe(false);
    });

    it('includeStack returns true for all levels in development', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

      mockReq.raw.url = '/asset.png';
      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      type LoggerOpts = Parameters<typeof createLogger>[0];
      const args = (vi.mocked(createLogger).mock.calls[0]?.[0] ?? {}) as LoggerOpts;

      const safeArgs = args ?? {};
      const includeStack = typeof safeArgs.includeStack === 'function' ? safeArgs.includeStack : () => Boolean(safeArgs.includeStack);

      expect(includeStack('error')).toBe(true);
      expect(includeStack('warn')).toBe(true);
      expect(includeStack('info')).toBe(true);
      expect(includeStack('debug')).toBe(true);
    });
  });

  describe('Default render type', () => {
    it('should default to SSR when render type not specified', async () => {
      const mockRoute = createMockRouteMatch({});
      vi.mocked(DataRoutes.matchRoute).mockReturnValue(mockRoute);
      vi.mocked(Templates.ensureNonNull).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Test</title>',
          appHtml: '<div>Test</div>',
        }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      await handleRender(mockReq, mockReply, mockRouteMatchers, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockRenderModule.renderSSR).toHaveBeenCalled();
    });
  });
});
