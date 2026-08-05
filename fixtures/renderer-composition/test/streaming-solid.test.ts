// @vitest-environment node
//
// Streaming transport, Solid leg: the cold Fastify-owned document stream driven by the REAL
// @taujs/solid renderer, against the BUILT @taujs/server.
//
// Solid's semantics are measured INDEPENDENTLY. React's fatal/recoverable taxonomy is not assumed
// here, and the deadline is configured through Solid's own public option shape.
//
// Mandatory precondition order, from the React leg's correction:
//   1. configure the deadline with this renderer's actual option shape;
//   2. prove the configured value is ACTIVE with a never-settling control;
//   3. only then run the held-onSend origin discriminator.
//
// NUMBERING: the cells are the spike's evidence bill, kept so the promoted regressions can be read
// against it. There is no cell 6 in any leg - completion-with-backpressure is a TRANSPORT property,
// proven once for all renderers by cell 6 of `packages/server/src/test/StreamingTransport.test.ts`
// rather than three times here.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '@taujs/server';
import { solidRenderer } from '@taujs/solid/renderer';
import fastify from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertBuiltServerIsFresh, externalImportsOfBuiltServer } from './support/built-server';

import { createDevIntrospection } from '../../../packages/server/src/core/introspection/DevIntrospection';

import type { FastifyInstance } from 'fastify';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'streaming-solid');
const CLIENT_ROOT = path.join(FIXTURE, 'client');

const PATHS = {
  plain: '/solid-plain',
  deferred: '/solid-deferred',
  deferredNever: '/solid-deferred-never',
  shellThrow: '/solid-shell-throw',
  /** Throws inside `headContent`, i.e. BEFORE `onHead`: the genuine pre-head fatal. */
  headThrow: '/solid-head-throw',
} as const;

const CONFIGURED_DEADLINE_MS = 300;
const HOLD_MS = 400;

type SolidGlobals = { entries: Array<{ url: string; at: number }>; gateFor: (url: string) => { promise: Promise<void>; release: () => void } };

const solidSpike = (): SolidGlobals => (globalThis as unknown as { __solidSpike: SolidGlobals }).__solidSpike;

beforeAll(() => {
  assertBuiltServerIsFresh();
});

type Wire = { status: number; body: string; errored: string | null };

const read = (port: number, url: string): Promise<Wire> =>
  new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: url, headers: {} }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body, errored: null }));
      response.on('aborted', () => resolve({ status: response.statusCode ?? 0, body, errored: 'aborted' }));
      response.on('error', (error) => resolve({ status: response.statusCode ?? 0, body, errored: String(error.message) }));
    });

    // A hang-up is an OUTCOME to compare, not a harness crash.
    request.on('error', (error) => resolve({ status: 0, body: '', errored: String(error.message) }));
  });

type Host = {
  port: number;
  gate: { open: () => void; waited: number; entriesWhenWaiting: number };
  introspection: ReturnType<typeof createDevIntrospection>;
  close: () => Promise<void>;
};

const open: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

const boot = async (options: { gateOnSendFor?: string; replaceOnSend?: boolean } = {}): Promise<Host> => {
  const app = fastify({ logger: false });
  const introspection = createDevIntrospection({});

  let release: () => void = () => {};
  const gateOpened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = { open: () => release(), waited: 0, entriesWhenWaiting: -1 };

  app.addHook('preHandler', (request, _reply, done) => {
    const context = (request as unknown as { taujsRequestContext?: { requestId: string; recorder?: unknown } }).taujsRequestContext;

    if (context) {
      context.recorder = introspection.recorder;
      introspection.recorder.requestStart({ requestId: context.requestId, url: request.url, method: request.method });
    }

    done();
  });

  app.addHook('onSend', async (request, _reply, payload) => {
    if (options.gateOnSendFor && request.url === options.gateOnSendFor) {
      gate.waited += 1;
      gate.entriesWhenWaiting = solidSpike().entries.length;
      await gateOpened;
    }

    return options.replaceOnSend ? 'REPLACED-BY-HOST' : payload;
  });

  await createServer({
    config: {
      apps: [
        {
          appId: 'solid-spike',
          entryPoint: 'app',
          renderer: solidRenderer({ project: path.join(FIXTURE, 'tsconfig.json') }),
          routes: [
            { path: PATHS.plain, attr: { render: 'streaming', meta: {} } },
            { path: PATHS.shellThrow, attr: { render: 'streaming', meta: {} } },
            { path: PATHS.headThrow, attr: { render: 'streaming', meta: {} } },
            {
              path: PATHS.deferred,
              attr: {
                render: 'streaming',
                meta: {},
                hydrate: true,
                deferred: {
                  slow: () =>
                    solidSpike()
                      .gateFor(PATHS.deferred)
                      .promise.then(() => ({ value: 'solid-deferred-payload' })),
                },
              },
            },
            {
              path: PATHS.deferredNever,
              attr: {
                render: 'streaming',
                meta: {},
                hydrate: true,
                deferred: {
                  slow: () =>
                    solidSpike()
                      .gateFor(PATHS.deferredNever)
                      .promise.then(() => ({ value: 'never' })),
                },
              },
            },
          ],
        },
      ],
    } as never,
    fastify: app,
    clientRoot: CLIENT_ROOT,
  });

  open.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();

  return { port: typeof address === 'object' && address !== null ? address.port : 0, gate, introspection, close: async () => app.close() };
};

