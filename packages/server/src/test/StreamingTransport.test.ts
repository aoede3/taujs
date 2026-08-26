// @vitest-environment node
//
// The streaming transport's ACCEPTANCE SPINE, on a real listener.
//
// τjs streams by returning a cold document to Fastify: nothing runs until Fastify consumes the
// payload, so the host's `onSend` hooks, transformations and payload replacement all compose, and
// there is no window in which τjs owns a live stream Fastify has not taken over.
//
// The commitment boundary is the BYTE, not a renderer callback:
//
//   before the first document byte is yielded to Fastify -> a failure can still become a real 500;
//   after the first byte                                  -> a failure aborts the transfer.
//
// Everything here needs a real socket. Consuming the document in isolation proves assembly, not
// status, headers, hook behaviour, replacement, abort or disconnect - those are Fastify's, and
// `inject()` cannot see wire behaviour on this seam either.

import http from 'node:http';
import { Transform, pipeline } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServer } from '../CreateServer';
import { createDevIntrospection } from '../core/introspection/DevIntrospection';
import { testRenderer } from './support/renderer';

import type { FastifyInstance } from 'fastify';

const PATHS = {
  ok: '/stream-ok',
  preByteFatal: '/stream-pre-byte-fatal',
  postByteFatal: '/stream-post-byte-fatal',
  slow: '/stream-slow',
  /** Head resolution fails inside the handler, BEFORE Fastify pulls the document. */
  headFailure: '/stream-head-failure',
  /** Writes bytes and then NEVER ends, so the producer is demonstrably unfinished at disconnect. */
  stalled: '/stream-stalled',
  /** Writes bytes, then reports a FATAL well after the client has gone: the coordinator race. */
  fatalAfterDisconnect: '/stream-fatal-after-disconnect',
  /** Reports onAllReady LONG after the client has gone: can late completion still emit bytes? */
  lateAllReady: '/stream-late-allready',
  /** `renderStream` throws SYNCHRONOUSLY on construction - distinct from a callback `onError`. */
  syncThrow: '/stream-sync-throw',
  /**
   * Fatal reported in the SAME TICK as the head: after `onHead` resolved the shell, but before the
   * document generator resumed and yielded its first byte. Still a pre-byte failure by the byte
   * rule, and the window every shipped renderer's throwing-head path lands in.
   */
  headThenFatalSameTick: '/stream-head-then-fatal-same-tick',
  /** Its deferred entry starts but can only settle by being aborted. */
  replaced: '/stream-replaced',
} as const;

const CHUNKS = 60;
const CHUNK = 'x'.repeat(16 * 1024);

/**
 * A real render module. It drives the writable with `write()`/`end()` and never simulates `finish`:
 * writable finish is NOT readable end, and conflating them is exactly the truncation this transport
 * was designed to avoid.
 */
