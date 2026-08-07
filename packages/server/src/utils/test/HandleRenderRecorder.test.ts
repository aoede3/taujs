// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createDevIntrospection } from '../../core/introspection/DevIntrospection';
import { createSafeRecorder } from '../../core/introspection/EpisodeRecorder';
import { handleRender } from '../HandleRender';
import { collectPartialDocument } from '../../test/support/document';
import { handleNotFound } from '../HandleNotFound';

import type { EpisodeRecorder } from '../../core/introspection/EpisodeRecorder';

vi.mock('../../core/routes/DataRoutes', () => ({
  fetchInitialData: vi.fn(async () => ({ product: { id: '42' } })),
}));

const T = 'episode-render-1';

const mkLogger = (): any => {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebugEnabled: vi.fn(() => false) };
  l.child = vi.fn(() => l);
  return l;
};

const mkReq = (url: string, recorder?: EpisodeRecorder, server?: unknown): any => {
  const raw = new EventEmitter() as any;
  raw.url = url;
  return {
    url,
    method: 'GET',
    headers: { host: 'localhost' },
    raw,
    server,
    taujsRequestContext: { requestId: T, logger: mkLogger(), headers: {}, recorder },
  };
};

const mkReply = (): any => {
  const raw = new PassThrough() as any;
  raw.writeHead = vi.fn();
  raw.headersSent = false;
  // A real `reply.raw` is a `ServerResponse`, and the response terminal reads its status at
  // `finish`. Fastify sets it; the mock declares the same default so cells can change it.
  raw.statusCode = 200;
  // ...and it carries the SOCKET the terminal classifies from, captured when the SSR arm installs
  // its listeners. The mock declares a healthy one; the cells that need a dead peer kill it.
  raw.socket = { destroyed: false, errored: null };
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
  renderSSRModule.renderSSR.mockClear();
});

const runSSR = async (recorder?: EpisodeRecorder) => {
  const req = mkReq('/product/42', recorder);
  const reply = mkReply();
  await handleRender(req, reply, ssrRoute as any, configs, {} as any, maps(renderSSRModule), { logger: mkLogger() });
  return reply;
};

/**
 * The response LIFECYCLE, driven by hand. `mkReply().raw` is a `PassThrough`, so it emits nothing
 * on its own, and an SSR episode is finalised by the response's own events rather than by
 * `reply.send()` returning - `send()` queues a response and says nothing about its delivery.
 */
const emitFinish = (reply: any): Promise<void> =>
  new Promise<void>((resolve) => {
    reply.raw.on('finish', () => resolve());
    reply.raw.end();
  });

/** Premature termination: the socket closes with the response still unfinished. */
const emitClose = (reply: any): void => {
  reply.raw.emit('close');
};

type TerminalCall = { terminal: 'sent' | 'aborted' | 'failed'; event: Record<string, unknown> };

/**
 * Terminal CALLS, not merely finalised episodes: the assembler drops a second terminal silently, so
 * counting the calls is what proves the LATCH rather than the assembler's tolerance. Same idiom as
 * `test/StreamingTransport.test.ts`.
 */
const watchTerminals = (recorder: EpisodeRecorder): TerminalCall[] => {
  const calls: TerminalCall[] = [];

  for (const terminal of ['sent', 'aborted', 'failed'] as const) {
    const original = recorder[terminal].bind(recorder);

    (recorder as unknown as Record<string, unknown>)[terminal] = (event: Record<string, unknown>) => {
      calls.push({ terminal, event });

      return original(event as never);
    };
  }

  return calls;
};

const DISCONNECT_WARNING = 'Client disconnected before the SSR response finished';

const warningsFor = (logger: any, message: string): unknown[] => logger.warn.mock.calls.filter((call: unknown[]) => call[1] === message);

/** One SSR request with its request-context logger exposed, so response-terminal logs are readable. */
const ssrHarness = (recorder?: EpisodeRecorder, renderModule: unknown = renderSSRModule) => {
  const logger = mkLogger();
  const req = mkReq('/product/42', recorder);
  req.taujsRequestContext.logger = logger;
  const reply = mkReply();

  return { req, reply, logger, run: () => handleRender(req, reply, ssrRoute as any, configs, {} as any, maps(renderModule), { logger: mkLogger() }) };
};