const episodesFor = (host: Host, url: string) => host.introspection.getEpisodes().filter((episode) => episode.url.pathname === url);
describe('Solid leg: preconditions', () => {
  it('precondition: the CONFIGURED deferred deadline is active, not the renderer default', { timeout: 30_000 }, async () => {
    const host = await boot();
    const startedAt = Date.now();
    const wire = await read(host.port, PATHS.deferredNever);
    const elapsed = Date.now() - startedAt;

    expect(wire.status).toBe(200);
    // Near the configured value, nowhere near a multi-second default.
    expect({ nearConfigured: elapsed < CONFIGURED_DEADLINE_MS * 4, elapsed }).toEqual({ nearConfigured: true, elapsed });
  });

  it('cells 1 and 2: Solid is not entered while onSend holds, and its budget starts at that entry', { timeout: 30_000 }, async () => {
    const host = await boot({ gateOnSendFor: PATHS.deferred });
    const before = solidSpike().entries.length;

    const pending = read(host.port, PATHS.deferred);

    await vi.waitFor(() => expect(host.gate.waited).toBe(1), { timeout: 5000 });
    expect(host.gate.entriesWhenWaiting).toBe(before);

    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    host.gate.open();

    await vi.waitFor(() => expect(solidSpike().entries.length).toBe(before + 1), { timeout: 5000 });

    const wire = await pending;

    // The hold exceeds the configured budget, so a handler-origin deadline would have expired.
    expect(HOLD_MS).toBeGreaterThan(CONFIGURED_DEADLINE_MS);
    expect(wire.body).toContain('solid-deferred-payload');
  });
});