const RENDER_MODULE = `
const tag = Symbol.for('taujs.render-contract/v1');
const brand = (fn) => Object.defineProperty(fn, tag, { value: { key: 'test', contractVersion: 'v1' } });

globalThis.__streamProbe = { starts: {}, rendererAborts: {}, deferredAborts: {}, drains: {} };

export const renderSSR = brand(async () => ({ headContent: '', appHtml: '<main>ssr</main>' }));

export const renderStream = brand((writable, callbacks, _data, url, _bootstrap, _meta, signal) => {
  const leg = url.split('?')[0];
  globalThis.__streamProbe.starts[leg] = (globalThis.__streamProbe.starts[leg] ?? 0) + 1;

  // The renderer's own signal: a real disconnect must cancel it, exactly once.
  signal?.addEventListener?.('abort', () => {
    globalThis.__streamProbe.rendererAborts[leg] = (globalThis.__streamProbe.rendererAborts[leg] ?? 0) + 1;
  });

  if (leg === '${PATHS.syncThrow}') {
    // Not a callback channel: the renderer explodes as it is constructed.
    throw new Error('renderStream exploded synchronously');
  }

  if (leg === '${PATHS.preByteFatal}') {
    // Fails before any head or output: nothing has been yielded to Fastify.
    callbacks.onError(new Error('pre-byte fatal'));
    return { abort() {}, done: Promise.resolve() };
  }

  callbacks.onHead('<meta name="probe" content="' + leg + '">');

  if (leg === '${PATHS.postByteFatal}') {
    writable.write('<main>partial</main>');
    setTimeout(() => callbacks.onError(new Error('post-byte fatal')), 20);
    return { abort() {}, done: Promise.resolve() };
  }

  if (leg === '${PATHS.headThenFatalSameTick}') {
    // The head has resolved, but the document generator has NOT yet resumed from its await, so no
    // byte has been yielded to Fastify. The renderer completes its sink normally - only the fatal
    // channel reports the failure. All three shipped renderers route a throwing head this way.
    writable.write('<main>partial</main>');
    callbacks.onError(new Error('fatal in the same tick as the head'));
    writable.end();
    return { abort() {}, done: Promise.resolve() };
  }

  if (leg === '${PATHS.lateAllReady}') {
    writable.write('<main>partial</main>');
    setTimeout(() => {
      callbacks.onAllReady?.({ late: 'data-that-must-not-be-emitted' });
      writable.end();
    }, 250);
    return { abort() {}, done: Promise.resolve() };
  }

  if (leg === '${PATHS.fatalAfterDisconnect}') {
    writable.write('<main>partial</main>');
    // A failure-shaped APPLICATION error arriving long after the client left. It must not be able
    // to reclassify an already-aborted response.
    setTimeout(() => callbacks.onError(Object.assign(new Error('late fatal'), { code: 'EPIPE' })), 250);
    return { abort() {}, done: new Promise(() => {}) };
  }

  if (leg === '${PATHS.stalled}') {
    // Deliberately never ends: no end() call, so finish cannot precede the disconnect.
    writable.write('<main>stalled</main>');
    return { abort() {}, done: new Promise(() => {}) };
  }

  if (leg === '${PATHS.slow}') {
    let i = 0;
    const pump = () => {
      while (i < ${CHUNKS}) {
        i += 1;
        if (!writable.write('${CHUNK}')) {
          globalThis.__streamProbe.drains[leg] = (globalThis.__streamProbe.drains[leg] ?? 0) + 1;
          writable.once('drain', pump);
          return;
        }
      }
      callbacks.onAllReady?.({ leg });
      writable.end();
    };
    pump();
    return { abort() {}, done: Promise.resolve() };
  }

  writable.write('<main>' + leg + '</main>');
  callbacks.onShellReady?.();
  callbacks.onAllReady?.({ leg });
  writable.end();
  return { abort() {}, done: Promise.resolve() };
});
`;

type Probe = { starts: Record<string, number>; rendererAborts: Record<string, number>; deferredAborts: Record<string, number>; drains: Record<string, number> };

const probe = (): Probe => (globalThis as unknown as { __streamProbe: Probe }).__streamProbe;

