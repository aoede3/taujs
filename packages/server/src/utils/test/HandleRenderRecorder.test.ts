// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createDevIntrospection } from '../../core/introspection/DevIntrospection';
import { createSafeRecorder } from '../../core/introspection/TraceRecorder';
import { handleRender } from '../HandleRender';
import { handleNotFound } from '../HandleNotFound';

import type { TraceRecorder } from '../../core/introspection/TraceRecorder';

vi.mock('../../core/routes/DataRoutes', () => ({
  matchRoute: vi.fn(),
  fetchInitialData: vi.fn(async () => ({ product: { id: '42' } })),
}));

import { matchRoute } from '../../core/routes/DataRoutes';

const T = 'trace-render-1';

const mkLogger = (): any => {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebugEnabled: vi.fn(() => false) };
  l.child = vi.fn(() => l);
  return l;
};

const mkReq = (url: string, recorder?: TraceRecorder, server?: unknown): any => {
  const raw = new EventEmitter() as any;
  raw.url = url;
  return {
    url,
    method: 'GET',
    headers: { host: 'localhost' },
    raw,
    server,
    taujsRequestContext: { traceId: T, logger: mkLogger(), headers: {}, recorder },
  };
};

const mkReply = (): any => {
  const raw = new PassThrough() as any;
  raw.writeHead = vi.fn();
  raw.headersSent = false;
  const reply: any = {
    raw,
    sent: [] as unknown[],
    header: vi.fn(() => reply),
    status: vi.fn(() => reply),
    type: vi.fn(() => reply),
    getHeaders: vi.fn(() => ({})),
    getHeader: vi.fn(() => undefined),
    hijack: vi.fn(),
    callNotFound: vi.fn(),
    send: vi.fn((payload: unknown) => {
      reply.sent.push(payload);
      return reply;
    }),
  };
  return reply;
};

const ssrRoute = {
  route: { path: '/product/:id', appId: 'storefront', attr: { render: 'ssr' as const } },
  params: { id: '42' },
};

const streamingRoute = {
  route: { path: '/live', appId: 'storefront', attr: { render: 'streaming' as const, meta: {} } },
  params: {},
};

const maps = (renderModule: any): any => ({
  bootstrapModules: new Map([['/root', '/bootstrap.js']]),
  cssLinks: new Map(),
  manifests: new Map(),
  preloadLinks: new Map(),
  renderModules: new Map([['/root', renderModule]]),
  ssrManifests: new Map(),
  templates: new Map([['/root', '<html><head><!--ssr-head--></head><body><main><!--ssr-html--></main></body></html>']]),
});

const configs = [{ appId: 'storefront', clientRoot: '/root', entryServer: 'entry-server' }] as any;

const renderSSRModule = {
  renderSSR: vi.fn(async () => ({ headContent: '<title>p</title>', appHtml: '<div>app</div>' })),
};

beforeEach(() => {
  vi.mocked(matchRoute).mockReset();
  renderSSRModule.renderSSR.mockClear();
});

const runSSR = async (recorder?: TraceRecorder) => {
  vi.mocked(matchRoute).mockReturnValue(ssrRoute as any);
  const req = mkReq('/product/42', recorder);
  const reply = mkReply();
  await handleRender(req, reply, [] as any, configs, {} as any, maps(renderSSRModule), { logger: mkLogger() });
  return reply;
};

describe('handleRender recorder events (P0B-02 hook sites)', () => {
  it('SSR happy path: routeMatched → dataFetch → sent(ssr, 200)', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ traceId: T, url: '/product/42?ref=mail', method: 'GET' });

    await runSSR(dev.recorder);

    const [trace] = dev.getTraces();
    expect(trace).toMatchObject({
      traceId: T,
      route: '/product/:id',
      appId: 'storefront',
      mode: 'ssr',
      outcome: 'complete',
      status: 200,
      url: { pathname: '/product/42', queryKeys: ['ref'], queryValuesRedacted: true },
    });
    expect(trace!.timeline.matched).toBeTypeOf('number');
    expect(trace!.timeline.dataEnd).toBeTypeOf('number');
  });

  it('SSR render failure: outcome failed with the error message', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ traceId: T, url: '/product/42', method: 'GET' });
    vi.mocked(matchRoute).mockReturnValue(ssrRoute as any);
    const failingModule = { renderSSR: vi.fn(async () => Promise.reject(new Error('render exploded'))) };
    const req = mkReq('/product/42', dev.recorder);
    const reply = mkReply();

    await expect(handleRender(req, reply, [] as any, configs, {} as any, maps(failingModule), { logger: mkLogger() })).rejects.toThrow();

    const [trace] = dev.getTraces();
    expect(trace!.outcome).toBe('failed');
    expect(trace!.error!.message).toContain('render exploded');
  });

  it('streaming: streamPhases land and the finish handler emits sent(streaming)', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ traceId: T, url: '/live', method: 'GET' });
    vi.mocked(matchRoute).mockReturnValue(streamingRoute as any);

    const streamingModule = {
      renderStream: vi.fn((writable: PassThrough, cb: any, initialDataInput: () => Promise<unknown>) => {
        cb.onHead('<title>s</title>');
        cb.onShellReady();
        void initialDataInput().then((data) => {
          cb.onAllReady(data);
          writable.end();
        });
        return { abort: vi.fn(), done: Promise.resolve() };
      }),
    };

    const req = mkReq('/live', dev.recorder);
    const reply = mkReply();
    await handleRender(req, reply, [] as any, configs, {} as any, maps(streamingModule), { logger: mkLogger() });
    await vi.waitFor(() => {
      expect(dev.getTraces()).toHaveLength(1);
    });

    const [trace] = dev.getTraces();
    expect(trace).toMatchObject({ mode: 'streaming', outcome: 'complete', status: 200 });
    expect(trace!.timeline.head).toBeTypeOf('number');
    expect(trace!.timeline.shellReady).toBeTypeOf('number');
    expect(trace!.timeline.allReady).toBeTypeOf('number');
    expect(trace!.timeline.dataStart).toBeTypeOf('number');
  });

  it('fallthrough: handleNotFound emits sent(fallthrough) on the hoisted context', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ traceId: T, url: '/spa/deep/link', method: 'GET' });

    const req = mkReq('/spa/deep/link', dev.recorder);
    const reply = mkReply();
    await handleNotFound(
      req,
      reply,
      configs,
      { cssLinks: new Map(), bootstrapModules: new Map(), templates: maps(renderSSRModule).templates },
      { logger: mkLogger() },
    );

    const [trace] = dev.getTraces();
    expect(trace).toMatchObject({ route: null, mode: 'fallthrough', outcome: 'complete', status: 200 });
  });
});