describe('handleRender recorder events (P0B-02 hook sites)', () => {
  it('SSR happy path: routeMatched → dataFetch → response finish → sent(ssr, 200)', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/product/42?ref=mail', method: 'GET' });

    const reply = await runSSR(dev.recorder);
    // REWRITTEN, not relocated: the assertions below are the original ones. What changed is the
    // moment the episode finalises - the delivery terminal is the response's own `finish`, which a
    // mocked reply only produces when it is driven.
    await emitFinish(reply);

    const [episode] = dev.getEpisodes();
    expect(episode).toMatchObject({
      requestId: T,
      route: '/product/:id',
      appId: 'storefront',
      mode: 'ssr',
      outcome: 'complete',
      status: 200,
      url: { pathname: '/product/42', queryKeys: ['ref'], queryValuesRedacted: true },
    });
    expect(episode!.timeline.matched).toBeTypeOf('number');
    expect(episode!.timeline.dataEnd).toBeTypeOf('number');
  });

  it('SSR render failure: outcome failed with the error message', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/product/42', method: 'GET' });
    const failingModule = { renderSSR: vi.fn(async () => Promise.reject(new Error('render exploded'))) };
    const req = mkReq('/product/42', dev.recorder);
    const reply = mkReply();

    await expect(handleRender(req, reply, ssrRoute as any, configs, {} as any, maps(failingModule), { logger: mkLogger() })).rejects.toThrow();

    const [episode] = dev.getEpisodes();
    expect(episode!.outcome).toBe('failed');
    expect(episode!.error!.message).toContain('render exploded');
  });

  // RELOCATED: an episode is FINALISED by a response terminal, and the delivery terminal is
  // Fastify's `finish` - a mocked reply never emits it, so the episode never finalises and the
  // timeline cannot be read here. The same contract - streaming mode, `complete` outcome, status
  // 200, and head/shellReady/allReady timeline entries - is asserted on a real listener in
  // `test/StreamingTransport.test.ts` cell 1.

  it('fallthrough: handleNotFound emits sent(fallthrough) on the hoisted context', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/spa/deep/link', method: 'GET' });

    const req = mkReq('/spa/deep/link', dev.recorder);
    const reply = mkReply();
    await handleNotFound(
      req,
      reply,
      configs,
      { cssLinks: new Map(), bootstrapModules: new Map(), templates: maps(renderSSRModule).templates },
      { logger: mkLogger() },
    );

    const [episode] = dev.getEpisodes();
    expect(episode).toMatchObject({ route: null, mode: 'fallthrough', outcome: 'complete', status: 200 });
  });
});