const fixture = async (): Promise<{ root: string; clientRoot: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taujs-streaming-transport-'));
  const clientRoot = path.join(root, 'client');
  const appRoot = path.join(clientRoot, 'app');
  const ssrRoot = path.join(root, 'ssr', 'app');

  await mkdir(path.join(appRoot, '.vite'), { recursive: true });
  await mkdir(ssrRoot, { recursive: true });
  await mkdir(path.join(appRoot, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><html><head><!--ssr-head--></head><body><div id="app"><!--ssr-html--></div></body></html>');
  await writeFile(path.join(appRoot, '.vite', 'manifest.json'), JSON.stringify({ 'entry-client.ts': { file: 'assets/client.js' } }));
  await writeFile(path.join(appRoot, 'assets', 'client.js'), 'export const marker = "streaming";\n');
  await writeFile(path.join(ssrRoot, 'entry-server.js'), RENDER_MODULE);

  return { root, clientRoot };
};

const streaming = (extra: Record<string, unknown> = {}) => ({ render: 'streaming' as const, meta: {}, ...extra });

const config = {
  apps: [
    {
      appId: 'streaming-transport',
      entryPoint: 'app',
      renderer: testRenderer(),
      routes: [
        { path: PATHS.ok, attr: streaming({ hydrate: true, deferred: { late: async () => ({ value: 'deferred-payload' }) } }) },
        { path: PATHS.preByteFatal, attr: streaming() },
        {
          path: PATHS.syncThrow,
          attr: streaming({
            hydrate: true,
            deferred: {
              pending: (_params: unknown, ctx: { signal?: AbortSignal }) =>
                new Promise<Record<string, unknown>>(() => {
                  ctx.signal?.addEventListener('abort', () => {
                    probe().deferredAborts[PATHS.syncThrow] = (probe().deferredAborts[PATHS.syncThrow] ?? 0) + 1;
                  });
                }),
            },
          }),
        },
        { path: PATHS.postByteFatal, attr: streaming() },
        { path: PATHS.headThenFatalSameTick, attr: streaming() },
        { path: PATHS.slow, attr: streaming() },
        {
          path: PATHS.headFailure,
          attr: streaming({
            head: {
              data: async () => {
                throw new Error('head boom');
              },
            },
          }),
        },
        { path: PATHS.fatalAfterDisconnect, attr: streaming() },
        { path: PATHS.lateAllReady, attr: streaming({ hydrate: true }) },
        {
          path: PATHS.stalled,
          attr: streaming({
            hydrate: true,
            deferred: {
              // Never settles on its own: its CHILD signal aborting is the observable.
              late: (_params: unknown, ctx: { signal?: AbortSignal }) =>
                new Promise<Record<string, unknown>>(() => {
                  ctx.signal?.addEventListener('abort', () => {
                    probe().deferredAborts[PATHS.stalled] = (probe().deferredAborts[PATHS.stalled] ?? 0) + 1;
                  });
                }),
            },
          }),
        },
        {
          path: PATHS.replaced,
          attr: streaming({
            hydrate: true,
            // Starts eagerly and can only end by the response terminal classifying it.
            deferred: { late: () => new Promise<Record<string, unknown>>(() => {}) },
          }),
        },
      ],
    },
  ],
} as never;

type Wire = { status: number; headers: Map<string, string[]>; body: string; errored: string | null };

const read = (port: number, url: string, options: { slowRead?: boolean; abortAfterBytes?: number } = {}): Promise<Wire> =>
  new Promise((resolve) => {
    let body = '';
    let aborted = false;

    const request = http.get({ host: '127.0.0.1', port, path: url }, (response) => {
      const headers = new Map<string, string[]>();

      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const name = response.rawHeaders[i]!.toLowerCase();
        headers.set(name, [...(headers.get(name) ?? []), response.rawHeaders[i + 1]!]);
      }

      const settle = (errored: string | null) => resolve({ status: response.statusCode ?? 0, headers, body, errored });

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;

        if (options.abortAfterBytes && body.length >= options.abortAfterBytes && !aborted) {
          aborted = true;
          request.destroy();
        }

        if (options.slowRead) {
          response.pause();
          setTimeout(() => response.resume(), 5);
        }
      });
      response.on('aborted', () => settle('aborted'));
      response.on('error', (error) => settle(String(error.message)));
      response.on('end', () => settle(null));
    });

    request.on('error', (error) => resolve({ status: 0, headers: new Map(), body, errored: String(error.message) }));
  });

type Host = {
  port: number;
  introspection: ReturnType<typeof createDevIntrospection>;
  onSendCalls: string[];
  close: () => Promise<void>;
};

/** Terminal-call provenance for the latch cell. Reset per test that reads it. */
const terminalCalls: string[] = [];

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

const WRAP_MARKER = '<!--wrapped-by-host-->';

/** The wrapper shape the documentation recommends, exercised here so the recipe is not theoretical. */
const documentedWrapper = (payload: NodeJS.ReadableStream): NodeJS.ReadableStream => {
  const wrapper = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
    flush(callback) {
      callback(null, WRAP_MARKER);
    },
  });

  // `pipeline` forwards destruction in BOTH directions, so a failing document tears the wrapper
  // down too. It is called without awaiting: the payload is returned immediately and Fastify
  // consumes it, exactly as it would the unwrapped document.
  pipeline(payload, wrapper, () => {});

  return wrapper;
};

