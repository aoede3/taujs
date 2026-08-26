// @vitest-environment node
//
// The SSR response terminal, on a real listener.
//
// `reply.send()` QUEUES a response and returns; it says nothing about what the response then does.
// Recording delivery from that return classified an abandoned response as a successful 200 - a
// client that received 130,896 of 12,582,912 bytes before disconnecting was recorded `complete`,
// with no disconnect log anywhere in the record. Delivery itself was always correct; only the
// RECORD was wrong.
//
// `finish` is not delivery either, and that was MEASURED here rather than assumed: on this buffered
// arm the response emits `finish` even after the peer has reset, so a `finish`/`writableFinished`
// discriminator classifies the abandoned response `complete`. What the peer did is visible only on
// the SOCKET, so the arm captures it when its listeners install and classifies from it - destroyed
// or errored at `finish` records `aborted`, healthy records `complete`.
//
// Cell 12 is the load-bearing control: a 12 MiB body read to completion by a THROTTLED client must
// stay `complete`, or the socket check would merely be trading one wrong answer for another. Cell
// 14 is the second: a client that FINs its write side and keeps reading is not a disconnect.
//
// Honest limitation, stated because the cells cannot cover it: this detects socket failure observed
// by the time `finish` runs. A reset observed only afterwards is not retroactively classifiable,
// and an abandonment further downstream - a proxy timing out behind us - is unswept.
//
// Everything here needs a real socket, one per leg (`agent: false` - a shared keep-alive socket
// contaminates the trace). `inject()` cannot produce a mid-delivery disconnect, and a mocked reply
// emits no response lifecycle at all - the unit-level half is in
// `utils/test/HandleRenderRecorder.test.ts`.

import http from 'node:http';
import net from 'node:net';
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
  /** An ordinary SSR page, read to completion. */
  ok: '/ssr-ok',
  /** Its `data` is large enough that a client can leave mid-delivery - the measured shape. */
  large: '/ssr-large',
} as const;

/** The measured body size: 12 MiB of data, serialised into the inline snapshot. */
const LARGE_BYTES = 12 * 1024 * 1024;
/** The measured disconnect point: the client reads roughly one buffer, then destroys the socket. */
const ABORT_AFTER_BYTES = 64 * 1024;

const DISCONNECT_WARNING = 'Client disconnected before the SSR response finished';

const RENDER_MODULE = [
  "const tag = Symbol.for('taujs.render-contract/v1');",
  "const brand = (fn) => Object.defineProperty(fn, tag, { value: { key: 'test', contractVersion: 'v1' } });",
  'export const renderSSR = brand(async () => ({ headContent: \'<meta name="probe" content="ssr">\', appHtml: \'<main>ssr</main>\' }));',
  'export const renderStream = brand(() => ({ abort() {}, done: Promise.resolve() }));',
].join('\n');

const fixture = async (): Promise<{ root: string; clientRoot: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taujs-ssr-lifecycle-'));
  const clientRoot = path.join(root, 'client');
  const appRoot = path.join(clientRoot, 'app');
  const ssrRoot = path.join(root, 'ssr', 'app');

  await mkdir(path.join(appRoot, '.vite'), { recursive: true });
  await mkdir(ssrRoot, { recursive: true });
  await mkdir(path.join(appRoot, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><html><head><!--ssr-head--></head><body><div id="app"><!--ssr-html--></div></body></html>');
  await writeFile(path.join(appRoot, '.vite', 'manifest.json'), JSON.stringify({ 'entry-client.ts': { file: 'assets/client.js' } }));
  await writeFile(path.join(appRoot, 'assets', 'client.js'), 'export const marker = "ssr-lifecycle";\n');
  await writeFile(path.join(ssrRoot, 'entry-server.js'), RENDER_MODULE);

  return { root, clientRoot };
};

const config = {
  apps: [
    {
      appId: 'ssr-lifecycle',
      entryPoint: 'app',
      renderer: testRenderer(),
      routes: [
        { path: PATHS.ok, attr: { render: 'ssr' as const } },
        // Built server-side rather than shipped in the fixture: the point is a body no socket
        // buffer can absorb, so the client is demonstrably still reading when it leaves.
        { path: PATHS.large, attr: { render: 'ssr' as const, data: async () => ({ blob: 'x'.repeat(LARGE_BYTES) }) } },
      ],
    },
  ],
} as never;

type Wire = { status: number; body: string; errored: string | null };

const read = (port: number, url: string, options: { abortAfterBytes?: number; slowRead?: boolean } = {}): Promise<Wire> =>
  new Promise((resolve) => {
    let body = '';
    let aborted = false;

    // `agent: false` - one socket per leg. A shared keep-alive socket carries one leg's reset into
    // the next leg's trace, which is exactly how a socket-based discriminator would be mismeasured.
    const request = http.get({ host: '127.0.0.1', port, path: url, agent: false }, (response) => {
      const settle = (errored: string | null) => resolve({ status: response.statusCode ?? 0, body, errored });

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;

        if (options.abortAfterBytes && body.length >= options.abortAfterBytes && !aborted) {
          aborted = true;
          request.destroy();
        }

        // A client slow enough to force the server to wait on backpressure, which is what makes the
        // large-body control a real control rather than a fast path that never stresses the socket.
        if (options.slowRead) {
          response.pause();
          setTimeout(() => response.resume(), 2);
        }
      });
      response.on('aborted', () => settle('aborted'));
      response.on('error', (error) => settle(String(error.message)));
      response.on('end', () => settle(null));
    });

    request.on('error', (error) => resolve({ status: 0, body, errored: String(error.message) }));
  });