// The first observable SSR terminal wins. `finish` is NOT delivery - it means the payload was
// handed to the operating system, not that the client received it, and on this buffered arm it
// fires even after the peer has reset (measured). So the terminal classifies from the SOCKET
// captured when the listeners installed: dead socket at `finish` records `aborted`, healthy or
// absent records `complete`. A `close` while the latch is open records `aborted` at the current
// stage; a τjs-observed failure records `failed`. `writableFinished` appears nowhere - event
// ordering plus the latch owns normal finish-then-close.
//
// These cells drive the lifecycle by hand. The real-socket half is in
// `test/SsrResponseLifecycle.test.ts`; a healthy `inject()` producing no false disconnect is
// guarded by `test/HostOwnership.test.ts`.
describe('SSR response terminal: the first observable terminal wins', () => {
  it('1: reply.send() returning does NOT record a terminal', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/product/42', method: 'GET' });
    const terminals = watchTerminals(dev.recorder);
    const harness = ssrHarness(dev.recorder);

    await harness.run();

    // The handler has handed a complete document to `send()` and returned. Nothing about the
    // RESPONSE has been observed yet, so the episode has no terminal at all - this is precisely the
    // moment that used to be recorded as a successful 200.
    expect(harness.reply.sent).toHaveLength(1);
    expect(terminals).toEqual([]);
    expect(dev.getEpisodes()).toEqual([]);
  });

  it('2: finish on a HEALTHY captured socket records exactly one sent, using the final raw status', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/product/42', method: 'GET' });
    const terminals = watchTerminals(dev.recorder);
    const harness = ssrHarness(dev.recorder);

    await harness.run();
    // What the response actually carried, not what the handler asked for: a host hook may render an
    // SSR page under a different status (a soft 404 is the ordinary case), and the record has to
    // describe the wire.
    harness.reply.raw.statusCode = 404;
    await emitFinish(harness.reply);

    expect(terminals.map((call) => call.terminal)).toEqual(['sent']);
    expect(terminals[0]!.event).toMatchObject({ requestId: T, status: 404, mode: 'ssr' });
    expect(dev.getEpisodes()[0]).toMatchObject({ outcome: 'complete', status: 404, mode: 'ssr' });
  });

  it('3: finish on a DESTROYED captured socket records one aborted at send plus one warning', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/product/42', method: 'GET' });
    const terminals = watchTerminals(dev.recorder);
    const harness = ssrHarness(dev.recorder);

    await harness.run();
    // The peer left while the payload was still going out. `finish` fires anyway - that is Node's
    // contract, and it is why the socket rather than the event decides the arm.
    harness.reply.raw.socket.destroyed = true;
    await emitFinish(harness.reply);

    expect(terminals.map((call) => call.terminal)).toEqual(['aborted']);
    expect(terminals[0]!.event).toMatchObject({ requestId: T, phase: 'send' });
    expect(dev.getEpisodes()[0]).toMatchObject({ outcome: 'aborted' });
    expect(warningsFor(harness.logger, DISCONNECT_WARNING)).toHaveLength(1);
  });

  it('3b: finish on an ERRORED captured socket is classified the same way', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/product/42', method: 'GET' });
    const terminals = watchTerminals(dev.recorder);
    const harness = ssrHarness(dev.recorder);

    await harness.run();
    // The measured shape leaves ECONNRESET on the socket in the same tick as `finish`; a socket
    // that errored is as dead as one already destroyed.
    harness.reply.raw.socket.errored = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    await emitFinish(harness.reply);

    expect(terminals.map((call) => call.terminal)).toEqual(['aborted']);
    expect(terminals[0]!.event).toMatchObject({ phase: 'send' });
    expect(warningsFor(harness.logger, DISCONNECT_WARNING)).toHaveLength(1);
  });

  it('4: a close while the latch is open records one aborted at the CURRENT stage, and a later finish is latched out', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/product/42', method: 'GET' });
    const terminals = watchTerminals(dev.recorder);
    const harness = ssrHarness(dev.recorder);

    await harness.run();
    emitClose(harness.reply);
    await emitFinish(harness.reply);

    // The stage is `send` because the close arrived after the handoff; the phase is preserved
    // rather than blanket-reported, so the earlier arms keep the phases they already record. The
    // measured defect was TWO-fold - the episode said `complete`, and nothing else in the record
    // hinted that the response had been abandoned - so the warning is part of the cell.
    expect(terminals.map((call) => call.terminal)).toEqual(['aborted']);
    expect(terminals[0]!.event).toMatchObject({ requestId: T, phase: 'send' });
    expect(dev.getEpisodes()[0]).toMatchObject({ outcome: 'aborted' });
    expect(warningsFor(harness.logger, DISCONNECT_WARNING)).toHaveLength(1);
  });

  it('5: finish followed by close remains complete - no aborted terminal, no warning', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/product/42', method: 'GET' });
    const terminals = watchTerminals(dev.recorder);
    const harness = ssrHarness(dev.recorder);

    await harness.run();
    await emitFinish(harness.reply);
    emitClose(harness.reply);

    // Every response closes eventually. EVENT ORDERING plus the latch is what stops the ordinary
    // close that follows a successful delivery from reclassifying it - there is no
    // `writableFinished` guard here, because that read is unsound in both directions.
    expect(terminals.map((call) => call.terminal)).toEqual(['sent']);
    expect(dev.getEpisodes()[0]).toMatchObject({ outcome: 'complete' });
    expect(warningsFor(harness.logger, DISCONNECT_WARNING)).toHaveLength(0);
  });

  it('6: a response already destroyed when the listeners attach records one aborted plus one warning', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/product/42', method: 'GET' });
    const terminals = watchTerminals(dev.recorder);
    const harness = ssrHarness(dev.recorder);

    // The client left while a host hook - or, in development, Vite's module loading - was still
    // awaiting in front of the handler. `close` has already been emitted, so no listener attached
    // afterwards can ever fire: the event has to be observed by asking, not by listening.
    harness.reply.raw.destroy();
    await harness.run();

    expect(terminals.map((call) => call.terminal)).toEqual(['aborted']);
    expect(terminals[0]!.event).toMatchObject({ phase: 'pre-render' });
    expect(dev.getEpisodes()[0]).toMatchObject({ outcome: 'aborted' });
    expect(warningsFor(harness.logger, DISCONNECT_WARNING)).toHaveLength(1);
  });

  it('7: a close followed by a signal-abort branch still records exactly ONE aborted terminal', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/product/42', method: 'GET' });
    const terminals = watchTerminals(dev.recorder);
    let harness: ReturnType<typeof ssrHarness>;

    // The socket closes DURING the render, so the close arm classifies at stage `render` and the
    // post-render signal check then reaches its own abort site. Two observations, one owner.
    const closingModule = {
      renderSSR: vi.fn(async () => {
        emitClose(harness.reply);
        return { headContent: '', appHtml: '<div>app</div>' };
      }),
    };

    harness = ssrHarness(dev.recorder, closingModule);
    await harness.run();

    expect(terminals.map((call) => call.terminal)).toEqual(['aborted']);
    expect(terminals[0]!.event).toMatchObject({ phase: 'render' });
    expect(dev.getEpisodes()[0]).toMatchObject({ outcome: 'aborted' });

    // The signal-abort site keeps its own log line - only the TERMINAL is latched, not the arm's
    // existing diagnostics.
    expect(warningsFor(harness.logger, 'SSR completed but client disconnected')).toHaveLength(1);
    expect(warningsFor(harness.logger, DISCONNECT_WARNING)).toHaveLength(1);
  });

  it('8: a render failure followed by finish and close records exactly ONE failed terminal', async () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/product/42', method: 'GET' });
    const terminals = watchTerminals(dev.recorder);
    const failingModule = { renderSSR: vi.fn(async () => Promise.reject(new Error('render exploded'))) };
    const harness = ssrHarness(dev.recorder, failingModule);

    await expect(harness.run()).rejects.toThrow();
    // Fastify's error response finishes normally afterwards. The latch is what stops that `finish`
    // from adding a `sent` on top of a failure the outer catch already owns.
    await emitFinish(harness.reply);
    emitClose(harness.reply);

    expect(terminals.map((call) => call.terminal)).toEqual(['failed']);
    expect(dev.getEpisodes()[0]).toMatchObject({ outcome: 'failed' });
    expect(dev.getEpisodes()[0]!.error!.message).toContain('render exploded');
    expect(warningsFor(harness.logger, DISCONNECT_WARNING)).toHaveLength(0);
  });
});