const boot = async (options: { replaceOnSend?: boolean; delaySendMs?: number; wrapWith?: 'pipeline'; stallPreHandlerMs?: number } = {}): Promise<Host> => {
  const { root, clientRoot } = await fixture();
  const app: FastifyInstance = fastify({ logger: false });
  const introspection = createDevIntrospection({});

  // Terminal CALLS, not just finalised episodes: the assembler can absorb a second terminal, so
  // counting calls is what proves the coordinator's latch rather than the recorder's tolerance.
  for (const terminal of ['sent', 'failed', 'aborted'] as const) {
    const original = introspection.recorder[terminal].bind(introspection.recorder);
    (introspection.recorder as unknown as Record<string, unknown>)[terminal] = (event: never) => {
      terminalCalls.push(terminal);

      return original(event);
    };
  }
  const onSendCalls: string[] = [];

  // The recorder rides the request context, which the τjs scope creates in its own `onRequest`; a
  // ROOT `preHandler` therefore runs late enough to attach one.
  app.addHook('preHandler', (request, _reply, done) => {
    const context = (request as unknown as { taujsRequestContext?: { requestId: string; recorder?: unknown } }).taujsRequestContext;

    if (context) {
      context.recorder = introspection.recorder;
      introspection.recorder.requestStart({ requestId: context.requestId, url: request.url, method: request.method });
    }

    done();
  });

  // A host hook that awaits before the handler runs. Any real host has these - an auth lookup, a
  // feature-flag read, and in development Vite's own module loading - and they are the window in
  // which a client can leave BEFORE the transport has wired a single response listener.
  if (options.stallPreHandlerMs) {
    app.addHook('preHandler', async () => {
      await new Promise((resolve) => setTimeout(resolve, options.stallPreHandlerMs));
    });
  }

  app.addHook('onSend', async (request, _reply, payload) => {
    // Record WHAT the host was handed, not merely that the hook ran: a streamed document that
    // fails before its first byte gives the host TWO passes - the cold document, then the error
    // representation - and the distinction is part of the contract hosts see.
    const kind = payload && typeof (payload as { pipe?: unknown }).pipe === 'function' ? 'document' : 'error';

    onSendCalls.push(`${request.url}:${kind}`);

    // A host that HOLDS the payload before Fastify consumes it. The document is cold, so this is a
    // window in which a pre-consumption failure has no consumer to observe it.
    if (options.delaySendMs) await new Promise((resolve) => setTimeout(resolve, options.delaySendMs));

    if (options.replaceOnSend) return 'REPLACED-BY-HOST';

    if (options.wrapWith && payload && typeof (payload as { pipe?: unknown }).pipe === 'function') {
      return documentedWrapper(payload as NodeJS.ReadableStream);
    }

    return payload;
  });

  const close = async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  };

  // Registered BEFORE anything that can throw: a failure in `createServer` or `listen` would
  // otherwise leak the Fastify instance and the temp directory for the rest of the run, and a
  // leaked listener is exactly the kind of load that makes unrelated socket cells look flaky.
  open.push(close);

  await createServer({ config, fastify: app, clientRoot });
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();

  return { port: typeof address === 'object' && address !== null ? address.port : 0, introspection, onSendCalls, close };
};

const episodesFor = (host: Host, url: string) => host.introspection.getEpisodes().filter((episode) => episode.url.pathname === url);