/**
 * A client that HALF-CLOSES: it sends the request, FINs its own write side, and keeps reading to
 * the end. A raw socket is required - `http.request` will not half-close mid-exchange - and the
 * point is that a FIN is not a disconnect: the peer is still there, still reading.
 */
const halfCloseRead = (port: number, url: string): Promise<Wire> =>
  new Promise((resolve) => {
    let raw = '';
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });

    socket.setEncoding('utf8');
    // FIN only once the response has started, so the request is demonstrably in flight rather than
    // racing the server's parser.
    socket.once('data', () => socket.end());
    socket.on('data', (chunk) => {
      raw += chunk;
    });
    socket.on('error', (error) => resolve({ status: 0, body: raw, errored: String(error.message) }));
    socket.on('close', () => {
      const split = raw.indexOf('\r\n\r\n');
      const head = split === -1 ? raw : raw.slice(0, split);
      const body = split === -1 ? '' : raw.slice(split + 4);

      resolve({ status: Number(/^HTTP\/1\.\d (\d{3})/.exec(head)?.[1] ?? 0), body, errored: null });
    });
  });

type TerminalCall = { terminal: 'sent' | 'aborted' | 'failed'; event: Record<string, unknown> };
type Warning = { meta: Record<string, unknown>; message: string };

type Host = {
  port: number;
  introspection: ReturnType<typeof createDevIntrospection>;
  /** Terminal CALLS, so the latch is proved rather than the assembler's tolerance of a second one. */
  terminals: TerminalCall[];
  warnings: Warning[];
  close: () => Promise<void>;
};

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

const boot = async (): Promise<Host> => {
  const { root, clientRoot } = await fixture();
  const app: FastifyInstance = fastify({ logger: false });
  const introspection = createDevIntrospection({});
  const terminals: TerminalCall[] = [];
  const warnings: Warning[] = [];

  for (const terminal of ['sent', 'failed', 'aborted'] as const) {
    const original = introspection.recorder[terminal].bind(introspection.recorder);

    (introspection.recorder as unknown as Record<string, unknown>)[terminal] = (event: Record<string, unknown>) => {
      terminals.push({ terminal, event });

      return original(event as never);
    };
  }

  // An explicit logger is also what keeps the boot summaries out of the test output.
  const logger = {
    debug() {},
    info() {},
    warn(meta?: unknown, message?: string) {
      warnings.push({ meta: (meta ?? {}) as Record<string, unknown>, message: message ?? '' });
    },
    error() {},
  };

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

  const close = async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  };

  // Registered BEFORE anything that can throw, so a failure in `createServer` or `listen` cannot
  // leak the Fastify instance and the temp directory for the rest of the run.
  open.push(close);

  await createServer({ config, fastify: app, clientRoot, logger });
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();

  return { port: typeof address === 'object' && address !== null ? address.port : 0, introspection, terminals, warnings, close };
};

const episodesFor = (host: Host, url: string) => host.introspection.getEpisodes().filter((episode) => episode.url.pathname === url);

const disconnectWarningsFor = (host: Host, url: string): Warning[] =>
  host.warnings.filter((warning) => warning.message === DISCONNECT_WARNING && warning.meta.url === url);

