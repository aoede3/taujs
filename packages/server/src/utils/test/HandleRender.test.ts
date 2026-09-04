// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { AppError } from '../../core/errors/AppError';
import { InitialDataFailure } from '../../core/errors/InitialDataFailure';
import { noopEpisodeRecorder } from '../../core/introspection/EpisodeRecorder';
import * as DataRoutes from '../../core/routes/DataRoutes';
import * as System from '../../System';

import * as Templates from '../Templates';
import * as Telemetry from '../Telemetry';
import { handleRender } from '../HandleRender';
import { createLogger } from '../../logging/Logger';
import { testRenderer, brandedRenderModule } from '../../test/support/renderer';
import { collectDocument, collectDocumentFailure, collectPartialDocument } from '../../test/support/document';

import type { Mock } from 'vitest';

vi.mock('../../core/routes/DataRoutes');
vi.mock('../../System');
vi.mock('../Templates');
vi.mock('../Telemetry');

vi.mock('../../core/errors/AppError', async () => {
  const actual = await vi.importActual<any>('../../core/errors/AppError');
  const { normaliseError, toReason } = actual;

  class FakeAppError extends Error {
    kind: string;
    httpStatus?: number;
    details?: unknown;
    safeMessage: string;
    override cause?: unknown;

    constructor(message: string, kind: any = 'infra', opts?: any) {
      super(message);
      this.kind = kind;
      this.safeMessage = message;
      this.details = opts?.details;
      if (opts && opts.cause !== undefined) this.cause = opts.cause;
    }
  }

  const internalSpy = vi.fn((message: string, cause?: unknown, details?: unknown) => new FakeAppError(message, 'infra', { cause, details }));

  (FakeAppError as any).internal = internalSpy;
  (FakeAppError as any).isAppError = (v: unknown) => v instanceof FakeAppError;

  return {
    ...actual,
    AppError: FakeAppError,
    normaliseError,
    toReason,
  };
});

vi.mock('../../logging/Logger');

vi.mock('../Entry', () => ({
  resolveEntryFile: vi.fn((clientRoot: string, entryServer: string) => entryServer),
}));

// REAL streams throughout. The cold document consumes the renderer's writable with `for await`,
// so a double that fires `finish` synchronously would conflate writable finish with readable end -
// exactly the truncation this transport exists to avoid. Tests drive chunks with write()/end().