describe('streaming transport: acceptance spine (real listener)', () => {
  it('1: an ordinary streamed response is delivered, and the host onSend hook runs for it', async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.ok);

    expect(wire.status).toBe(200);
    expect(wire.body).toContain('<meta name="probe"');
    expect(wire.body).toContain(`<main>${PATHS.ok}</main>`);
    expect(wire.body).toContain('__INITIAL_DATA__');
    expect(wire.body).toContain('deferred-payload');
    expect(wire.body).toContain('taujs:data-ready');
    expect(wire.errored).toBeNull();

    // The reason this transport exists: Fastify's send path now runs for a streamed response.
    expect(host.onSendCalls).toEqual([`${PATHS.ok}:document`]);

    // The episode TIMELINE is populated by the renderer's stream phases, and the episode itself is
    // finalised by Fastify's `finish` - so this belongs on a real listener, not a mocked reply.
    await vi.waitFor(() => expect(episodesFor(host, PATHS.ok)).toHaveLength(1), { timeout: 5000 });

    const episode = episodesFor(host, PATHS.ok)[0]!;

    expect({ mode: episode.mode, outcome: episode.outcome, status: episode.status }).toEqual({ mode: 'streaming', outcome: 'complete', status: 200 });
    expect(episode.timeline.head).toBeTypeOf('number');
    expect(episode.timeline.shellReady).toBeTypeOf('number');
    expect(episode.timeline.allReady).toBeTypeOf('number');

    // Header hygiene on the wire: no key repeats, so nothing is emitted under two casings.
    const names = [...wire.headers.keys()];
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    expect(wire.headers.get('content-type')?.[0]).toContain('text/html');
  });

  it('2: a fatal BEFORE the first document byte is a real 500', async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.preByteFatal);

    // A real 500 with the structured body, not a hang: the document declared `text/html` up front
    // (Fastify copies that onto the raw response before pulling), so the ERROR HANDLER must own the
    // error representation or Fastify cannot serialise its object body.
    expect(wire.status).toBe(500);
    expect(wire.body).not.toContain('<!doctype');
    expect(wire.body).not.toContain('<meta name="probe"');
    expect(JSON.parse(wire.body)).toMatchObject({ error: expect.any(String) });

    // Exactly one content-type on the wire, and it describes the body that was actually sent.
    expect(wire.headers.get('content-type')).toHaveLength(1);
    expect(wire.headers.get('content-type')?.[0]).toContain('application/json');

    // The host's send path sees the error payload EXACTLY ONCE, on the error pass - and it also
    // saw the cold document before it failed, which is Fastify running its send path per payload.
    expect(host.onSendCalls).toEqual([`${PATHS.preByteFatal}:document`, `${PATHS.preByteFatal}:error`]);

    await vi.waitFor(() => expect(episodesFor(host, PATHS.preByteFatal)).toHaveLength(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.preByteFatal)[0]!.outcome).toBe('failed');
    // PROVENANCE: the renderer's own error, not a placeholder the transport substituted.
    expect(episodesFor(host, PATHS.preByteFatal)[0]!.error?.message).toContain('pre-byte fatal');
  });

  it('2b: a SYNCHRONOUS renderStream throw is a real 500 with one failed episode, and abandons deferred work', { timeout: 30_000 }, async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.syncThrow);

    // The renderer threw as it was constructed, so nothing was ever yielded: a genuine pre-byte
    // failure, answered rather than hung.
    expect(wire.status).toBe(500);
    expect(wire.body).not.toContain('<!doctype');
    expect(wire.body).not.toContain('<meta name="probe"');
    expect(JSON.parse(wire.body)).toMatchObject({ error: expect.any(String) });
    expect(wire.headers.get('content-type')?.[0]).toContain('application/json');

    // The original rejection reached Fastify's error conversion, and exactly one terminal was
    // recorded - the response is `failed` while its abandoned deferred work is `aborted`.
    await vi.waitFor(() => expect(episodesFor(host, PATHS.syncThrow)).toHaveLength(1), { timeout: 5000 });

    const episode = episodesFor(host, PATHS.syncThrow)[0]!;

    expect(episode.outcome).toBe('failed');
    expect(episode.error?.message).toContain('renderStream exploded synchronously');
    expect(episode.deferredData?.map((entry) => entry.outcome)).toEqual(['aborted']);

    // The deferred child signal fired once - the registry was released, not stranded.
    await vi.waitFor(() => expect(probe().deferredAborts[PATHS.syncThrow]).toBe(1), { timeout: 5000 });

    // No duplicate terminal appears afterwards.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(episodesFor(host, PATHS.syncThrow)).toHaveLength(1);
  });

  it('3: a fatal AFTER the first document byte aborts the transfer', async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.postByteFatal);

    // The status cannot become 500 once bytes are delivered; the honest answer is an aborted
    // transfer with the partial document.
    expect(wire.status).toBe(200);
    expect(wire.body).toContain('<main>partial</main>');
    expect(wire.body).not.toContain('taujs:data-ready');
    expect(wire.errored).not.toBeNull();

    await vi.waitFor(() => expect(episodesFor(host, PATHS.postByteFatal)).toHaveLength(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.postByteFatal)[0]!.outcome).toBe('failed');
  });

  it('4: a host that REPLACES the payload never starts the renderer, and the response completes', async () => {
    const host = await boot({ replaceOnSend: true });
    const before = probe().starts[PATHS.replaced] ?? 0;

    const wire = await read(host.port, PATHS.replaced);

    expect(wire.status).toBe(200);
    expect(wire.body).toBe('REPLACED-BY-HOST');
    expect(wire.body).not.toContain('<!doctype');
    expect(wire.body).not.toContain('__TAUJS_DEFERRED_STATE__');
    expect(probe().starts[PATHS.replaced] ?? 0).toBe(before);

    await vi.waitFor(() => expect(episodesFor(host, PATHS.replaced)).toHaveLength(1), { timeout: 5000 });

    const episode = episodesFor(host, PATHS.replaced)[0]!;

    // The client received a deliberate, successfully completed response; the superseded τjs work
    // shows up where it belongs, as an aborted deferred entry.
    expect({ outcome: episode.outcome, mode: episode.mode }).toEqual({ outcome: 'complete', mode: 'streaming' });
    expect(episode.deferredData?.map((entry) => entry.outcome)).toEqual(['aborted']);
  });

  it('5: a disconnect while the producer is UNFINISHED yields exactly one aborted terminal', { timeout: 30_000 }, async () => {
    const host = await boot();

    // The stalled route never ends its writable, so the server cannot have finished handing bytes
    // to the transport before the client hangs up. A producer that CAN finish (the slow route)
    // legitimately completes into kernel buffers first, and `complete` would be the correct
    // classification there - see the converse cell below.
    await read(host.port, PATHS.stalled, { abortAfterBytes: 8 });

    await vi.waitFor(() => expect(episodesFor(host, PATHS.stalled)).toHaveLength(1), { timeout: 8000 });
    expect(episodesFor(host, PATHS.stalled)[0]!.outcome).toBe('aborted');

    // A REAL network disconnect must cancel the work, not merely classify the episode: the
    // renderer's signal and the deferred child signal each abort, exactly once. A unit test that
    // emits an EventEmitter event can only prove REACTION to an abort observation; this proves the
    // network event drives it.
    await vi.waitFor(() => expect(probe().rendererAborts[PATHS.stalled]).toBe(1), { timeout: 8000 });
    await vi.waitFor(() => expect(probe().deferredAborts[PATHS.stalled]).toBe(1), { timeout: 8000 });
  });

  it('5c (coordinator race): a renderer fatal arriving AFTER a disconnect does not reclassify the episode', { timeout: 30_000 }, async () => {
    const host = await boot();

    await read(host.port, PATHS.fatalAfterDisconnect, { abortAfterBytes: 8 });

    await vi.waitFor(() => expect(episodesFor(host, PATHS.fatalAfterDisconnect)).toHaveLength(1), { timeout: 8000 });
    expect(episodesFor(host, PATHS.fatalAfterDisconnect)[0]!.outcome).toBe('aborted');

    // The late fatal lands well after the abort, and it is shaped like a transport error. The
    // latch must hold: still exactly one episode, still aborted.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(episodesFor(host, PATHS.fatalAfterDisconnect)).toHaveLength(1);
    expect(episodesFor(host, PATHS.fatalAfterDisconnect)[0]!.outcome).toBe('aborted');
  });

  it('5d (race): late renderer completion after cancellation cannot reclassify the response', { timeout: 30_000 }, async () => {
    const host = await boot();
    terminalCalls.length = 0;

    await read(host.port, PATHS.lateAllReady, { abortAfterBytes: 8 });

    await vi.waitFor(() => expect(episodesFor(host, PATHS.lateAllReady)).toHaveLength(1), { timeout: 8000 });
    expect(episodesFor(host, PATHS.lateAllReady)[0]!.outcome).toBe('aborted');

    // The renderer completes 250ms after the client left, so wait past it.
    //
    // What this cell can and cannot see: once the client has destroyed its socket, the response
    // body CANNOT grow no matter what the transport writes, so asserting the late marker is absent
    // from `wire.body` would pass even if the transport emitted it. The falsifiable guarantee is
    // the latch - late completion must add no terminal and must not reclassify the episode.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(terminalCalls).toEqual(['aborted']);
    expect(episodesFor(host, PATHS.lateAllReady)).toHaveLength(1);
    expect(episodesFor(host, PATHS.lateAllReady)[0]!.outcome).toBe('aborted');
  });

  it('5e (latch): a fatal followed by the socket closing records EXACTLY ONE terminal', { timeout: 30_000 }, async () => {
    const host = await boot();
    terminalCalls.length = 0;

    // The renderer fails after the shell, then the connection closes. Two event sources, one
    // owner: the coordinator is latched, so the close cannot record a second terminal.
    const wire = await read(host.port, PATHS.postByteFatal);

    expect(wire.errored).not.toBeNull();
    await vi.waitFor(() => expect(episodesFor(host, PATHS.postByteFatal)).toHaveLength(1), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(terminalCalls).toEqual(['failed']);
  });

  it('5b (converse race): a disconnect observed AFTER the response finished stays complete', { timeout: 30_000 }, async () => {
    const host = await boot();

    // Read to completion, then let the socket close: finish precedes close, so the terminal is
    // complete and the later close must not reclassify it.
    const wire = await read(host.port, PATHS.ok);

    expect(wire.errored).toBeNull();

    await vi.waitFor(() => expect(episodesFor(host, PATHS.ok)).toHaveLength(1), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(episodesFor(host, PATHS.ok)[0]!.outcome).toBe('complete');
  });

  it('2c: a fatal in the SAME TICK as the head is still pre-byte, and cannot deliver a clean 200', { timeout: 30_000 }, async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.headThenFatalSameTick);

    // The commitment boundary is the first byte YIELDED TO FASTIFY. `onHead` resolving the shell is
    // not that byte: the generator is still suspended, so nothing has left the process. A failure
    // here must NOT be able to end the response cleanly with a truncated document - the worst
    // possible outcome, since a 200 that ends normally is cacheable and looks successful.
    expect(wire.status).toBe(500);
    expect(wire.body).not.toContain('<main>partial</main>');

    await vi.waitFor(() => expect(episodesFor(host, PATHS.headThenFatalSameTick)).toHaveLength(1), { timeout: 5000 });

    const episode = episodesFor(host, PATHS.headThenFatalSameTick)[0]!;

    expect(episode.outcome).toBe('failed');
    expect(episode.error?.message).toContain('fatal in the same tick as the head');
  });

  it('5f: a client that leaves BEFORE the transport wires its listeners is still classified', { timeout: 30_000 }, async () => {
    const host = await boot({ stallPreHandlerMs: 200 });

    // Leave while the host hook is still awaiting. By the time the transport runs, `reply.raw` has
    // already emitted `close`, so a listener attached afterwards can never fire - and the deferred
    // entries have already started eagerly, so nothing else can release them.
    await new Promise<void>((resolve) => {
      const request = http.get({ host: '127.0.0.1', port: host.port, path: PATHS.stalled }, () => {});

      request.on('error', () => resolve());
      request.on('socket', (socket) => socket.on('connect', () => setTimeout(() => (request.destroy(), resolve()), 20)));
    });

    // The response is unreachable, but the REQUEST must still be accounted for: an unclassified
    // episode leaks in the assembler, and an unreleased registry leaks its work.
    await vi.waitFor(() => expect(episodesFor(host, PATHS.stalled)).toHaveLength(1), { timeout: 8000 });
    expect(episodesFor(host, PATHS.stalled)[0]!.outcome).toBe('aborted');
    await vi.waitFor(() => expect(probe().deferredAborts[PATHS.stalled]).toBe(1), { timeout: 8000 });
  });

  it('6: normal completion yields exactly one complete terminal, and backpressure holds', { timeout: 30_000 }, async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.slow, { slowRead: true });

    expect(wire.status).toBe(200);
    // EXACT, not "most of it". A tolerance here would accept the silent truncation this transport
    // exists to prevent - a clean end with bytes missing passes every other assertion in this cell.
    expect(wire.body.split(CHUNK).length - 1).toBe(CHUNKS);
    expect(wire.body).toContain('<meta name="probe"');
    expect(wire.body.endsWith('</body></html>')).toBe(true);
    expect(wire.errored).toBeNull();

    // BACKPRESSURE, observed at the producer rather than asserted in the title: the slow reader
    // forced the renderer to wait for `drain` before continuing. Buffering the whole document
    // instead would deliver identical bytes with no wait at all.
    expect(probe().drains[PATHS.slow] ?? 0).toBeGreaterThan(0);

    await vi.waitFor(() => expect(episodesFor(host, PATHS.slow)).toHaveLength(1), { timeout: 8000 });
    expect(episodesFor(host, PATHS.slow)[0]!.outcome).toBe('complete');
  });
});