describe('dev stamp injection (P0B-04, spec 03 §7)', () => {
  const devServer = { taujsIntrospection: { token: 'boot-token-abc' } };

  it('SSR HTML carries the stamp + hook + beacon script when the dev decoration exists', async () => {
    vi.mocked(matchRoute).mockReturnValue(ssrRoute as any);
    const req = mkReq('/product/42', undefined, devServer);
    const reply = mkReply();

    await handleRender(req, reply, [] as any, configs, {} as any, maps(renderSSRModule), { logger: mkLogger() });

    const html = String(reply.sent[0]);
    expect(html).toContain(`window.__TAUJS_TRACE_ID__="${T}"`);
    expect(html).toContain('window.__TAUJS_DEV_TOKEN__="boot-token-abc"');
    expect(html).toContain('__TAUJS_DEVTOOLS_HOOK__');
    expect(html).toContain('/__taujs/beacon');
  });

  it('SSR HTML carries no stamp without the decoration (prod shape)', async () => {
    const reply = await runSSR(undefined);

    const html = String(reply.sent[0]);
    expect(html).not.toContain('__TAUJS_TRACE_ID__');
    expect(html).not.toContain('__taujs');
  });

  it('streaming head write carries the stamp when the decoration exists', async () => {
    vi.mocked(matchRoute).mockReturnValue(streamingRoute as any);
    const streamingModule = {
      renderStream: vi.fn((writable: PassThrough, cb: any, initialDataInput: () => Promise<unknown>) => {
        cb.onHead('<title>s</title>');
        void initialDataInput().then((data) => {
          cb.onAllReady(data);
          writable.end();
        });
        return { abort: vi.fn(), done: Promise.resolve() };
      }),
    };
    const req = mkReq('/live', undefined, devServer);
    const reply = mkReply();
    const writes: string[] = [];
    const origWrite = reply.raw.write.bind(reply.raw);
    reply.raw.write = (chunk: unknown) => {
      writes.push(String(chunk));
      return origWrite(chunk);
    };

    await handleRender(req, reply, [] as any, configs, {} as any, maps(streamingModule), { logger: mkLogger() });
    await vi.waitFor(() => {
      expect(writes.join('')).toContain('__TAUJS_TRACE_ID__');
    });

    expect(writes[0]).toContain(`window.__TAUJS_TRACE_ID__="${T}"`);

    // Regression: the stamp must sit in <head>, never inside the app container. A <script>
    // preceding the streamed app HTML inside #root is a Vue hydration node mismatch — Vue
    // re-renders the whole app as a duplicate sibling (React skips unexpected scripts).
    const firstWrite = writes[0]!;
    expect(firstWrite.indexOf('__TAUJS_TRACE_ID__')).toBeLessThan(firstWrite.indexOf('</head>'));
    expect(firstWrite.endsWith('<main>')).toBe(true);
  });

  it('the fallthrough shell gets its own stamp', async () => {
    const req = mkReq('/spa/deep', undefined, devServer);
    const reply = mkReply();

    await handleNotFound(
      req,
      reply,
      configs,
      { cssLinks: new Map(), bootstrapModules: new Map(), templates: maps(renderSSRModule).templates },
      { logger: mkLogger() },
    );

    const html = String(reply.sent[0]);
    expect(html).toContain(`window.__TAUJS_TRACE_ID__="${T}"`);
    expect(html).toContain('boot-token-abc');
  });

  it('the fallthrough shell carries no stamp without the decoration', async () => {
    const req = mkReq('/spa/deep', undefined, undefined);
    const reply = mkReply();

    await handleNotFound(
      req,
      reply,
      configs,
      { cssLinks: new Map(), bootstrapModules: new Map(), templates: maps(renderSSRModule).templates },
      { logger: mkLogger() },
    );

    expect(String(reply.sent[0])).not.toContain('__TAUJS');
  });
});

describe('throwing-recorder isolation through the real render path', () => {
  it('responses are byte-identical with a hostile recorder attached', async () => {
    const hostile = createSafeRecorder({
      requestStart() {
        throw new Error('hostile');
      },
      routeMatched() {
        throw new Error('hostile');
      },
      dataFetch() {
        throw new Error('hostile');
      },
      serviceCall() {
        throw new Error('hostile');
      },
      streamPhase() {
        throw new Error('hostile');
      },
      sent() {
        throw new Error('hostile');
      },
      aborted() {
        throw new Error('hostile');
      },
      failed() {
        throw new Error('hostile');
      },
      clientHydration() {
        throw new Error('hostile');
      },
    });

    const plain = await runSSR(undefined);
    const withHostile = await runSSR(hostile);

    expect(withHostile.sent).toEqual(plain.sent);
    expect(withHostile.status).toHaveBeenCalledWith(200);
  });
});