describe('dev stamp injection (P0B-04, spec 03 §7)', () => {
  const devServer = { taujsIntrospection: { token: 'boot-token-abc' } };

  it('SSR HTML carries the stamp + hook + beacon script when the dev decoration exists', async () => {
    const req = mkReq('/product/42', undefined, devServer);
    const reply = mkReply();

    await handleRender(req, reply, ssrRoute as any, configs, {} as any, maps(renderSSRModule), { logger: mkLogger() });

    const html = String(reply.sent[0]);
    expect(html).toContain(`window.__TAUJS_REQUEST_ID__="${T}"`);
    expect(html).toContain('window.__TAUJS_DEV_TOKEN__="boot-token-abc"');
    expect(html).toContain('__TAUJS_DEVTOOLS_HOOK__');
    expect(html).toContain('/__taujs/beacon');
  });

  it('SSR HTML carries no stamp without the decoration (prod shape)', async () => {
    const reply = await runSSR(undefined);

    const html = String(reply.sent[0]);
    expect(html).not.toContain('__TAUJS_REQUEST_ID__');
    expect(html).not.toContain('__taujs');
  });

  it('streaming head write carries the stamp when the decoration exists', async () => {
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
    // The renderer runs on CONSUMPTION, so the document is driven here. Note the DELIVERY terminal
    // (`sent(streaming)` -> `complete`) is Fastify's `finish`, which only a real response emits;
    // that half lives in `test/StreamingTransport.test.ts` cells 1 and 6.
    const { document } = await collectPartialDocument(
      await handleRender(req, reply, streamingRoute as any, configs, {} as any, maps(streamingModule), { logger: mkLogger() }),
    );
    expect(document).toContain('__TAUJS_REQUEST_ID__');

    expect(document).toContain(`window.__TAUJS_REQUEST_ID__="${T}"`);

    // Regression: the stamp must sit in <head>, never inside the app container. A <script>
    // preceding the streamed app HTML inside #root is a Vue hydration node mismatch — Vue
    // re-renders the whole app as a duplicate sibling (React skips unexpected scripts).
    // DOCUMENT ORDER is the contract, and the document is where it is now observable.
    expect(document.indexOf('__TAUJS_REQUEST_ID__')).toBeLessThan(document.indexOf('</head>'));
    // The shell ends at the app container opening, before any app bytes follow it.
    expect(document.indexOf('<main>')).toBeGreaterThan(document.indexOf('__TAUJS_REQUEST_ID__'));
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
    expect(html).toContain(`window.__TAUJS_REQUEST_ID__="${T}"`);
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
      deferredData() {
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