describe('streaming transport: a pre-consumption failure cannot orphan its rejection', () => {
  const withUnhandledRejectionWatch = async (run: () => Promise<void>): Promise<unknown[]> => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);

    process.on('unhandledRejection', onUnhandled);

    try {
      await run();
      // Give Node's microtask/GC-adjacent detection a chance to fire.
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    return seen;
  };

  it('an ASYNCHRONOUSLY DELAYED onSend does not orphan the early failure', { timeout: 30_000 }, async () => {
    const unhandled = await withUnhandledRejectionWatch(async () => {
      const host = await boot({ delaySendMs: 150 });
      const wire = await read(host.port, PATHS.headFailure);

      expect(wire.status).toBe(500);
    });

    expect(unhandled).toEqual([]);
  });

  it('a REPLACED payload that is never pulled does not orphan the early failure', { timeout: 30_000 }, async () => {
    const unhandled = await withUnhandledRejectionWatch(async () => {
      const host = await boot({ replaceOnSend: true });
      const wire = await read(host.port, PATHS.headFailure);

      // The host's payload is delivered and the document is never consumed at all, so nothing ever
      // observes the early rejection unless the implementation guarantees it.
      expect(wire.body).toBe('REPLACED-BY-HOST');
    });

    expect(unhandled).toEqual([]);
  });
});