describe('SSR response lifecycle: the terminal is the socket, not the handoff (real listener)', () => {
  it('11 (control): an ordinary SSR response read to completion records complete/200', { timeout: 30_000 }, async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.ok);

    expect(wire.status).toBe(200);
    expect(wire.body).toContain('<meta name="probe" content="ssr">');
    expect(wire.body).toContain('<main>ssr</main>');
    expect(wire.body).toContain('__INITIAL_DATA__');
    expect(wire.errored).toBeNull();

    await vi.waitFor(() => expect(episodesFor(host, PATHS.ok)).toHaveLength(1), { timeout: 5000 });

    const episode = episodesFor(host, PATHS.ok)[0]!;

    expect({ mode: episode.mode, outcome: episode.outcome, status: episode.status }).toEqual({ mode: 'ssr', outcome: 'complete', status: 200 });

    // The ordinary close that follows a delivered response must not reclassify it, and must not log
    // a disconnect. EVENT ORDERING plus the latch owns that - there is no `writableFinished` read.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(host.terminals.map((call) => call.terminal)).toEqual(['sent']);
    expect(disconnectWarningsFor(host, PATHS.ok)).toHaveLength(0);
    expect(episodesFor(host, PATHS.ok)[0]!.outcome).toBe('complete');
  });

  it('12 (the false-positive control): a 12 MiB body read to completion by a slow client stays complete', { timeout: 60_000 }, async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.large, { slowRead: true });

    // EXACT, not "most of it". This leg is the one that would break if the socket check were
    // over-eager: the same body and the same backpressure as the abandoned leg, but a client that
    // stays. A discriminator that cannot keep this `complete` is not a fix.
    expect(wire.status).toBe(200);
    expect(wire.errored).toBeNull();
    expect(wire.body.length).toBeGreaterThan(LARGE_BYTES);

    await vi.waitFor(() => expect(episodesFor(host, PATHS.large)).toHaveLength(1), { timeout: 15_000 });

    expect(episodesFor(host, PATHS.large)[0]!.outcome).toBe('complete');
    expect(host.terminals.map((call) => call.terminal)).toEqual(['sent']);
    expect(disconnectWarningsFor(host, PATHS.large)).toHaveLength(0);
  });

  it('13 (the defect): a client that RSTs mid-delivery records aborted, not complete', { timeout: 30_000 }, async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.large, { abortAfterBytes: ABORT_AFTER_BYTES });

    // PARTIAL DELIVERY, measured rather than assumed: the client got some of the page and then
    // left. This is the exact shape that used to be recorded as a successful 200.
    expect(wire.errored).not.toBeNull();
    expect(wire.body.length).toBeGreaterThanOrEqual(ABORT_AFTER_BYTES);
    expect(wire.body.length).toBeLessThan(LARGE_BYTES);

    await vi.waitFor(() => expect(episodesFor(host, PATHS.large)).toHaveLength(1), { timeout: 8000 });

    const episode = episodesFor(host, PATHS.large)[0]!;

    expect(episode.outcome).toBe('aborted');
    expect(episode.outcome).not.toBe('complete');

    // Stage preservation: the peer left after `reply.send()` handed off, so the phase is `send`.
    // The pre-render/render/post-render arms keep the phases they already record.
    expect(host.terminals.map((call) => call.terminal)).toEqual(['aborted']);
    expect(host.terminals[0]!.event).toMatchObject({ phase: 'send' });

    // The second half of the measured defect: the abandoned response produced no disconnect log at
    // all, so nothing in the record hinted at it.
    expect(disconnectWarningsFor(host, PATHS.large)).toHaveLength(1);

    // Nothing arrives later to reclassify it or to add a second terminal.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(host.terminals.map((call) => call.terminal)).toEqual(['aborted']);
    expect(episodesFor(host, PATHS.large)).toHaveLength(1);
    expect(episodesFor(host, PATHS.large)[0]!.outcome).toBe('aborted');
  });

  it('14 (the half-close control): a client that FINs its write side and reads on stays complete', { timeout: 30_000 }, async () => {
    const host = await boot();
    const wire = await halfCloseRead(host.port, PATHS.ok);

    // A FIN is not a disconnect. The peer has finished SENDING and is still reading, and it
    // receives the whole response - so classifying it as abandoned would be a false positive of
    // exactly the kind the socket check has to avoid.
    expect(wire.status).toBe(200);
    expect(wire.body).toContain('<main>ssr</main>');
    expect(wire.body).toContain('__INITIAL_DATA__');
    expect(wire.body.trimEnd().endsWith('</html>')).toBe(true);

    await vi.waitFor(() => expect(episodesFor(host, PATHS.ok)).toHaveLength(1), { timeout: 8000 });

    expect(episodesFor(host, PATHS.ok)[0]!.outcome).toBe('complete');
    expect(host.terminals.map((call) => call.terminal)).toEqual(['sent']);
    expect(disconnectWarningsFor(host, PATHS.ok)).toHaveLength(0);
  });
});