describe('handleRender', () => {
  let mockReq: any;
  let mockReply: any;
  let mockSelectedRoute: any;
  let mockProcessedConfigs: any[];
  let mockServiceRegistry: any;
  let mockMaps: any;
  let mockLogger: any;
  let mockViteDevServer: any;
  let abortControllers: { abort: ReturnType<typeof vi.fn> }[] = [];

  const OriginalAbortController = globalThis.AbortController;

  const createMockRouteMatch = (attr: any = {}, appId = 'test-app', params: any = {}, path = '/test-path'): any => ({
    route: { attr, appId, path },
    params,
    keys: [],
  });

  beforeEach(async () => {
    mockLogger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    abortControllers = [];
    // vitest 4: constructible mocks must use function/class implementations
    (globalThis as any).AbortController = vi.fn().mockImplementation(function () {
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
    };

    (mockReq as any).cspNonce = 'test-nonce-123';

    mockReply = {
      callNotFound: vi.fn(),
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      // The streaming strategy DECLARES its response type: Fastify owns the head now.
      type: vi.fn().mockReturnThis(),
      removeHeader: vi.fn().mockReturnThis(),
      send: vi.fn(),
      hijack: vi.fn(),
      getHeader: vi.fn().mockReturnValue('default-src self'),
      getHeaders: vi.fn().mockReturnValue({}),
      raw: {
        headersSent: false,
        writableFinished: false,
        writeHead: vi.fn(function (this: any) {
          this.headersSent = true;
        }),
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        once: vi.fn(function (this: any, event: string, cb: any) {
          return (this.on as any)(event, cb);
        }),
        flushHeaders: vi.fn(),
        writableEnded: false,
        destroyed: false,
        destroy: vi.fn(function (this: any, _err?: any) {
          this.destroyed = true;
          this.writableEnded = true;
        }),
      },
    };

    mockSelectedRoute = createMockRouteMatch({ render: 'ssr' });

    mockProcessedConfigs = [
      {
        appId: 'test-app',
        clientRoot: '/test/client',
        entryServer: 'entry-server.tsx',
        // Renderer v1: `renderer:` is required; the dev path validates the loaded module against it (key
        // 'test' - dev render-module doubles are branded via brandedRenderModule('test', ...)).
        renderer: testRenderer(),
      },
    ];

    mockServiceRegistry = {};

    mockMaps = {
      bootstrapModules: new Map([['/test/client', '/assets/entry-client.js']]),
      cssLinks: new Map([['/test/client', '<link rel="stylesheet" href="/app.css">']]),
      manifests: new Map([['/test/client', {}]]),
      preloadLinks: new Map([['/test/client', '<link rel="preload">']]),
      renderModules: new Map(),
      templates: new Map([['/test/client', '<html><head><!--ssr-head--></head><body><!--ssr-html--></body></html>']]),
    };

    mockViteDevServer = {
      ssrLoadModule: vi.fn(),
      transformIndexHtml: vi.fn(),
    };

    // Default: prod behaviour
    vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(false);

    vi.mocked(Telemetry.createRequestContext).mockReturnValue({
      requestId: 'episode-1',
      logger: mockLogger,
      headers: { host: 'localhost' },
      url: '/test-path',
    } as any);

    const actualTemplates = await vi.importActual<typeof import('../Templates')>('../Templates');
    vi.mocked(Templates.addNonceToInlineScripts).mockImplementation(actualTemplates.addNonceToInlineScripts);
    vi.mocked(Templates.stripDevClient).mockImplementation(actualTemplates.stripDevClient);
    vi.mocked(Templates.applyViteTransform).mockImplementation(actualTemplates.applyViteTransform);
    // Use the REAL attribute-escape so the SSR bootstrap-tag sink is exercised end-to-end (R2-02 SEC2).
    vi.mocked(Templates.escapeHtmlAttribute).mockImplementation(actualTemplates.escapeHtmlAttribute);
  });

  afterEach(() => {
    vi.resetAllMocks();
    (globalThis as any).AbortController = OriginalAbortController;
  });

  describe('loader context', () => {
    it('forwards the request context url to attr.data as ctx.url, query string included', async () => {
      vi.mocked(Telemetry.createRequestContext).mockReturnValue({
        requestId: 'episode-1',
        logger: mockLogger,
        headers: { host: 'localhost' },
        url: '/x?a=1',
      } as any);
      mockSelectedRoute = createMockRouteMatch({ render: 'ssr', data: async () => ({}) });
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({ beforeHead: '<html><head>', afterHead: '</head>', beforeBody: '<body>', afterBody: '</body></html>' });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html></html>');
      mockMaps.renderModules.set('/test/client', { renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '<div/>' }) });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(DataRoutes.fetchInitialData).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ url: '/x?a=1', headers: { host: 'localhost' } }),
      );
    });
  });

  describe('CSP nonce handling', () => {
    it('should handle valid nonce', async () => {
      (mockReq as any).cspNonce = 'valid-nonce';

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(Templates.rebuildTemplate).toHaveBeenCalledWith(expect.any(Object), expect.any(String), expect.stringContaining('nonce="valid-nonce"'));
    });

    it('should handle empty nonce', async () => {
      (mockReq as any).cspNonce = '';

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      const bodyContent = vi.mocked(Templates.rebuildTemplate).mock.calls[0]?.[2]!;
      expect(bodyContent).not.toContain('nonce=');
    });

    it('R2-02 SEC2: an attribute-breakout bootstrapModule is escaped in the SSR bootstrap tag (no live onerror)', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' }); // hydrate defaults to true
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      mockMaps.renderModules.set('/test/client', {
        renderSSR: vi.fn().mockResolvedValue({ headContent: '<title>t</title>', appHtml: '<div>a</div>' }),
      });
      // Config-controlled bootstrap-module path with an attribute-breakout payload.
      mockMaps.bootstrapModules.set('/test/client', '/x.js" onerror="alert(1)');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      // bootstrapScriptTag is the tail of rebuildTemplate's bodyContent (3rd) arg.
      const bodyContent = vi.mocked(Templates.rebuildTemplate).mock.calls[0]?.[2]!;
      expect(bodyContent).toContain('src="/x.js&quot; onerror=&quot;alert(1)"'); // encoded once
      expect(bodyContent).not.toContain('onerror="alert(1)"'); // no live attribute
    });

    it('should handle null nonce', async () => {
      (mockReq as any).cspNonce = null;

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      const bodyContent = vi.mocked(Templates.rebuildTemplate).mock.calls[0]?.[2]!;
      expect(bodyContent).not.toContain('nonce=');
    });
  });

  describe('Selected route handling', () => {
    it('should throw error when config not found for appId', async () => {
      const mockRoute = createMockRouteMatch({}, 'non-existent-app');
      mockSelectedRoute = mockRoute;

      const mockError = new AppError('Config not found', 'infra');
      vi.mocked(AppError.internal).mockReturnValue(mockError);

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();

      expect(AppError.internal).toHaveBeenCalledWith(
        'No configuration found for the request',
        undefined,
        expect.objectContaining({
          appId: 'non-existent-app',
        }),
      );
    });
  });

  describe('SSR rendering', () => {
    it('should render SSR successfully with all assets', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockRenderModule.renderSSR).toHaveBeenCalled();
      expect(mockReply.status).toHaveBeenCalledWith(200);
      expect(mockReply.header).toHaveBeenCalledWith('Content-Type', 'text/html');
      expect(mockReply.send).toHaveBeenCalledWith('<html>complete</html>');
    });

    it('should render SSR without hydration when hydrate is false', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr', hydrate: false });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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
      vi.mocked(Templates.rebuildTemplate).mockImplementation((_parts, _head, body) => {
        expect(body).not.toContain('type="module"');
        return '<html>no-hydrate</html>';
      });

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockReply.send).toHaveBeenCalled();
    });

    it('should handle meta in SSR rendering', async () => {
      const attr = { render: 'ssr', meta: { title: 'Test Page' } };
      const params = { id: '123' };
      const mockRoute = createMockRouteMatch(attr, 'test-app', params, '/test-path');
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      const renderSSRMock = mockRenderModule.renderSSR as Mock;
      const [data, url, meta, signal, options] = renderSSRMock.mock.calls[0] as any[];

      expect(data).toEqual({});
      expect(url).toBe(mockReq.url);
      expect(meta).toEqual({ title: 'Test Page' });
      expect(signal).toEqual(expect.objectContaining({ aborted: false }));
      expect(options).toEqual(
        expect.objectContaining({
          logger: mockLogger,
          routeContext: {
            appId: 'test-app',
            path: '/test-path',
            attr,
            params,
          },
        }),
      );

      // Ruled shape gate (followup 2026-07-29): exactly the four runtime keys, matching the
      // public RouteContext type - `data` must never appear.
      expect(Object.keys(options.routeContext).sort()).toEqual(['appId', 'attr', 'params', 'path']);
    });

    it('should throw error when renderSSR is missing', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();

      expect(AppError.internal).toHaveBeenCalledWith('renderSSR function not found in module', undefined, {
        clientRoot: '/test/client',
        availableFunctions: [],
      });
    });

    it('should escape JSON data in initial data script', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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
      vi.mocked(Templates.rebuildTemplate).mockImplementation((_parts, _head, body) => {
        capturedBody = body;
        return '<html>complete</html>';
      });

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(capturedBody).toContain('\\u003c');
    });

    it('wires onAborted to call abort("client_aborted")', async () => {
      const abortSpy = vi.fn(function (this: any, _reason?: any) {
        (this as any)._signal.aborted = true;
      });

      (globalThis as any).AbortController = vi.fn().mockImplementation(function () {
        const api = { _signal: { aborted: false }, abort: abortSpy } as any;
        Object.defineProperty(api, 'signal', {
          get() {
            return this._signal;
          },
        });
        return api;
      });

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      const mockRenderModule = { renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '' }) };
      mockMaps.renderModules.set('/test/client', mockRenderModule);
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      let abortedHandler: (() => void) | undefined;
      mockReq.raw.on = vi.fn((event: string, cb: any) => {
        if (event === 'aborted') abortedHandler = cb;
        return mockReq.raw;
      });

      const p = handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);
      abortedHandler?.();
      await p;

      expect(abortSpy).toHaveBeenCalledWith('client_aborted');
    });

    it('aborts with "socket_closed" on reply close when not ended', async () => {
      const abortSpy = vi.fn();
      (globalThis as any).AbortController = vi.fn().mockImplementation(function () {
        return { abort: abortSpy, signal: { aborted: false } };
      });

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      const p = handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      mockReply.raw.writableEnded = false; // required to take the abort path
      closeHandler?.();

      await p;
      expect(abortSpy).toHaveBeenCalledWith('socket_closed');
    });

    it('skips SSR immediately when signal is already aborted', async () => {
      (globalThis as any).AbortController = vi.fn().mockImplementation(function () {
        return { abort: vi.fn(), signal: { aborted: true } };
      });

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      const mockRenderModule = { renderSSR: vi.fn() };
      mockMaps.renderModules.set('/test/client', mockRenderModule);
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.warn).toHaveBeenCalledWith({ url: mockReq.url }, 'SSR skipped; already aborted');
      expect(mockRenderModule.renderSSR).not.toHaveBeenCalled();
    });

    it('R0-02: SSR render error with a disconnect-shaped message but signal NOT aborted → 500, not a silent hang', async () => {
      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      // render-origin error whose message merely LOOKS like a disconnect — must not be swallowed
      // (previously returned benign+silent, hanging the request).
      const renderSSR = vi.fn().mockRejectedValue(new Error('Payment aborted unexpectedly'));
      mockMaps.renderModules.set('/test/client', { renderSSR });

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow(
        'handleRender failed',
      );

      expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url }), 'SSR render failed');
      expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.any(Object), 'SSR aborted mid-render (client disconnected)');
    });

    it('logs error and rethrows on non-benign SSR render error', async () => {
      vi.mocked(AppError.internal).mockReset(); // same rationale as above

      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html><head></head><body></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const renderSSR = vi.fn().mockRejectedValue(new Error('boom'));
      const viteDevServer = {
        ssrLoadModule: vi.fn().mockResolvedValue(brandedRenderModule('test', { renderSSR })),
        transformIndexHtml: vi.fn().mockResolvedValue('<html><head></head><body></body></html>'),
      } as any;

      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer })).rejects.toThrow(
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
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      // throw a real socket-origin error from send (benign by code — R0-02)
      mockReply.send = vi.fn(() => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      });

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).resolves.toBeUndefined();

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url, reason: 'write EPIPE' }), 'SSR send aborted (benign)');
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.any(Object), 'SSR send failed');
    });

    it('logs error on non-benign SSR send failure', async () => {
      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).resolves.toBeUndefined();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ url: mockReq.url, error: expect.objectContaining({ message: 'kaboom' }) }),
        'SSR send failed',
      );
      expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.any(Object), 'SSR send aborted (benign)');
    });

    it('R0-02: SSR render throws after the client disconnected (signal aborted) → benign, silent (?? err coverage)', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

      // Client disconnects DURING render: signal is false at the pre-render check, true at the catch.
      const signal = { aborted: false };
      (globalThis as any).AbortController = vi.fn().mockImplementation(function () {
        return { abort: vi.fn(), signal };
      });

      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      mockSelectedRoute = mockRoute;

      vi.mocked(Templates.requireTemplate).mockReturnValue('<html><head></head><body></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const renderSSR = vi.fn().mockImplementation(async () => {
        signal.aborted = true; // client vanished mid-render
        throw 'aborted'; // string, no .message -> exercises the "?? err" reason extraction
      });
      const viteDevServer = {
        ssrLoadModule: vi.fn().mockResolvedValue(brandedRenderModule('test', { renderSSR })),
        transformIndexHtml: vi.fn().mockResolvedValue('<html><head></head><body></body></html>'),
      } as any;

      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, {
        viteDevServer,
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ url: mockReq.url, reason: 'aborted' }),
        'SSR aborted mid-render (client disconnected)',
      );
    });

    it('SSR render catch: non-benign via undefined err (uses ?? "")', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      mockSelectedRoute = mockRoute;

      vi.mocked(Templates.requireTemplate).mockReturnValue('<html><head></head><body></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const renderSSR = vi.fn().mockRejectedValue(undefined); // triggers ?? ''
      const viteDevServer = {
        ssrLoadModule: vi.fn().mockResolvedValue(brandedRenderModule('test', { renderSSR })),
        transformIndexHtml: vi.fn().mockResolvedValue('<html><head></head><body></body></html>'),
      } as any;

      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer })).rejects.toEqual(
        expect.objectContaining({ message: 'handleRender failed' }),
      );

      expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url, error: expect.any(Object) }), 'SSR render failed');
    });

    it('R0-02: SSR send catch: a thrown string has no socket shape → NOT benign → send-failed logged (?? err coverage)', async () => {
      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      mockSelectedRoute = mockRoute;

      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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
        throw 'premature'; // plain string -> no .code/.message, so NOT benign (R0-02); '?? err' extracts the message
      }) as any;

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url }), 'SSR send failed');
      expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.any(Object), 'SSR send aborted (benign)');
    });

    it('SSR send catch: non-benign via undefined err (uses ?? "")', async () => {
      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      mockSelectedRoute = mockRoute;

      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url, error: expect.any(Object) }), 'SSR send failed');
    });

    it('unsubscribes the aborted listener on reply finish', async () => {
      const mockRoute = {
        route: { attr: { render: 'ssr' }, appId: 'test-app' },
        params: {},
        keys: [],
      } as any;

      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      const finishCall = (mockReply.raw.on as unknown as Mock).mock.calls.find(([event]) => event === 'finish');
      expect(finishCall).toBeTruthy();
      const finishHandler = finishCall![1] as () => void;

      const abortedCall = (mockReq.raw.on as unknown as Mock).mock.calls.find(([event]) => event === 'aborted');
      expect(abortedCall).toBeTruthy();
      const abortedHandler = abortedCall![1] as () => void;

      finishHandler();
      expect(mockReq.raw.off).toHaveBeenCalledWith('aborted', abortedHandler);
    });

    it('should render streaming successfully and pass routeContext', async () => {
      const attr = { render: 'streaming', meta: {} };
      const params = { slug: 'abc' };
      const mockRoute = createMockRouteMatch(attr, 'test-app', params, '/articles/:slug');
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        // basic behaviour
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onShellReady?.();
        callbacks.onAllReady?.({ streamed: 'data' });
        writable.end();
        return { abort: vi.fn(), done: Promise.resolve() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const document = await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));
      // Status is Fastify's (spine cell 1); at this layer the contract is the document itself.
      expect(document.length).toBeGreaterThan(0);

      expect(mockRenderStream).toHaveBeenCalled();

      const call = mockRenderStream.mock.calls[0] as any[];
      // ESC-2: positional cspNonce removed, so opts shifted from index 8 to 7.
      const options = call[7];

      expect(options).toEqual(
        expect.objectContaining({
          logger: mockLogger,
          routeContext: {
            appId: 'test-app',
            path: '/articles/:slug',
            attr,
            params,
          },
        }),
      );

      // Ruled shape gate (followup 2026-07-29): exactly the four runtime keys, matching the
      // public RouteContext type - `data` must never appear.
      expect(Object.keys(options.routeContext).sort()).toEqual(['appId', 'attr', 'params', 'path']);
    });

    // ESC-2: cspNonce + shouldHydrate are the symmetric RenderOptions - computed ONCE by the host and
    // delivered in `opts` on BOTH strategies (renderSSR opts index 4, renderStream opts index 7).
    it('ESC-2 symmetry (SSR): renderSSR opts carry cspNonce + shouldHydrate', async () => {
      (mockReq as any).cspNonce = 'esc2-nonce';

      const mockRoute = createMockRouteMatch({ render: 'ssr' }); // hydrate defaults to true
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '' }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      // renderSSR(data, url, meta, signal, opts) - opts is the 5th arg (index 4).
      const opts = (mockRenderModule.renderSSR as Mock).mock.calls[0]![4];
      expect(opts).toEqual(expect.objectContaining({ cspNonce: 'esc2-nonce', shouldHydrate: true }));
    });

    it('ESC-2 symmetry (streaming): renderStream opts carry cspNonce + shouldHydrate', async () => {
      (mockReq as any).cspNonce = 'esc2-nonce';

      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onShellReady?.();
        callbacks.onAllReady?.({});
        writable.end();
        return { abort: vi.fn(), done: Promise.resolve() };
      });
      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      // renderStream opts is index 7 (positional cspNonce removed in ESC-2).
      const opts = (mockRenderStream.mock.calls[0] as any[])[7];
      expect(opts).toEqual(expect.objectContaining({ cspNonce: 'esc2-nonce', shouldHydrate: true }));
    });

    it('should unsubscribe aborted listener on reply finish in streaming mode', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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
          writable.end();
        }, 0);

        writable.end();

        return { abort: vi.fn(), done: Promise.resolve() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockReq.raw.on).toHaveBeenCalledWith('aborted', expect.any(Function));
      expect(abortedHandler).toBeDefined();

      expect(mockReply.raw.on).toHaveBeenCalledWith('finish', expect.any(Function));
      expect(finishHandler).toBeDefined();

      finishHandler?.();
      expect(mockReq.raw.off).toHaveBeenCalledWith('aborted', abortedHandler);
    });

    it('dev + ssr: calls addNonceToInlineScripts only when nonce is present', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);
      (mockReq as any).cspNonce = 'nonce-2';

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;

      vi.mocked(Templates.requireTemplate).mockReturnValue('<html><head></head><body><!--ssr-html--></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      mockViteDevServer.ssrLoadModule.mockResolvedValue(
        brandedRenderModule('test', { renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '' }) }),
      );

      mockViteDevServer.transformIndexHtml.mockResolvedValue('<html><head></head><body></body></html>');
      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html/>');

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, {
        viteDevServer: mockViteDevServer,
      });

      expect(Templates.addNonceToInlineScripts).toHaveBeenCalled();
    });

    it('dev + ssr: does not call addNonceToInlineScripts when nonce is empty', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);
      (mockReq as any).cspNonce = '';

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;

      vi.mocked(Templates.requireTemplate).mockReturnValue('<html><head></head><body><!--ssr-html--></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      mockViteDevServer.ssrLoadModule.mockResolvedValue(
        brandedRenderModule('test', { renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '' }) }),
      );

      mockViteDevServer.transformIndexHtml.mockResolvedValue('<html><head></head><body></body></html>');
      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html/>');

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, {
        viteDevServer: mockViteDevServer,
      });

      expect(Templates.addNonceToInlineScripts).not.toHaveBeenCalled();
    });

    it('ssr: does not append preloadLink when the route does not hydrate', async () => {
      // RULED 2026-08-26: preload emission is gated on shouldHydrate, not on manifest presence -
      // a route that never runs client JS has nothing for a modulepreload to accelerate.
      const mockRoute = createMockRouteMatch({ render: 'ssr', hydrate: false });
      mockSelectedRoute = mockRoute;

      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({ headContent: '<meta name="x">', appHtml: '<div/>' }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      let capturedHead = '';
      vi.mocked(Templates.rebuildTemplate).mockImplementation((_p, head) => {
        capturedHead = head;
        return '<html/>';
      });

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(capturedHead).toContain('<meta name="x">');
      expect(capturedHead).not.toContain('<link rel="preload">'); // from your preloadLinks map
    });

    it('ssr: does not append cssLink when manifest is missing', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;

      mockMaps.manifests.delete('/test/client');

      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({ headContent: '<meta name="x">', appHtml: '<div/>' }),
      };
      mockMaps.renderModules.set('/test/client', mockRenderModule);
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      let capturedHead = '';
      vi.mocked(Templates.rebuildTemplate).mockImplementation((_p, head) => {
        capturedHead = head;
        return '<html/>';
      });

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(capturedHead).toContain('<meta name="x">');
      expect(capturedHead).not.toContain('rel="stylesheet"'); // from your cssLinks map
    });
  });

  describe('Streaming rendering', () => {
    it('should render streaming successfully', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onShellReady?.();
        callbacks.onAllReady?.({ streamed: 'data' });

        writable.end();

        return { abort: vi.fn(), done: Promise.resolve() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const document = await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      // CONTRACT PRESERVED: the previous `writeHead(200)` + `raw.write` pair protected "the head
      // commits and the shell reaches the client". Fastify owns the status now, so status lives in
      // the real-listener suite; at this layer the contract is that the document CARRIES the shell.
      expect(document).toContain('<html><head>');
      expect(document).toContain('<title>Stream</title>');
    });

    // SCOPE CORRECTED: a unit test emitting an EventEmitter event proves REACTION to an abort
    // observation, not a network disconnect. Signal IDENTITY and THREADING are the unit contract
    // here; the real disconnect cancelling those signals is spine cell 5, which asserts the
    // renderer signal and the deferred child signal each abort exactly once.
    it('R1-01: streaming threads the request AbortSignal into the initial-data ctx, and an abort observation cancels it', async () => {
      // Faithful AbortController: the suite's default mock has a no-op abort(); here abort() must flip
      // signal.aborted so we can prove the loader's signal actually cancels on disconnect (gate-review
      // "Additional Observations": presence alone is not enough).
      (globalThis as any).AbortController = vi.fn().mockImplementation(function () {
        const signal: any = { aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
        return {
          abort: vi.fn(() => {
            signal.aborted = true;
          }),
          signal,
        };
      });

      // Capture the req 'aborted' disconnect handler so we can fire it.
      let abortHandler: (() => void) | undefined;
      mockReq.raw.on = vi.fn((event: string, cb: any) => {
        if (event === 'aborted') abortHandler = cb;
      });

      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      // Capture the exact context the loader receives.
      let loaderCtx: any;
      vi.mocked(DataRoutes.fetchInitialData).mockImplementation(async (_attr, _params, _reg, ctx) => {
        loaderCtx = ctx;
        return { ok: true };
      });

      // Drive the initialData loader the way createSSRStore would (so fetchInitialData runs), but do
      // NOT fire 'finish' — that would unregister the 'aborted' handler before we can trigger it.
      const mockRenderStream = vi.fn((writable, callbacks, initialData) => {
        void (initialData as () => Promise<unknown>)();
        callbacks.onHead?.('<title>Stream</title>');
        writable.end();
        return { abort: vi.fn(), done: Promise.resolve() };
      });
      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

      // The CRITICAL INITIAL-DATA closure (`attr.data`), not an RFC 0007 deferred loader: it is
      // invoked BY THE RENDERER, so it only runs on CONSUMPTION. Deferred work remains eager and
      // starts in the handler, before the payload is returned.
      await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      // The loader received the signal (regression guard: dropping `ctx.signal = ac.signal` leaves it
      // undefined) and it is the SAME signal an abort observation cancels.
      expect(loaderCtx?.signal).toBeDefined();
      expect(loaderCtx.signal.aborted).toBe(false);
      abortHandler?.(); // simulated abort observation (the network event is spine cell 5)
      expect(loaderCtx.signal.aborted).toBe(true);
    });

    it('should handle streaming without hydration', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', hydrate: false, meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable, callbacks, _initialData, _location, bootstrapModules) => {
        expect(bootstrapModules).toBeUndefined();
        callbacks.onHead?.('<title>Stream</title>');

        writable.end();

        return { abort: vi.fn(), done: Promise.resolve() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      expect(mockRenderStream).toHaveBeenCalled();
    });

    it('should abort stream when request is aborted', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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
        return { abort: vi.fn(), done: Promise.resolve() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      abortCallback?.();
      expect(mockReq.raw.on).toHaveBeenCalledWith('aborted', expect.any(Function));
    });

    it('should handle reply close event', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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
        return { abort: vi.fn(), done: Promise.resolve() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      mockReply.raw.writableEnded = false;
      closeCallback?.();

      expect(mockReply.raw.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should handle benign socket errors in PassThrough', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

        return { abort: vi.fn(), done: Promise.resolve() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.error).not.toHaveBeenCalledWith('PassThrough error:', expect.any(Object));
    });

    it('should log non-benign socket errors in PassThrough', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable: any, callbacks: any) => {
        // The shell must be produced, otherwise the document waits on it forever and the auxiliary
        // error this test is about would never be reached.
        callbacks.onHead?.('<title>S</title>');
        writable.emit('error', new Error('Unknown error'));
        writable.end();
        return { abort: vi.fn(), done: Promise.resolve() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      // AUXILIARY inner-stream logging, kept distinct from response classification: the renderer
      // only runs on consumption, so the document must be driven for the error to be observed.
      await collectPartialDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Object), 'PassThrough error:');
    });

    // Gate finding 1: `onError` is the renderer's FATAL channel — the server must NOT reclassify
    // it as a benign disconnect by the shape of an app-controlled error. The only benign condition
    // is ACTUAL request-abort state.
    const setupStreamingRoute = () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
    };

    const disconnectShapedErrors: ReadonlyArray<readonly [string, unknown]> = [
      ['code EPIPE', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
      ['name AbortError', Object.assign(new Error('aborted by app'), { name: 'AbortError' })],
      ['exact "aborted" message', new Error('aborted')],
    ];

    for (const [name, err] of disconnectShapedErrors) {
      it(`gate finding 1: onError(${name}) while the request is LIVE enters the failure path, not benign`, async () => {
        setupStreamingRoute();

        const mockRenderStream = vi.fn((writable, callbacks) => {
          callbacks.onError?.(err); // request still live: abortedState is false
          return { abort: vi.fn(), done: Promise.resolve() };
        });
        mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

        // INVARIANT: `onError` is the renderer's FATAL channel. An application-controlled error that
        // merely RESEMBLES a socket error stays fatal - only genuine request-abort state makes it
        // benign - so this must reach the failure path. Proved by CONSUMING, because a renderer
        // failure only occurs once the document is consumed.
        const failure = await collectDocumentFailure(
          await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps),
        );

        expect(failure).toBeDefined();
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url }), 'Critical rendering error during stream');
        expect(mockLogger.warn).not.toHaveBeenCalledWith({}, 'Client disconnected before stream finished');
      });
    }

    it('logs an initial-data failure through the streaming response terminal once while still recording and tearing down', async () => {
      setupStreamingRoute();
      const failed = vi.fn();
      vi.mocked(Telemetry.createRequestContext).mockReturnValue({
        requestId: 'episode-1',
        logger: mockLogger,
        headers: { host: 'localhost' },
        recorder: { ...noopEpisodeRecorder, failed },
      } as any);
      const failure = new InitialDataFailure(AppError.internal('service unavailable'), { id: '42' } as any);
      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onError?.(failure);
        return { abort: vi.fn(), done: Promise.resolve() };
      });
      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

      // PRE-BYTE: the failure is raised before any shell byte, so consumption must REJECT -
      // that rejection is what lets Fastify answer with a real 500 (spine cell 2 owns the status).
      const rejection = await collectDocumentFailure(
        await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps),
      );

      expect(rejection).toBeDefined();

      expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ component: 'fetch-initial-data', params: { id: '42' } }), 'service unavailable');
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.anything(), 'Critical rendering error during stream');
      expect(failed).toHaveBeenCalledTimes(1);
      expect(abortControllers.some((controller) => controller.abort.mock.calls.length > 0)).toBe(true);
      // The real 500 is the spine's (cell 2); here the contract is the terminal being recorded once.
    });

    // RETAINED as a unit EVENT-ORDER test, renamed: a mocked `reply.raw` close event is an abort
    // OBSERVATION, not a network disconnect - the real network event is spine cell 5. What this
    // still protects, and the spine does not, is the CLASSIFICATION: a subsequent onError after an
    // abort observation is benign (warn), never the fatal channel.
    it('gate finding 1: onError after an abort OBSERVATION is benign, never fatal', async () => {
      setupStreamingRoute();

      // Capture the real disconnect channel (reply.raw 'close') so we can trigger a genuine abort.
      let closeHandler: (() => void) | undefined;
      mockReply.raw.on = vi.fn((event: string, cb: any) => {
        if (event === 'close') closeHandler = cb;
        return mockReply.raw;
      });
      mockReply.raw.writableEnded = false;

      const mockRenderStream = vi.fn((writable, callbacks) => {
        closeHandler?.(); // simulated abort observation → abortedState.aborted = true
        callbacks.onError?.(new Error('any subsequent render error'));
        return { abort: vi.fn(), done: Promise.resolve() };
      });
      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

      const { document } = await collectPartialDocument(
        await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps),
      );

      expect(mockLogger.warn).toHaveBeenCalledWith({}, 'Client disconnected before stream finished');
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url }), 'Critical rendering error during stream');
      expect(document).not.toContain('__INITIAL_DATA__');
    });

    // Recheck: the fatal onError callback must never throw on a HOSTILE unknown (a component can
    // legally throw an object whose `message` getter / `Symbol.toPrimitive` throws), otherwise the
    // response teardown is skipped and the request hangs.
    const hostileErrors: ReadonlyArray<readonly [string, () => unknown]> = [
      [
        'throwing message getter',
        () => {
          const o: Record<string, unknown> = {};
          Object.defineProperty(o, 'message', {
            get() {
              throw new Error('getter boom');
            },
          });
          return o;
        },
      ],
      [
        'throwing Symbol.toPrimitive',
        () => ({
          message: {
            [Symbol.toPrimitive]() {
              throw new Error('coercion boom');
            },
          },
        }),
      ],
    ];

    for (const [name, make] of hostileErrors) {
      it(`recheck: onError with a hostile error (${name}) never throws and still terminates the response`, async () => {
        setupStreamingRoute();

        const mockRenderStream = vi.fn((writable, callbacks) => {
          callbacks.onError?.(make()); // live request → fatal branch, with a hostile error
          return { abort: vi.fn(), done: Promise.resolve() };
        });
        mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

        // COLD-START DISTINCTION: the handler returns BEFORE the renderer runs, so asserting that
        // it resolves proves nothing here. The renderer - and therefore the hostile error - is only
        // exercised by CONSUMING the document, and the contract is that a hostile error cannot
        // prevent the failure reaching the client.
        const failure = await collectDocumentFailure(
          await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps),
        );

        // The document rejects through the proper failure path, and the hostile error did not
        // replace the renderer failure with a formatting crash.
        expect(failure).toBeInstanceOf(Error);
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url }), 'Critical rendering error during stream');
        // The real 500 is the spine's (`StreamingTransport.test.ts` cell 2): a fatal before the
        // first byte terminates rather than hanging.
      });
    }

    // RECOVERED INTENT: "after headers are sent" was the hijacked transport's way of saying AFTER
    // COMMITMENT. The boundary is now the first document byte YIELDED to Fastify, and the contract
    // is that a hostile error past it cannot upgrade into a fresh error response - the transfer
    // aborts with whatever was delivered.
    it('recheck: onError with a hostile error AFTER the first yielded byte aborts the transfer, no throw', async () => {
      setupStreamingRoute();

      const hostile: Record<string, unknown> = {};
      Object.defineProperty(hostile, 'message', {
        get() {
          throw new Error('getter boom');
        },
      });

      const mockRenderStream = vi.fn((writable: any, callbacks: any) => {
        callbacks.onHead?.('<title>S</title>'); // the shell: this IS the first document byte
        // The fatal must land AFTER that byte is yielded, or it is a pre-byte failure instead.
        setTimeout(() => callbacks.onError?.(hostile), 0);
        return { abort: vi.fn(), done: Promise.resolve() };
      });
      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

      const { document, error } = await collectPartialDocument(
        await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps),
      );

      // Bytes were delivered, then the document failed: a partial response, never a second one.
      expect(document).toContain('<title>S</title>');
      expect(error).toBeDefined();
      expect(document).not.toContain('__INITIAL_DATA__');
    });

    it('R0-04: streaming route with non-serializable (circular) final data terminates deterministically — no data script, no crash', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const circular: Record<string, unknown> = { name: 'x' };
      circular.self = circular;

      // Capture the 'finish' listener instead of invoking it synchronously, so we can fire it on a
      // LATER tick — matching the real EventEmitter timing (finish fires after handleRender returns,
      // outside the request try/catch). (The crash class itself is proven in InlineData.crash.test.ts.)
      let finishHandler: (() => void) | undefined;
      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onShellReady?.();
        callbacks.onAllReady?.(circular); // finalData is non-serializable
        writable.end();
        return { abort: vi.fn(), done: Promise.resolve() };
      });

      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      // BYTE BOUNDARY: the shell was yielded before the data script is assembled, so a
      // serialization failure here is POST-byte. It must abort the partial transfer - never
      // upgrade into a fresh error response - and never throw out of the terminal listener.
      const { document, error } = await collectPartialDocument(
        await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps),
      );

      expect(document).toContain('<html><head>');
      expect(document).not.toContain('__INITIAL_DATA__');
      expect(error).toBeDefined();
      expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ url: mockReq.url }), 'Failed to serialize streaming initial data');
    });

    it('R0-04: SSR route with non-serializable (circular) data → 500 via the request try/catch', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      const circular: Record<string, unknown> = { name: 'x' };
      circular.self = circular;

      mockMaps.renderModules.set('/test/client', {
        renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '<div/>' }),
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue(circular as any);

      // On the SSR path the serialization failure throws an AppError.internal into the request
      // try/catch → 500 machinery (the app HTML is never sent).
      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow(
        'Failed to serialize initial data',
      );
      expect(mockReply.send).not.toHaveBeenCalled();
    });
    // RETIRED: this asserted only that an already-aborted response emits no data script, which is
    // proven observably by `test/StreamingTransport.test.ts` cell 5d - "late renderer completion
    // after cancellation cannot emit initial-data bytes" - on a real listener. Reproducing it here
    // would need a more elaborate socket mock to duplicate evidence that already exists.

    it('should handle finish event when already ended', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      mockReply.raw.writableEnded = true;

      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Test</title>');

        writable.end();

        return { abort: vi.fn(), done: Promise.resolve() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockReply.raw.end).not.toHaveBeenCalled();
    });

    it('should throw error when renderStream is missing', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();

      expect(AppError.internal).toHaveBeenCalledWith('renderStream function not found in module', undefined, {
        clientRoot: '/test/client',
        availableFunctions: [],
      });
    });

    it('should escape JSON in streaming initial data', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onAllReady?.({ html: '<script>alert("xss")</script>' });

        writable.end();

        return { abort: vi.fn(), done: Promise.resolve() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const document = await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      expect(document).toContain('\\u003c');
    });

    it('should dispatch taujs:data-ready event in streaming', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onAllReady?.({ data: 'test' });

        writable.end();

        return { abort: vi.fn(), done: Promise.resolve() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const document = await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      expect(document).toContain("window.dispatchEvent(new Event('taujs:data-ready')");
    });

    it('benign teardown: a failing inner-stream disposal after an abort observation cannot prevent settlement', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      // OWNERSHIP: raw-response destruction is Fastify's now. What τjs still owns is disposal of the
      // INNER stream, and the contract is that a defensive failure there cannot stop settlement.
      // Benign-ness is decided by GENUINE abort state, never by error shape.
      const aborted = vi.fn();
      const failed = vi.fn();

      vi.mocked(Telemetry.createRequestContext).mockReturnValue({
        requestId: 'benign-teardown',
        logger: mockLogger,
        headers: { host: 'localhost' },
        recorder: { ...noopEpisodeRecorder, aborted, failed },
      } as any);

      let closeHandler: (() => void) | undefined;
      mockReply.raw.on = vi.fn((event: string, cb: any) => {
        if (event === 'close') closeHandler = cb;
        return mockReply.raw;
      });
      mockReply.raw.writableFinished = false;

      const mockRenderStream = vi.fn((writable: any, callbacks: any) => {
        writable.destroy = () => {
          throw new Error('inner disposal failed');
        };
        closeHandler?.(); // simulated abort observation → abortedState.aborted = true
        callbacks.onError?.(new Error('subsequent render error'));

        return { abort: vi.fn(), done: Promise.resolve() };
      });

      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

      // The document is COLD, so the renderer only runs when it is consumed. Merely resolving the
      // handler would exercise none of the above: the throwing disposal, the close observation and
      // the subsequent error all live inside `renderStream`, which never runs unless the payload is
      // pulled. Consuming it is what makes this cell test its own premise.
      const payload = await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      await collectPartialDocument(payload);

      expect(mockRenderStream).toHaveBeenCalledTimes(1);
      // The contract: a defensive failure in inner-stream disposal does not become the response's
      // problem. The abort observation owns the terminal, and the app error that followed it is
      // NOT promoted to a second classification.
      expect(aborted).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
    });

    it('critical teardown: a throwing AbortController cannot prevent the coordinator finalising', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const OriginalAbortController = globalThis.AbortController;
      class ThrowingAbortController extends OriginalAbortController {
        override abort(): void {
          throw new Error('abort fail');
        }
      }
      (globalThis as any).AbortController = ThrowingAbortController;

      try {
        const mockRenderStream = vi.fn((_writable: any, callbacks: any) => {
          callbacks.onError?.(new Error('fatal'));

          return { abort: vi.fn(), done: Promise.resolve() };
        });
        mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

        // AbortController signalling is τjs-owned, and a defensive failure there must not stop the
        // response being settled: the document still fails rather than hanging.
        const failure = await collectDocumentFailure(
          await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps),
        );

        expect(failure).toBeDefined();
      } finally {
        (globalThis as any).AbortController = OriginalAbortController;
      }
    });
    // RETIRED: asserted raw-response destruction, which Fastify owns now.
    // RETIRED: asserted the raw 500 write; the real 500 is spine cell 2.
    // RETIRED: asserted head commitment on the raw response; the commitment boundary is the first yielded byte and lives in the spine.

    it('streaming initialDataScript includes nonce attribute when cspNonce is present', async () => {
      (mockReq as any).cspNonce = 'nonce-abc-123';

      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({ foo: 'bar' });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onAllReady?.({ hello: 'world' });
        writable.end();
        return { abort: vi.fn(), done: Promise.resolve() };
      });

      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

      const document = await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      expect(document).toContain('nonce="nonce-abc-123"');
    });

    it('streaming initialDataScript omits nonce attribute when cspNonce is empty', async () => {
      (mockReq as any).cspNonce = '';

      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({ foo: 'bar' });

      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Stream</title>');
        callbacks.onAllReady?.({ ok: true });
        writable.end();
        return { abort: vi.fn(), done: Promise.resolve() };
      });

      mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

      const document = await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      expect(document).toContain('<script');
      expect(document).not.toContain('nonce=');
    });

    it('dev + streaming: does not inject nonce into devHead when nonce is empty', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);
      (mockReq as any).cspNonce = '';

      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;

      vi.mocked(Templates.requireTemplate).mockReturnValue('<html><head><!--ssr-head--></head><body><!--ssr-html--></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '',
        beforeBody: '</head><body>',
        afterBody: '</body></html>',
      });

      mockViteDevServer.transformIndexHtml.mockResolvedValue('<html><head><script type="module" src="/@vite/client"></script></head><body></body></html>');
      vi.mocked(Templates.extractHeadInner).mockReturnValue('<script type="module" src="/@vite/client"></script>');

      mockViteDevServer.ssrLoadModule.mockResolvedValue(
        brandedRenderModule('test', {
          renderStream: vi.fn((writable: any, callbacks: any) => {
            callbacks.onHead?.('<title>X</title>');
            writable.end();
            return { abort: vi.fn(), done: Promise.resolve() };
          }),
        }),
      );

      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      // The nonce-bearing (or nonce-free) DOCUMENT is the contract here; wire-level CSP evidence
      // stays with the real-listener tests.
      const document = await collectDocument(
        await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, {
          viteDevServer: mockViteDevServer,
        }),
      );

      expect(document).toContain('/@vite/client');
      expect(document).not.toContain('nonce=');
    });

    it('dev + streaming: does not inject nonce into devHead when nonce is empty', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);
      (mockReq as any).cspNonce = '';

      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;

      vi.mocked(Templates.requireTemplate).mockReturnValue('<html><head><!--ssr-head--></head><body><!--ssr-html--></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '',
        beforeBody: '</head><body>',
        afterBody: '</body></html>',
      });

      mockViteDevServer.transformIndexHtml.mockResolvedValue('<html><head><script type="module" src="/@vite/client"></script></head><body></body></html>');
      vi.mocked(Templates.extractHeadInner).mockReturnValue('<script type="module" src="/@vite/client"></script>');

      mockViteDevServer.ssrLoadModule.mockResolvedValue(
        brandedRenderModule('test', {
          renderStream: vi.fn((writable: any, callbacks: any) => {
            callbacks.onHead?.('<title>X</title>');
            writable.end();
            return { abort: vi.fn(), done: Promise.resolve() };
          }),
        }),
      );

      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      // The nonce-bearing (or nonce-free) DOCUMENT is the contract here; wire-level CSP evidence
      // stays with the real-listener tests.
      const document = await collectDocument(
        await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, {
          viteDevServer: mockViteDevServer,
        }),
      );

      expect(document).toContain('/@vite/client');
      expect(document).not.toContain('nonce=');
    });
    // RETIRED by MUTATION CHECK, not by argument: removing the `if (!abortedState.aborted)` guard
    // changed NO observable outcome - emitted bytes, deferred settlement, episode outcome and
    // retained lifecycle state were all identical, because an abort irreversibly destroys the
    // document and the coordinator is latched. This test pinned the private `finalData` variable
    // through an unreachable mock sequence.
    //
    // The behaviour it was reaching for IS protected, at the layer where it is observable:
    // `test/StreamingTransport.test.ts` cell 5d - "late renderer completion after cancellation
    // cannot emit initial-data bytes" - on a real listener, with a renderer that completes 250ms
    // after the client has gone.

    // RETIRED (header-object assertions): the streamed head was a τjs-assembled object; Fastify
    // owns it now, so there is no object to inspect. Their contracts are covered where they are
    // externally observable:
    //   - an ACTIVE CSP reaches the wire exactly once, with existing reply headers surviving:
    //     `test/StreamingHeadNormalisation.test.ts` (real listener, `rawHeaders`);
    //   - no header key is emitted twice at all: `test/StreamingTransport.test.ts` cell 1.
  });

  describe('Development mode', () => {
    beforeEach(() => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);
    });

    it('should load module from Vite in dev mode', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html><head></head><body></body></html>');
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

      mockViteDevServer.ssrLoadModule.mockResolvedValue(brandedRenderModule('test', mockRenderModule));
      mockViteDevServer.transformIndexHtml.mockResolvedValue('<html>transformed</html>');

      vi.mocked(Templates.collectStyle).mockResolvedValue('.dev { color: red; }');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer });

      expect(mockViteDevServer.ssrLoadModule).toHaveBeenCalledWith('/test/client/entry-server.tsx');
      expect(mockViteDevServer.transformIndexHtml).toHaveBeenCalled();
      expect(Templates.collectStyle).toHaveBeenCalled();
    });

    it('should strip Vite client script in dev mode', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;

      const templateWithVite = '<html><head><script type="module" src="/@vite/client"></script></head><body></body></html>';
      vi.mocked(Templates.requireTemplate).mockReturnValue(templateWithVite);
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

      mockViteDevServer.ssrLoadModule.mockResolvedValue(brandedRenderModule('test', mockRenderModule));
      mockViteDevServer.transformIndexHtml.mockImplementation((_url: any, html: any) => {
        expect(html).not.toContain('/@vite/client');
        return Promise.resolve(html);
      });

      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer });

      expect(mockViteDevServer.transformIndexHtml).toHaveBeenCalled();
    });

    it('keeps an author style tag through dev SSR (the strip must not remove it)', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;

      // Real template plumbing, so the assertion is on the response that is SENT, not on an
      // intermediate string: a mocked rebuildTemplate would hide a strip that happened later.
      const actualTemplates = await vi.importActual<typeof import('../Templates')>('../Templates');
      vi.mocked(Templates.processTemplate).mockImplementation(actualTemplates.processTemplate);
      vi.mocked(Templates.rebuildTemplate).mockImplementation(actualTemplates.rebuildTemplate);

      const templateWithAuthorStyle = '<html><head><style type="text/css">.author{}</style><!--ssr-head--></head><body><!--ssr-html--></body></html>';
      vi.mocked(Templates.requireTemplate).mockReturnValue(templateWithAuthorStyle);

      const mockRenderModule = {
        renderSSR: vi.fn().mockResolvedValue({
          headContent: '<title>Dev</title>',
          appHtml: '<div>Dev</div>',
        }),
      };

      mockViteDevServer.ssrLoadModule.mockResolvedValue(brandedRenderModule('test', mockRenderModule));

      let seenByTransform = '';
      mockViteDevServer.transformIndexHtml.mockImplementation((_url: any, html: string) => {
        seenByTransform = html;
        return Promise.resolve(html);
      });

      vi.mocked(Templates.collectStyle).mockResolvedValue('.dev{}');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer });

      expect(seenByTransform).toContain('.author{}');
      const sent = mockReply.send.mock.calls[0][0] as string;
      expect(sent).toContain('.author{}');
      expect(sent).toContain('.dev{}');
      expect(sent).toContain('<div>Dev</div>');
    });

    it('should handle dev mode asset loading errors', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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
        handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer }),
      ).rejects.toThrow();

      expect(AppError.internal).toHaveBeenCalledWith('Failed to load dev assets', loadError, {
        clientRoot: '/test/client',
        entryServer: 'entry-server.tsx',
        url: expect.any(String),
      });
    });

    it('does not treat empty raw.url as an asset (covers url ?? "")', async () => {
      mockReq.raw.url = undefined;
      mockReq.url = '/';

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);
      expect(mockReply.callNotFound).not.toHaveBeenCalled();
    });

    it('injects collected styles with a nonce attribute in dev mode', async () => {
      (mockReq as any).cspNonce = 'stylenonce-777';

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      // include <head> so our <style> injection can be verified
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html><head></head><body></body></html>');
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

      mockViteDevServer.ssrLoadModule.mockResolvedValue(brandedRenderModule('test', mockRenderModule));
      vi.mocked(Templates.collectStyle).mockResolvedValue('.dev-style { display:block }');

      // Assert the <style> tag carries the nonce after collectStyle runs
      mockViteDevServer.transformIndexHtml.mockImplementation(async (_url: any, html: string) => {
        expect(html).toContain('<style type="text/css" nonce="stylenonce-777">.dev-style { display:block }</style>');
        return html;
      });

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>done</html>');

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer });
    });

    it('omits nonce on collected <style> when cspNonce is falsy in dev mode', async () => {
      // ensure dev
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);
      (mockReq as any).cspNonce = '';
      // falsy nonce triggers the ": ''" branch of the ternary

      const mockRoute = { route: { attr: { render: 'ssr' }, appId: 'test-app' }, params: {}, keys: [] } as any;
      mockSelectedRoute = mockRoute;

      // make sure </head> exists so replacement happens
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html><head></head><body></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mod = { renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '' }) };
      mockViteDevServer.ssrLoadModule.mockResolvedValue(brandedRenderModule('test', mod));

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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer });
    });

    it('dev + streaming: injects nonce into devHead scripts that lack nonce', async () => {
      // 1. Force dev mode
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

      // 2. Ensure nonce is truthy
      (mockReq as any).cspNonce = 'nonce-dev-123';

      // 3. Streaming route
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;

      // 4. Template + parts
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html><head><!--ssr-head--></head><body><!--ssr-html--></body></html>');

      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '',
        beforeBody: '</head><body>',
        afterBody: '</body></html>',
      });

      // 5. Vite stub returns a <script> WITHOUT nonce
      mockViteDevServer.transformIndexHtml.mockResolvedValue('<html><head><script type="module" src="/@vite/client"></script></head><body></body></html>');

      // 6. extractHeadInner returns raw script (this is what gets mutated)
      vi.mocked(Templates.extractHeadInner).mockReturnValue('<script type="module" src="/@vite/client"></script>');

      // 7. Minimal renderStream: emit head once, then finish
      const mockRenderStream = vi.fn((writable, callbacks) => {
        callbacks.onHead?.('<title>Dev Streaming</title>');
        writable.end();
        return { abort: vi.fn(), done: Promise.resolve() };
      });

      mockViteDevServer.ssrLoadModule.mockResolvedValue(brandedRenderModule('test', { renderStream: mockRenderStream }));

      vi.mocked(Templates.collectStyle).mockResolvedValue('');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      // 8. Execute
      const writtenHtml = await collectDocument(
        await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer }),
      );

      // 9. Assert: devHead script was nonce-patched

      expect(writtenHtml).toContain('<script nonce="nonce-dev-123" type="module" src="/@vite/client"></script>');
    });

    it('does not accumulate style blocks across successive dev renders with the same maps', async () => {
      const actualTemplates = await vi.importActual<typeof import('../Templates')>('../Templates');
      vi.mocked(Templates.requireTemplate).mockImplementation(actualTemplates.requireTemplate);
      vi.mocked(Templates.processTemplate).mockImplementation(actualTemplates.processTemplate);
      vi.mocked(Templates.rebuildTemplate).mockImplementation(actualTemplates.rebuildTemplate);

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;

      const mockRenderModule = { renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '<div>Dev</div>' }) };
      mockViteDevServer.ssrLoadModule.mockResolvedValue(brandedRenderModule('test', mockRenderModule));
      mockViteDevServer.transformIndexHtml.mockImplementation(async (_url: any, html: string) => html);
      vi.mocked(Templates.collectStyle).mockResolvedValue('.dev{}');
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

      const countStyleBlocks = (html: string) => html.match(/<style type="text\/css"[^>]*>/g)?.length ?? 0;

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer });
      const firstHtml = mockReply.send.mock.calls[0][0] as string;

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, { viteDevServer: mockViteDevServer });
      const secondHtml = mockReply.send.mock.calls[1][0] as string;

      expect(countStyleBlocks(firstHtml)).toBe(1);
      expect(countStyleBlocks(secondHtml)).toBe(1);
      expect(firstHtml).toContain('.dev{}');
      expect(secondHtml).toContain('.dev{}');
      expect(secondHtml.match(/\.dev\{\}/g)?.length).toBe(1);
    });
  });

  describe('Production mode', () => {
    it('should use preloaded render module in production', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockRenderModule.renderSSR).toHaveBeenCalled();
    });

    it('should throw error when render module not preloaded', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();
    });

    it('prod: keeps an author style tag and never calls the dev template strip', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;

      vi.mocked(Templates.requireTemplate).mockReturnValue('<html><head><style type="text/css">.author{}</style></head><body></body></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head><style type="text/css">.author{}</style>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });

      const mockRenderModule = { renderSSR: vi.fn().mockResolvedValue({ headContent: '', appHtml: '<div>Prod</div>' }) };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(Templates.rebuildTemplate).mockImplementation(
        (parts: any, headContent: string, bodyContent: string) =>
          `${parts.beforeHead}${headContent}${parts.afterHead}${parts.beforeBody}${bodyContent}${parts.afterBody}`,
      );

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      const html = mockReply.send.mock.calls[0][0] as string;
      expect(html).toContain('.author{}');
      expect(Templates.stripDevClient).not.toHaveBeenCalled();
    });
  });

  // ESC-3 response-path leg. InlineData.test.ts proves the serializer in isolation; these prove the
  // fix survives the REAL response path on BOTH render modes, by evaluating the exact
  // `window.__INITIAL_DATA__ = <js>` expression a browser would receive.
  describe('__proto__ is inert end-to-end through the response path (ESC-3)', () => {
    const PAYLOAD = { ['__proto__']: { polluted: 'YES' }, ok: 1, nested: { ['__proto__']: { deep: true } } };

    // The SSR script ends `= <js>;</script>`; the streaming one continues
    // `= <js>; window.dispatchEvent(...)</script>`. Stop at whichever terminator comes first so the
    // captured expression is exactly the serialized value.
    const evaluateEmitted = (script: string) => {
      const match = /window\.__INITIAL_DATA__ = ([\s\S]*?);(?: window\.dispatchEvent|<\/script>)/.exec(script);
      expect(match, `no __INITIAL_DATA__ assignment found in: ${script}`).toBeTruthy();
      return new Function(`return (${match![1]});`)() as Record<string, unknown>;
    };

    const assertInert = (value: Record<string, unknown>) => {
      expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
      expect(value['__proto__']).toEqual({ polluted: 'YES' });
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);

      const nested = value.nested as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(nested, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);

      // the GLOBAL prototype is never polluted, at any depth
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
      expect(({} as { deep?: unknown }).deep).toBeUndefined();
    };

    it('ssr: the emitted assignment round-trips __proto__ as an own property', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      mockMaps.renderModules.set('/test/client', {
        renderSSR: vi.fn().mockResolvedValue({ headContent: '<title>T</title>', appHtml: '<div>T</div>' }),
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue(PAYLOAD);
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>complete</html>');

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      // HandleRender passes the body (including the initial-data script) as rebuildTemplate's 3rd arg.
      const body = String(vi.mocked(Templates.rebuildTemplate).mock.calls.at(-1)?.[2] ?? '');
      assertInert(evaluateEmitted(body));
    });

    it('streaming: the emitted assignment round-trips __proto__ as an own property', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue(PAYLOAD);

      mockMaps.renderModules.set('/test/client', {
        renderStream: vi.fn((writable, callbacks) => {
          callbacks.onHead?.('<title>Stream</title>');
          callbacks.onAllReady?.(PAYLOAD);
          writable.end();
          return { abort: vi.fn(), done: Promise.resolve() };
        }),
      });

      const document = await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      expect(document).toContain('window.__INITIAL_DATA__');
      assertInert(evaluateEmitted(document));
    });
  });

  describe('Initial data handling', () => {
    it('should build initial data input successfully', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' }, 'test-app', { id: '123' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(DataRoutes.fetchInitialData).toHaveBeenCalledWith(
        mockRoute.route.attr,
        { id: '123' },
        mockServiceRegistry,
        expect.objectContaining({
          requestId: expect.any(String),
          headers: expect.objectContaining({ host: 'localhost' }),
          // R1-01: the request AbortSignal is threaded into the data context BEFORE the fetch, so
          // loaders can honour client disconnect / deadline. Regression guard for the SSR branch —
          // dropping `ctx.signal = ac.signal` (HandleRender.ts) leaves `signal: undefined`, which
          // `expect.anything()` rejects. (This suite mocks AbortController, so the signal is a mock
          // object, not an `AbortSignal` instance — assert presence, not type.)
          signal: expect.anything(),
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
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();

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
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);
    });

    it('should handle missing URL defaulting to root', async () => {
      mockReq.url = undefined;

      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);
    });
  });

  describe('Error handling', () => {
    it('should wrap non-AppError errors', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockImplementation(() => {
        throw new Error('Template error');
      });

      const mockError = new AppError('Wrapped error', 'infra');
      vi.mocked(AppError.internal).mockReturnValue(mockError);

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();

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
      mockSelectedRoute = mockRoute;

      const appError = new AppError('Original AppError', 'domain');
      vi.mocked(Templates.requireTemplate).mockImplementation(() => {
        throw appError;
      });

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toBe(appError);
    });

    describe('onError message extraction coverage', () => {
      const setupStreamAndFire = async (errValue: any) => {
        const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
        mockSelectedRoute = mockRoute;
        vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
        vi.mocked(Templates.processTemplate).mockReturnValue({
          beforeHead: '<html><head>',
          afterHead: '</head>',
          beforeBody: '<body>',
          afterBody: '</body></html>',
        });
        vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});

        // A TEST-SPECIFIC driver: this scenario is deliberately post-commit, so the shell is
        // yielded FIRST and the fatal arrives after it. `headersSent` is no longer the boundary -
        // the first yielded byte is - so the driver expresses that directly.
        const mockRenderStream = vi.fn((writable, callbacks) => {
          callbacks.onHead?.('<title>S</title>'); // the shell: the first document byte
          // The fatal must arrive AFTER the shell is actually yielded, otherwise it is a pre-byte
          // failure - the boundary is the byte reaching Fastify, not the callback ordering.
          setTimeout(() => callbacks.onError?.(errValue), 0);
          return { abort: vi.fn(), done: Promise.resolve() };
        });

        mockMaps.renderModules.set('/test/client', { renderStream: mockRenderStream });

        return collectPartialDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));
      };

      it.each([
        { label: 'Error with message', value: new Error('boom') },
        { label: 'plain string', value: 'aborted' },
        { label: 'object with message', value: { message: 'socket hang up' } },
        { label: 'number', value: 404 },
        { label: 'null', value: null },
        { label: 'undefined', value: undefined },
      ])('covers String((e as any)?.message ?? e ?? "") – $label', async ({ value }) => {
        const { document, error } = await setupStreamAndFire(value);

        // Whatever shape the error takes, formatting it must never crash the terminal: the partial
        // document is delivered, the transfer aborts, and something is logged.
        expect(document).toContain('<html><head>');
        expect(error).toBeDefined();
        expect(mockLogger.error.mock.calls.length + mockLogger.warn.mock.calls.length).toBeGreaterThan(0);
      });
    });

    it('includes routeOptions.url in wrapped error details', async () => {
      const mockRoute = createMockRouteMatch({ render: 'ssr' });
      mockSelectedRoute = mockRoute;

      mockReq.routeOptions = { url: '/internal-route' };

      vi.mocked(Templates.requireTemplate).mockImplementation(() => {
        throw new Error('boom in template');
      });

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow();

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

  describe('retained template load failure', () => {
    // These exercise the REAL Templates.requireTemplate (not the module-wide automock) so the
    // wiring under test is genuine: handleRender must pass maps.templates, maps.templateLoadFailures
    // and the resolved clientRoot through untouched, and its existing AppError-preserving catch
    // (untouched by this unit) must let the result through as-is rather than re-wrapping it.
    beforeEach(async () => {
      const actualTemplates = await vi.importActual<typeof import('../Templates')>('../Templates');
      vi.mocked(Templates.requireTemplate).mockImplementation(actualTemplates.requireTemplate);
      mockMaps.templates.delete('/test/client');
    });

    it('carries the retained boot-time failure as the AppError cause', async () => {
      const retained = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', path: '/root/dist/client/appA/index.html' });
      mockMaps.templateLoadFailures = new Map([['/test/client', retained]]);

      let caught: any;
      try {
        await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught.message).toBe('Template not found for clientRoot: /test/client');
      expect(caught.cause).toBe(retained);
    });

    it('leaves the cause undefined when nothing was retained', async () => {
      // No templateLoadFailures set at all - the optional map is simply absent.
      let caught: any;
      try {
        await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught.message).toBe('Template not found for clientRoot: /test/client');
      expect(caught.cause).toBeUndefined();
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

      await expect(
        handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps, { logger: customLogger as any }),
      ).rejects.toThrow('Render module not found');

      expect(createLogger).not.toHaveBeenCalled();
    });

    it('should create logger with dev settings in development', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

      mockReq.raw.url = '/asset.png';

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow(
        'Render module not found',
      );

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

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow(
        'Render module not found',
      );

      expect(createLogger).toHaveBeenCalledWith(
        expect.objectContaining({
          minLevel: 'info',
        }),
      );
    });

    it('logs HTTP socket error only when not benign', async () => {
      const mockRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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
        return { abort: vi.fn(), done: Promise.resolve() };
      });

      const mockRenderModule = { renderStream: mockRenderStream };
      mockMaps.renderModules.set('/test/client', mockRenderModule);

      const p = handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      handlers['error']?.forEach((cb) => cb(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })));
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.any(Object), 'HTTP socket error:');

      handlers['error']?.forEach((cb) => cb(new Error('kaboom')));
      expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), 'HTTP socket error:');

      // The streaming strategy resolves with the Fastify payload, not undefined.
      await expect(p).resolves.toBeDefined();
    });

    it('includeStack returns true only for "error" in production', async () => {
      vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(false);

      mockReq.raw.url = '/asset.png';
      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow(
        'Render module not found',
      );

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
      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow(
        'Render module not found',
      );

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
      mockSelectedRoute = mockRoute;
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
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

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockRenderModule.renderSSR).toHaveBeenCalled();
    });
  });
  describe('RFC 0004 (H1): head data resolution', () => {
    // resolveHeadData needs REAL AbortController/AbortSignal semantics (listeners + race); the
    // suite default is a no-op mock, so every test here restores the real one (the faithful-AC
    // precedent from the R1 gate coverage work).
    const useRealAbortController = () => {
      (globalThis as any).AbortController = OriginalAbortController;
    };

    const stubTemplate = () => {
      vi.mocked(Templates.requireTemplate).mockReturnValue('<html></html>');
      vi.mocked(Templates.processTemplate).mockReturnValue({
        beforeHead: '<html><head>',
        afterHead: '</head>',
        beforeBody: '<body>',
        afterBody: '</body></html>',
      } as any);
      vi.mocked(Templates.rebuildTemplate).mockReturnValue('<html>full</html>');
    };

    const ssrModule = () => {
      const renderSSR = vi.fn(async () => ({ headContent: '<title>t</title>', appHtml: '<div></div>' }));
      mockMaps.renderModules.set('/test/client', { renderSSR });
      return renderSSR;
    };

    /**
     * A renderer double that actually DRIVES the document: head, one body chunk, then `end()`.
     * The cold document is consumed with `for await`, so a double that never ends would hang the
     * consumer rather than assert anything.
     */
    const streamModule = () => {
      const renderStream = vi.fn((writable: any, callbacks: any) => {
        callbacks?.onHead?.('<title>S</title>');
        writable?.write?.('<main>app</main>');
        callbacks?.onAllReady?.({});
        writable?.end?.();

        return { abort: vi.fn(), done: Promise.resolve() };
      });
      mockMaps.renderModules.set('/test/client', { renderStream });
      return renderStream;
    };

    const firedAbortedHandler = () => {
      const call = (mockReq.raw.on as Mock).mock.calls.find((c: any[]) => c[0] === 'aborted');
      expect(call).toBeDefined();
      call![1]();
    };

    it('ssr: resolved head data reaches renderSSR opts.headData', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'ssr', head: { data: async () => ({}) } });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({ body: 1 });
      vi.mocked(DataRoutes.fetchHeadData).mockResolvedValue({ ogTitle: 'X' });
      const renderSSR = ssrModule();

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(renderSSR).toHaveBeenCalledWith({ body: 1 }, '/test-path', undefined, expect.anything(), expect.objectContaining({ headData: { ogTitle: 'X' } }));
    });

    it('ssr: no attr.head -> fetchHeadData is never called and no headData key exists (byte-identical guard)', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'ssr' });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      const renderSSR = ssrModule();

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(DataRoutes.fetchHeadData).not.toHaveBeenCalled();
      expect(Object.hasOwn((renderSSR as Mock).mock.calls[0]![4], 'headData')).toBe(false);
    });

    it('ssr: deadline expiry degrades to undefined with an advisory warn (Policy ii)', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'ssr', head: { data: async () => ({}), timeoutMs: 20 } });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(DataRoutes.fetchHeadData).mockImplementation(() => new Promise(() => {}));
      const renderSSR = ssrModule();

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 20, optional: false }),
        'Head data degraded; rendering with headData undefined',
      );
      expect(Object.hasOwn((renderSSR as Mock).mock.calls[0]![4], 'headData')).toBe(false);
    });

    it('ssr: a non-optional head rejection fails the request through the existing error path', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'ssr', head: { data: async () => ({}) } });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(DataRoutes.fetchHeadData).mockRejectedValue(new Error('head boom'));
      const renderSSR = ssrModule();

      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).rejects.toThrow(
        /handleRender failed/,
      );
      expect(renderSSR).not.toHaveBeenCalled();
    });

    it('ssr: head.optional degrades an ordinary rejection instead of failing', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'ssr', head: { data: async () => ({}), optional: true } });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(DataRoutes.fetchHeadData).mockRejectedValue(new Error('flaky head service'));
      const renderSSR = ssrModule();

      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ optional: true, reason: 'flaky head service' }),
        'Head data degraded; rendering with headData undefined',
      );
      expect(Object.hasOwn((renderSSR as Mock).mock.calls[0]![4], 'headData')).toBe(false);
    });

    it('ssr: caller abort during the head fetch skips the render (never proceeds degraded)', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'ssr', head: { data: async () => ({}) } });
      vi.mocked(DataRoutes.fetchInitialData).mockResolvedValue({});
      vi.mocked(DataRoutes.fetchHeadData).mockImplementation(() => new Promise(() => {}));
      const renderSSR = ssrModule();

      const p = handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);
      await new Promise((r) => setTimeout(r, 10));
      firedAbortedHandler();
      await p;

      expect(renderSSR).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith({ url: '/test-path' }, 'SSR skipped; client disconnected during head data');
    });

    it('streaming: resolved head data reaches renderStream opts', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'streaming', meta: {}, head: { data: async () => ({}) } });
      vi.mocked(DataRoutes.fetchHeadData).mockResolvedValue({ t: 1 });
      const renderStream = streamModule();

      await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      expect(renderStream).toHaveBeenCalledTimes(1);
      const opts = (renderStream as Mock).mock.calls[0]![7];
      expect(opts).toEqual(expect.objectContaining({ headData: { t: 1 } }));
    });

    // A non-optional head rejection carries TWO contracts, and conflating them was what the old
    // single test did. They are observed at different points, so they are two tests.
    it('streaming, head rejection [internal settlement]: the renderer never starts and the failure is logged once', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'streaming', meta: {}, head: { data: async () => ({}) } });
      vi.mocked(DataRoutes.fetchHeadData).mockRejectedValue(new Error('head boom'));
      const renderStream = streamModule();

      // Observed at point 1 - the handler has created a payload nobody has consumed. Deliberately
      // NOT consumed: a renderer that never starts is precisely what this asserts.
      await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);

      expect(renderStream).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(expect.anything(), 'Head data failed; terminating streaming request');
    });

    it('streaming, head rejection [external delivery]: consuming the document REJECTS, so Fastify can answer', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'streaming', meta: {}, head: { data: async () => ({}) } });
      vi.mocked(DataRoutes.fetchHeadData).mockRejectedValue(new Error('head boom'));
      streamModule();

      // Observed at point 4. The document must FAIL BEFORE ITS FIRST BYTE - that rejection is what
      // lets Fastify's error path produce a real 500 instead of a truncated 200. The HTTP status
      // itself belongs to the spine (`StreamingTransport.test.ts`, cell 2), not here.
      const failure = await collectDocumentFailure(
        await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps),
      );

      expect(failure).toBeInstanceOf(Error);
    });

    it('streaming: deadline expiry degrades to an ABSENT headData key with an advisory warn (Policy ii)', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'streaming', meta: {}, head: { data: async () => ({}), timeoutMs: 20 } });
      vi.mocked(DataRoutes.fetchHeadData).mockImplementation(() => new Promise(() => {}));
      const renderStream = streamModule();

      await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 20, optional: false }),
        'Head data degraded; rendering with headData undefined',
      );
      expect(renderStream).toHaveBeenCalledTimes(1);
      expect(Object.hasOwn((renderStream as Mock).mock.calls[0]![7], 'headData')).toBe(false);
    });

    it('streaming: head.optional degrades an ordinary rejection and the stream still starts', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'streaming', meta: {}, head: { data: async () => ({}), optional: true } });
      vi.mocked(DataRoutes.fetchHeadData).mockRejectedValue(new Error('flaky head service'));
      const renderStream = streamModule();

      await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ optional: true, reason: 'flaky head service' }),
        'Head data degraded; rendering with headData undefined',
      );
      expect(renderStream).toHaveBeenCalledTimes(1);
      expect(Object.hasOwn((renderStream as Mock).mock.calls[0]![7], 'headData')).toBe(false);
      expect(mockReply.raw.writeHead).not.toHaveBeenCalledWith(500, expect.anything());
    });

    it('streaming: no attr.head -> fetchHeadData never called and no headData key (byte-identical parity)', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'streaming', meta: {} });
      const renderStream = streamModule();

      await collectDocument(await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps));

      expect(DataRoutes.fetchHeadData).not.toHaveBeenCalled();
      expect(renderStream).toHaveBeenCalledTimes(1);
      expect(Object.hasOwn((renderStream as Mock).mock.calls[0]![7], 'headData')).toBe(false);
    });

    // RECOVERED INTENT: the old title said "hijacked-socket teardown", but the contract was BELTED
    // TELEMETRY - a hostile logger must not prevent the response being settled. That contract
    // survives the transport change; only its observation point moved.
    it('streaming, hostile logger [internal settlement]: telemetry cannot prevent settlement or start the renderer', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'streaming', meta: {}, head: { data: async () => ({}) } });
      vi.mocked(DataRoutes.fetchHeadData).mockRejectedValue(new Error('head boom'));
      mockLogger.error.mockImplementation(() => {
        throw new Error('hostile logger');
      });
      const renderStream = streamModule();

      // WHY handler settlement is meaningful HERE and not vacuous: this is a HEAD-RESOLUTION
      // logger. Head data is awaited inside the handler, BEFORE the payload is returned, so the
      // throwing logger is genuinely exercised on this path. Under the cold lifecycle a RENDERER
      // fatal is different - the handler returns before the renderer runs - so a hostile logger on
      // that path must be proved through consumption instead (see the onError cluster).
      await expect(handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps)).resolves.toBeDefined();
      expect(mockLogger.error).toHaveBeenCalled();
      expect(renderStream).not.toHaveBeenCalled();
    });

    it('streaming, hostile logger [external delivery]: the document still rejects, so the response is still answered', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'streaming', meta: {}, head: { data: async () => ({}) } });
      vi.mocked(DataRoutes.fetchHeadData).mockRejectedValue(new Error('head boom'));
      mockLogger.error.mockImplementation(() => {
        throw new Error('hostile logger');
      });
      streamModule();

      const failure = await collectDocumentFailure(
        await handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps),
      );

      expect(failure).toBeInstanceOf(Error);
    });

    // RECOVERED INTENT: the old title said the socket was destroyed, but the contract was that a
    // caller who leaves mid-head-fetch NEVER causes rendering work. Destroying a socket was the old
    // transport's way of settling; the response is Fastify's to tear down now.
    it('streaming, caller abort during the head fetch: the renderer never starts', async () => {
      useRealAbortController();
      stubTemplate();
      mockSelectedRoute = createMockRouteMatch({ render: 'streaming', meta: {}, head: { data: async () => ({}) } });
      vi.mocked(DataRoutes.fetchHeadData).mockImplementation(() => new Promise(() => {}));
      const renderStream = streamModule();

      // Point 1 only. The payload is deliberately NOT consumed: an abort before consumption is
      // exactly the state under test, and the client's disconnect terminal is the spine's (cell 5).
      const p = handleRender(mockReq, mockReply, mockSelectedRoute, mockProcessedConfigs, mockServiceRegistry, mockMaps);
      await new Promise((r) => setTimeout(r, 10));
      firedAbortedHandler();
      await p;

      expect(renderStream).not.toHaveBeenCalled();
    });
  });
});