describe('streaming transport: wrapping the document in an onSend hook', () => {
  it('the documented pipeline() wrapper preserves the document and appends its own bytes', async () => {
    const plain = await boot();
    const wrapped = await boot({ wrapWith: 'pipeline' });

    const direct = await read(plain.port, PATHS.ok);
    const through = await read(wrapped.port, PATHS.ok);

    expect(through.status).toBe(200);
    expect(through.body.endsWith(WRAP_MARKER)).toBe(true);
    expect(through.body.slice(0, -WRAP_MARKER.length).replace(/nonce="[^"]*"/g, 'N')).toBe(direct.body.replace(/nonce="[^"]*"/g, 'N'));
  });

  it('the documented pipeline() wrapper propagates a post-byte failure instead of hanging', { timeout: 20_000 }, async () => {
    const wrapped = await boot({ wrapWith: 'pipeline' });
    const wire = await read(wrapped.port, PATHS.postByteFatal);

    expect(wire.status).toBe(200);
    expect(wire.body).toContain('<main>partial</main>');
    expect(wire.errored).not.toBeNull();
    expect(wire.body).not.toContain('taujs:data-ready');
  });
});

describe('why a wrapper must propagate source errors (Node stream behaviour, no socket)', () => {
  it('.pipe() does NOT forward a source error to its destination', async () => {
    const { PassThrough } = await import('node:stream');
    const source = new PassThrough();
    const destination = new PassThrough();

    source.on('error', () => {});
    source.pipe(destination);

    const destinationErrors: unknown[] = [];
    let destinationEnded = false;

    destination.on('error', (error) => destinationErrors.push(error));
    destination.on('end', () => (destinationEnded = true));
    destination.resume();

    source.write('some bytes');
    source.destroy(new Error('source failed'));

    await new Promise((resolve) => setImmediate(resolve));

    // The destination neither errors nor ends: a response built on it would never terminate. This
    // is why the guide requires a wrapper to PROPAGATE, and why `pipeline()` is the recipe - the
    // two positive cells above prove it works through a real listener.
    expect(destinationErrors).toEqual([]);
    expect(destinationEnded).toBe(false);
  });
});