describe('Solid leg: the frozen evidence bill', () => {
  it('cell 0: an ordinary streamed Solid document with NO deferred data is delivered complete', async () => {
    const host = await boot();
    const cold = await read(host.port, PATHS.plain);

    // The baseline the deferred cells are read against. It was registered but never requested,
    // which left this leg without a no-deferred-data control.
    expect(cold.status).toBe(200);
    expect(cold.body).toContain('solid:/solid-plain');
    expect(cold.body).toContain('taujs:data-ready');
  });

  it('cell 3: a streamed Solid document carrying deferred data is delivered complete', async () => {
    const host = await boot();
    const cold = await read(host.port, PATHS.deferred);

    expect(cold.status).toBe(200);
    expect(cold.body).toContain('solid:/solid-deferred');
    expect(cold.body).toContain('taujs:data-ready');
  });

  it('cell 4: deferred outcomes agree across output, envelope and recorder', async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.deferred);

    expect(wire.body).toContain('solid-deferred-payload');
    expect(wire.body).toContain('"status":"complete"');

    await vi.waitFor(() => expect(episodesFor(host, PATHS.deferred)).toHaveLength(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.deferred)[0]!.deferredData?.map((entry) => entry.outcome)).toEqual(['complete']);
  });

  it("cell 4c: Solid's deadline document completes cleanly and carries its hydration seed", { timeout: 30_000 }, async () => {
    const host = await boot();
    const cold = await read(host.port, PATHS.deferredNever);

    // The deadline is the RENDERER's, and what it produces is renderer semantics: the transport
    // delivers whatever the renderer emits.
    expect(cold.status).toBe(200);

    await vi.waitFor(() => expect(episodesFor(host, PATHS.deferredNever).length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.deferredNever)[0]!.deferredData?.map((entry) => entry.outcome)).toEqual(['aborted']);

    // CHARACTERISATION, not a pass mark. What does the client actually receive at the deadline?
    expect({
      status: cold.status,
      cleanEnd: cold.errored === null,
      hasInitialData: cold.body.includes('__INITIAL_DATA__'),
      hasDeferredEnvelope: cold.body.includes('__TAUJS_DEFERRED_STATE__'),
      hasBootstrapScript: cold.body.includes('solid-client.js'),
      hasDataReadyEvent: cold.body.includes('taujs:data-ready'),
    }).toEqual({
      status: 200,
      // MEASURED, and materially different from Vue: Solid's deadline document COMPLETES cleanly
      // and carries its hydration seed. This is what the ruled contract expects.
      cleanEnd: true,
      hasInitialData: true,
      hasDeferredEnvelope: true,
      hasBootstrapScript: true,
      hasDataReadyEvent: true,
    });
  });

  it('cell 5a: a PRE-BYTE failure (headContent throws) produces a real 500', async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.headThrow);

    expect(wire.status).toBe(500);
    expect(wire.body).not.toContain('<!doctype');
    expect(wire.body).not.toContain('solid:');

    await vi.waitFor(() => expect(episodesFor(host, PATHS.headThrow)).toHaveLength(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.headThrow)[0]!.outcome).toBe('failed');
  });

  it("cell 5b: a component throw is a PRE-COMMIT fatal in SOLID's model, and yields a real 500", async () => {
    const host = await boot();
    const cold = await read(host.port, PATHS.shellThrow);

    // MEASURED: unlike Vue, Solid does not publish a head before its component work fails, so the
    // failure is still PRE-COMMIT and the honest answer is a real 500. Not forced into React's or
    // Vue's taxonomy - this is Solid's own boundary.
    expect(cold.status).toBe(500);
    expect(cold.body).not.toContain('<!doctype');

    await vi.waitFor(() => expect(episodesFor(host, PATHS.shellThrow).length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.shellThrow)[0]!.outcome).toBe('failed');
  });

  it('cell 7: disconnect yields one aborted episode and one outcome per deferred key', { timeout: 30_000 }, async () => {
    const host = await boot();

    await new Promise<void>((resolve) => {
      const request = http.get({ host: '127.0.0.1', port: host.port, path: PATHS.deferredNever }, (response) => {
        response.on('data', () => request.destroy());
        response.on('aborted', () => resolve());
        response.on('error', () => resolve());
        response.on('end', () => resolve());
      });

      request.on('error', () => resolve());
    });

    await vi.waitFor(() => expect(episodesFor(host, PATHS.deferredNever)).toHaveLength(1), { timeout: 8000 });

    const episode = episodesFor(host, PATHS.deferredNever)[0]!;

    expect(episode.outcome).toBe('aborted');
    expect(episode.deferredData?.filter((entry) => entry.key === 'slow')).toHaveLength(1);
  });

  it('cell 8: payload replacement never starts Solid and completes the episode', { timeout: 30_000 }, async () => {
    const host = await boot({ replaceOnSend: true });
    const before = solidSpike().entries.filter((entry) => entry.url === PATHS.deferred).length;

    const wire = await read(host.port, PATHS.deferred);

    expect(wire.body).toBe('REPLACED-BY-HOST');
    expect(wire.body).not.toContain('__TAUJS_DEFERRED_STATE__');
    expect(solidSpike().entries.filter((entry) => entry.url === PATHS.deferred).length).toBe(before);

    await vi.waitFor(() => expect(episodesFor(host, PATHS.deferred)).toHaveLength(1), { timeout: 5000 });

    const episode = episodesFor(host, PATHS.deferred)[0]!;

    expect({ outcome: episode.outcome, mode: episode.mode }).toEqual({ outcome: 'complete', mode: 'streaming' });
    expect(episode.deferredData?.map((entry) => entry.outcome)).toEqual(['aborted']);
  });

  it('cell 9: the built server depends on no Solid package', () => {
    // Measured over EVERY emitted chunk, not just `index.js`. A substring check for the NAME would
    // be worse than useless here: the server legitimately says "solidRenderer()" in its diagnostics,
    // so name-absence in one file only records how tsup happened to split the bundle that day.
    // What is genuinely falsifiable is the dependency edge - a framework branch that needed Solid
    // would have to import it.
    const external = externalImportsOfBuiltServer();

    expect(external).not.toContain('solid-js');
    expect(external).not.toContain('solid-js/web');
    expect(external).not.toContain('@taujs/solid');
  });
});
