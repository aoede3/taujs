// @vitest-environment node
// RFC 0007: the host wiring - start point, transport, envelope write site and every terminal,
// exercised through the REAL `handleRender` path.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, it, expect, vi } from 'vitest';

import { handleRender } from '../HandleRender';

import type { TraceRecorder } from '../../core/introspection/TraceRecorder';

const T = 'trace-deferred-1';

const mkLogger = (): any => {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebugEnabled: () => false };
  l.child = () => l;
  return l;
};

const mkReq = (url: string, recorder?: TraceRecorder, logger?: any): any => {
  const raw = new EventEmitter() as any;
  raw.url = url;
  return {
    url,
    method: 'GET',
    headers: { host: 'localhost' },
    raw,
    taujsRequestContext: { requestId: T, logger: logger ?? mkLogger(), headers: {}, recorder },
  };
};

const mkReply = () => {
  const chunks: string[] = [];
  const raw = new PassThrough() as any;
  raw.writeHead = vi.fn(() => {
    raw.headersSent = true;
  });
  raw.headersSent = false;
  const write = raw.write.bind(raw);
  raw.write = (chunk: any, ...rest: any[]) => {
    chunks.push(String(chunk));
    return write(chunk, ...rest);
  };
  const reply: any = {
    raw,
    chunks,
    header: vi.fn(() => reply),
    status: vi.fn(() => reply),
    getHeaders: vi.fn(() => ({})),
    getHeader: vi.fn(() => undefined),
    hijack: vi.fn(),
    send: vi.fn(() => reply),
  };
  return reply;
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

const route = (attr: Record<string, unknown>) => ({ route: { path: '/product/:id', appId: 'storefront', attr }, params: { id: '42' } });

type Captured = { opts?: any; callbacks?: any };

/** A renderer that commits the head, optionally reads entries, then finishes the stream. */
const mkRenderer = (captured: Captured, read?: (registry: any) => Promise<unknown>) => ({
  renderStream: vi.fn((writable: PassThrough, cb: any, initialDataInput: any, _loc: string, _boot: any, _meta: any, _signal: any, opts: any) => {
    captured.opts = opts;
    captured.callbacks = cb;
    const done = (async () => {
      cb.onHead('<title>p</title>');
      cb.onShellReady();
      const consumed = read ? await read(opts?.deferredData).catch(() => undefined) : undefined;
      writable.write(`<div>app${consumed ? JSON.stringify(consumed) : ''}</div>`);
      const data = await (typeof initialDataInput === 'function' ? initialDataInput() : initialDataInput);
      cb.onAllReady(data);
      writable.end();
    })();
    return { abort: () => {}, done };
  }),
});

const run = async (attr: Record<string, unknown>, renderModule: any, opts: { recorder?: TraceRecorder; logger?: any } = {}) => {
  const logger = opts.logger ?? mkLogger();
  const req = mkReq('/product/42', opts.recorder, logger);
  const reply = mkReply();
  await handleRender(req, reply, route(attr) as any, configs, {} as any, maps(renderModule), { logger });
  await new Promise((r) => setTimeout(r, 20));
  return { reply, html: reply.chunks.join(''), logger, req };
};

const events = () => {
  const seen: { key: string; outcome: string }[] = [];
  const noop = () => {};
  const recorder = {
    requestStart: noop,
    routeMatched: noop,
    dataFetch: noop,
    serviceCall: noop,
    streamPhase: noop,
    sent: noop,
    aborted: noop,
    failed: noop,
    clientHydration: noop,
    deferredData: (e: any) => seen.push({ key: e.key, outcome: e.outcome }),
  } as unknown as TraceRecorder;
  return { seen, recorder };
};

describe('handleRender deferred transport + envelope (RFC 0007)', () => {
  it('emits the private envelope inside the SAME nonced script, after __INITIAL_DATA__ and before taujs:data-ready', async () => {
    const captured: Captured = {};
    const { html } = await run(
      { render: 'streaming', meta: {}, deferred: { reviews: async () => ({ count: 3 }), blurb: async () => ({ text: 'hi' }) } },
      mkRenderer(captured, (r) => Promise.all([r['reviews'], r['blurb']])),
    );

    expect(html).toContain(
      'window.__INITIAL_DATA__ = {}; window.__TAUJS_DEFERRED_STATE__ = {"blurb":{"status":"complete","value":{"text":"hi"}},"reviews":{"status":"complete","value":{"count":3}}}; window.dispatchEvent(new Event(\'taujs:data-ready\'));',
    );
  });

  it('a route declaring nothing has no deferredData in the opts bag and no carrier in the bytes', async () => {
    const captured: Captured = {};
    const { html } = await run({ render: 'streaming', meta: {} }, mkRenderer(captured));

    expect('deferredData' in (captured.opts ?? {})).toBe(false);
    expect(html).not.toContain('__TAUJS_DEFERRED_STATE__');
    expect(html).toContain("window.__INITIAL_DATA__ = {}; window.dispatchEvent(new Event('taujs:data-ready'));");
  });

  it('decision 8: under hydrate:false no envelope is emitted, the rest of the script is unchanged, and outcomes are still recorded', async () => {
    const { seen, recorder } = events();
    const captured: Captured = {};
    const { html } = await run(
      { render: 'streaming', meta: {}, hydrate: false, deferred: { reviews: async () => ({ count: 3 }) } },
      mkRenderer(captured, (r) => r['reviews']),
      { recorder },
    );

    expect(html).not.toContain('__TAUJS_DEFERRED_STATE__');
    expect(html).toContain("window.__INITIAL_DATA__ = {}; window.dispatchEvent(new Event('taujs:data-ready'));");
    // The registry is still handed over, settled, classified and released.
    expect(Object.keys(captured.opts.deferredData)).toEqual(['reviews']);
    expect(seen).toEqual([{ key: 'reviews', outcome: 'complete' }]);
  });

  it('starts entries BEFORE head resolution and hands the renderer a started, pre-observed registry', async () => {
    const order: string[] = [];
    const captured: Captured = {};
    await run(
      {
        render: 'streaming',
        meta: {},
        head: {
          data: async () => {
            order.push('head');
            return { title: 't' };
          },
        },
        deferred: {
          reviews: async () => {
            order.push('deferred');
            return { count: 3 };
          },
        },
      },
      mkRenderer(captured),
    );

    expect(order).toEqual(['deferred', 'head']);
    expect(captured.opts.deferredData).toBeDefined();
    expect(Object.isFrozen(captured.opts.deferredData)).toBe(true);
  });

  it('an entry still pending at the write site is `aborted` in the envelope and the trace', async () => {
    const { seen, recorder } = events();
    const captured: Captured = {};
    const { html } = await run({ render: 'streaming', meta: {}, deferred: { reviews: () => new Promise<any>(() => {}) } }, mkRenderer(captured), { recorder });

    expect(html).toContain('window.__TAUJS_DEFERRED_STATE__ = {"reviews":{"status":"aborted"}}');
    expect(seen).toEqual([{ key: 'reviews', outcome: 'aborted' }]);
  });

  it('a consumed rejection is `failed` and detail-free in the envelope', async () => {
    const captured: Captured = {};
    const { html } = await run(
      { render: 'streaming', meta: {}, deferred: { reviews: async () => Promise.reject(new Error('BACKEND_SECRET leaked')) } },
      mkRenderer(captured, (r) => r['reviews']),
    );

    expect(html).toContain('window.__TAUJS_DEFERRED_STATE__ = {"reviews":{"status":"failed"}}');
    expect(html).not.toContain('BACKEND_SECRET');
  });

  it('post-settlement mutation of the loader object reaches neither the renderer value nor the envelope', async () => {
    const source: Record<string, unknown> = { count: 3 };
    const captured: Captured = {};
    let deliveredAtRead: unknown;
    const { html } = await run(
      { render: 'streaming', meta: {}, deferred: { reviews: async () => source } },
      mkRenderer(captured, async (r) => {
        deliveredAtRead = await r['reviews'];
        source['count'] = 'MUTATED-AFTER-SETTLEMENT';
        return deliveredAtRead;
      }),
    );

    expect(deliveredAtRead).toEqual({ count: 3 });
    expect(html).toContain('window.__TAUJS_DEFERRED_STATE__ = {"reviews":{"status":"complete","value":{"count":3}}}');
    expect(html).not.toContain('MUTATED-AFTER-SETTLEMENT');
  });
});

describe('handleRender deferred terminals (R2 item 8)', () => {
  it('a non-optional HEAD failure aborts and detaches already-started deferred work', async () => {
    const { seen, recorder } = events();
    let entrySignal: AbortSignal | undefined;
    const captured: Captured = {};
    await run(
      {
        render: 'streaming',
        meta: {},
        head: { data: async () => Promise.reject(new Error('head exploded')) },
        deferred: {
          reviews: async (_p: unknown, ctx: any) => {
            entrySignal = ctx.signal;
            return new Promise<any>(() => {});
          },
        },
      },
      mkRenderer(captured),
      { recorder },
    );

    expect(seen).toEqual([{ key: 'reviews', outcome: 'aborted' }]);
    expect(entrySignal!.aborted).toBe(true);
    expect(captured.opts).toBeUndefined(); // the renderer was never reached
  });

  it('a SYNCHRONOUS renderStream throw is a response terminal: classified once, signalled, detached', async () => {
    const { seen, recorder } = events();
    let entrySignal: AbortSignal | undefined;
    const throwing = {
      renderStream: vi.fn(() => {
        throw new Error('renderStream exploded synchronously');
      }),
    };
    const req = mkReq('/product/42', recorder);
    const reply = mkReply();

    await expect(
      handleRender(
        req,
        reply,
        route({
          render: 'streaming',
          meta: {},
          deferred: {
            reviews: async (_p: unknown, ctx: any) => {
              entrySignal = ctx.signal;
              return new Promise<any>(() => {});
            },
          },
        }) as any,
        configs,
        {} as any,
        maps(throwing),
        { logger: mkLogger() },
      ),
    ).rejects.toThrow(/handleRender failed/);

    expect(seen).toEqual([{ key: 'reviews', outcome: 'aborted' }]);
    expect(entrySignal!.aborted).toBe(true);
  });

  it('a FATAL renderer error releases the registry', async () => {
    const { seen, recorder } = events();
    let entrySignal: AbortSignal | undefined;
    const fatal = {
      renderStream: vi.fn((_w: PassThrough, cb: any) => {
        cb.onError(new Error('boom'));
        return { abort: () => {}, done: Promise.resolve() };
      }),
    };
    await run(
      {
        render: 'streaming',
        meta: {},
        deferred: {
          reviews: async (_p: unknown, ctx: any) => {
            entrySignal = ctx.signal;
            return new Promise<any>(() => {});
          },
        },
      },
      fatal,
      { recorder },
    );

    expect(seen).toEqual([{ key: 'reviews', outcome: 'aborted' }]);
    expect(entrySignal!.aborted).toBe(true);
  });

  it('a client disconnect classifies and detaches through the request signal', async () => {
    const { seen, recorder } = events();
    let entrySignal: AbortSignal | undefined;
    const stalled = {
      renderStream: vi.fn((_w: PassThrough, cb: any) => {
        cb.onHead('<title>p</title>');
        return { abort: () => {}, done: Promise.resolve() };
      }),
    };
    const req = mkReq('/product/42', recorder);
    const reply = mkReply();
    await handleRender(
      req,
      reply,
      route({
        render: 'streaming',
        meta: {},
        deferred: {
          reviews: async (_p: unknown, ctx: any) => {
            entrySignal = ctx.signal;
            return new Promise<any>(() => {});
          },
        },
      }) as any,
      configs,
      {} as any,
      maps(stalled),
      { logger: mkLogger() },
    );

    req.raw.emit('aborted');
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual([{ key: 'reviews', outcome: 'aborted' }]);
    expect(entrySignal!.aborted).toBe(true);
  });

  it('a response ALREADY ENDED at the finish tick is still a terminal: signalled, classified exactly once, retaining nothing', async () => {
    const { seen, recorder } = events();
    const signals: Record<string, AbortSignal | undefined> = {};
    const req = mkReq('/product/42', recorder);
    const reply = mkReply();

    // `writableEnded` is a prototype getter on the real stream; an own accessor lets this test
    // stage the two ticks the listener sees - ended (the early return) and not ended (the write
    // site) - without destroying the pipe the head commit established.
    let ended = false;
    Object.defineProperty(reply.raw, 'writableEnded', { configurable: true, get: () => ended });

    // The host attaches its 'finish' listener AFTER `renderStream` returns, so capturing `on`
    // here hands the test the real listener to fire on a later tick, exactly as the emitter would.
    let finish: (() => void) | undefined;
    const stalled = {
      renderStream: vi.fn((writable: PassThrough, cb: any) => {
        cb.onHead('<title>p</title>');
        cb.onShellReady();
        const on = writable.on.bind(writable);
        (writable as any).on = (event: string, handler: any) => {
          if (event === 'finish') {
            finish = handler;
            return writable;
          }
          return on(event, handler);
        };
        return { abort: () => {}, done: Promise.resolve() };
      }),
    };

    const pending = (key: string) => async (_p: unknown, ctx: any) => {
      signals[key] = ctx.signal;
      return new Promise<any>(() => {});
    };

    await handleRender(
      req,
      reply,
      route({ render: 'streaming', meta: {}, deferred: { reviews: pending('reviews'), blurb: pending('blurb') } }) as any,
      configs,
      {} as any,
      maps(stalled),
      { logger: mkLogger() },
    );

    // Nothing has terminated yet: the release must come from the finish listener itself.
    expect(seen).toEqual([]);
    expect(signals['reviews']!.aborted).toBe(false);

    ended = true;
    expect(() => finish!()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    // The bytes are gone, so no envelope can be emitted - but the work is signalled and each
    // pending key is classified `aborted` EXACTLY ONCE.
    expect(signals['reviews']!.aborted).toBe(true);
    expect(signals['blurb']!.aborted).toBe(true);
    expect(seen).toEqual([
      { key: 'reviews', outcome: 'aborted' },
      { key: 'blurb', outcome: 'aborted' },
    ]);
    expect(reply.chunks.join('')).not.toContain('__TAUJS_DEFERRED_STATE__');

    // Envelope state: the controller retains nothing afterwards. A later write site emits the
    // EMPTY envelope rather than re-classifying keys already accounted for in the trace.
    ended = false;
    expect(() => finish!()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    expect(reply.chunks.join('')).toContain('window.__TAUJS_DEFERRED_STATE__ = {};');
    expect(seen).toEqual([
      { key: 'reviews', outcome: 'aborted' },
      { key: 'blurb', outcome: 'aborted' },
    ]);
  });

  it('an UNCONSUMED rejection never raises unhandledRejection and never reverses the completed document', async () => {
    const seenUnhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => seenUnhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    let html = '';
    try {
      const captured: Captured = {};
      ({ html } = await run(
        { render: 'streaming', meta: {}, deferred: { reviews: async () => Promise.reject(new Error('nobody reads me')) } },
        mkRenderer(captured),
      ));
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(seenUnhandled).toEqual([]);
    expect(html).toContain('window.__INITIAL_DATA__ = {}');
    expect(html).toContain('__TAUJS_DEFERRED_STATE__');
  });
});
