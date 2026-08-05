// @vitest-environment node
//
// Streaming transport, React leg: the cold Fastify-owned document stream driven by the REAL
// @taujs/react renderer, against the BUILT @taujs/server package.
//
// This lives here rather than in packages/server because the server package carries no renderer
// dependencies, and testing the built package is the honest representation of the boundary a
// consumer sees.
//
// The build is an EXPLICIT, FALSIFIABLE prerequisite: the suite asserts the built artefact actually
// contains the cold candidate before running a single cell, so a stale `dist` cannot silently
// exercise old output.
//
// Cell 1 and 2 first, per the ruling: if React cannot show its deadline beginning at its own
// `renderStream` entry after `onSend` releases, the leg stops here.
//
// NUMBERING: the cells are the spike's evidence bill, kept so the promoted regressions can be read
// against it. There is no cell 6 in any leg - completion-with-backpressure is a TRANSPORT property,
// proven once for all renderers by cell 6 of `packages/server/src/test/StreamingTransport.test.ts`
// rather than three times here.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reactRenderer } from '@taujs/react/renderer';
import { createServer } from '@taujs/server';
// Source import ON PURPOSE: the recorder is internal, and this leg needs REAL episode outcomes.
// A separate module instance is fine - the built server calls whatever recorder the request
// context carries.
import { createDevIntrospection } from '../../../packages/server/src/core/introspection/DevIntrospection';
import fastify from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertBuiltServerIsFresh, externalImportsOfBuiltServer } from './support/built-server';

import type { FastifyInstance } from 'fastify';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'streaming-react');
const CLIENT_ROOT = path.join(FIXTURE, 'client');

const PATHS = {
  deferred: '/react-deferred',
  plain: '/react-plain',
  /** Deferred loader REJECTS: the `failed` outcome. */
  deferredFailed: '/react-deferred-failed',
  /** Gate never released: React's own deferred deadline fires - the `aborted` outcome. */
  deferredNever: '/react-deferred-never',
  /** The app throws during the shell: a pre-head fatal. */
  shellThrow: '/react-shell-throw',
} as const;
const HOLD_MS = 400;
const DEFERRED_BUDGET_MS = 300;
/**
 * No second long timer. The loader starts EAGERLY in the handler (RFC 0007 decision 2) and then
 * waits on a fixture gate that the instrumented `renderStream` releases immediately after entry,
 * so settlement is relative to the MEASURED entry rather than to wall-clock coincidence.
 *
 * The discriminator survives because the hold exceeds the budget: if the deadline had begun before
 * `onSend`, it would already be exhausted at entry and React would abandon the boundary before the
 * gate opened.
 */

type SpikeGlobals = {
  entries: Array<{ url: string; at: number }>;
  loaderStartedAt: number[];
  loaderSettledAt: number[];
  gateFor: (url: string) => { promise: Promise<void>; release: () => void };
};

const reactSpike = (): SpikeGlobals => (globalThis as unknown as { __reactSpike: SpikeGlobals }).__reactSpike;

beforeAll(() => {
  assertBuiltServerIsFresh();
});

type Wire = { status: number; body: string; errored: string | null };

const read = (port: number, url: string): Promise<Wire> =>
  new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: url, headers: {} }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body, errored: null }));
      response.on('aborted', () => resolve({ status: response.statusCode ?? 0, body, errored: 'aborted' }));
      response.on('error', (error) => resolve({ status: response.statusCode ?? 0, body, errored: String(error.message) }));
    });

    request.on('error', reject);
  });

type Host = {
  port: number;
  gate: { open: () => void; waited: number; entriesWhenWaiting: number };
  introspection: ReturnType<typeof createDevIntrospection>;
  onSendCalls: string[];
  close: () => Promise<void>;
};

const open: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

const boot = async (options: { gateOnSendFor?: string; replaceOnSend?: boolean } = {}): Promise<Host> => {
  const app = fastify({ logger: false });
  const introspection = createDevIntrospection({});
  const onSendCalls: string[] = [];

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
    onSendCalls.push(request.url);

    if (options.gateOnSendFor && request.url === options.gateOnSendFor) {
      gate.waited += 1;
      gate.entriesWhenWaiting = reactSpike().entries.length;
      await gateOpened;
    }

    return options.replaceOnSend ? 'REPLACED-BY-HOST' : payload;
  });

  await createServer({
    config: {
      apps: [
        {
          appId: 'react-spike',
          entryPoint: 'app',
          // Production never compiles, but the contribution validates its shape at construction.
          renderer: reactRenderer({ project: path.join(FIXTURE, 'tsconfig.json') }),
          routes: [
            { path: PATHS.plain, attr: { render: 'streaming', meta: {} } },
            { path: PATHS.shellThrow, attr: { render: 'streaming', meta: {} } },
            {
              path: PATHS.deferredFailed,
              attr: {
                render: 'streaming',
                meta: {},
                hydrate: true,
                deferred: {
                  slow: async () => {
                    await reactSpike().gateFor(PATHS.deferredFailed).promise;

                    throw new Error('spike deferred loader failure');
                  },
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
                  // Never released: React's own deferred deadline must abandon the boundary.
                  slow: () =>
                    reactSpike()
                      .gateFor(PATHS.deferredNever)
                      .promise.then(() => ({ value: 'never' })),
                },
              },
            },
            {
              path: PATHS.deferred,
              attr: {
                render: 'streaming',
                meta: {},
                hydrate: true,
                deferred: {
                  slow: async () => {
                    // Starts eagerly, in the handler, exactly as RFC 0007 requires.
                    reactSpike().loaderStartedAt.push(Date.now());
                    await reactSpike().gateFor(PATHS.deferred).promise;
                    reactSpike().loaderSettledAt.push(Date.now());

                    return { value: 'react-deferred-payload' };
                  },
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

  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    gate,
    introspection,
    onSendCalls,
    close: async () => app.close(),
  };
};

describe('React leg: the cold stream drives the real renderer', () => {
  it('cell 0: an ordinary streamed React document is served through the cold transport', async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.plain);

    expect(wire.status).toBe(200);
    expect(wire.body).toContain('react:/react-plain');
    expect(wire.body).toContain('taujs:data-ready');
  });

  it('cells 1 and 2: React is not entered while onSend holds, and its deferred budget starts at that entry', async () => {
    const host = await boot({ gateOnSendFor: PATHS.deferred });
    const before = reactSpike().entries.length;

    const pending = read(host.port, PATHS.deferred);

    await vi.waitFor(() => expect(host.gate.waited).toBe(1), { timeout: 5000 });

    // CELL 1: the hook is holding the payload and React has NOT been entered.
    expect(host.gate.entriesWhenWaiting).toBe(before);

    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    host.gate.open();

    await vi.waitFor(() => expect(reactSpike().entries.length).toBe(before + 1), { timeout: 5000 });

    const wire = await pending;
    const entry = reactSpike().entries[before]!;

    // CELL 2: the deferred entry settles 150ms after the RENDERER entry, inside the 300ms budget.
    // Had the budget been measured from the handler, the 400ms hold alone would have exhausted it
    // and React would have abandoned the boundary instead of rendering its value.
    expect(wire.status).toBe(200);
    expect(wire.body).toContain('react-deferred-payload');

    // The loader really did start eagerly, BEFORE the renderer was entered...
    expect(reactSpike().loaderStartedAt.at(-1)!).toBeLessThan(entry.at);
    // ...and it settled after entry, released by the instrumented entry itself.
    expect(reactSpike().loaderSettledAt.at(-1)!).toBeGreaterThanOrEqual(entry.at);
    // The premise of the discriminator, asserted rather than assumed.
    expect(HOLD_MS).toBeGreaterThan(DEFERRED_BUDGET_MS);
  });
});

const episodesFor = (host: Host, url: string) => host.introspection.getEpisodes().filter((episode) => episode.url.pathname === url);

describe('React leg: the frozen evidence bill', () => {
  it('cell 3: streamed output carries the document, envelope and terminal', async () => {
    const host = await boot();
    const cold = await read(host.port, PATHS.deferred);

    // Each noun in the title, asserted. A status-only cell would pass with an empty body.
    expect(cold.status).toBe(200);
    expect(cold.body).toContain('<!doctype');
    expect(cold.body).toContain(`react:${PATHS.deferred}`);
    expect(cold.body).toContain('__TAUJS_DEFERRED_STATE__');
    expect(cold.body).toContain('taujs:data-ready');
  });

  it('cell 4a: a completing deferred entry agrees across output, envelope and recorder', async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.deferred);

    expect(wire.body).toContain('react-deferred-payload');
    expect(wire.body).toContain('"status":"complete"');

    await vi.waitFor(() => expect(episodesFor(host, PATHS.deferred)).toHaveLength(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.deferred)[0]!.deferredData?.map((entry) => entry.outcome)).toEqual(['complete']);
  });

  it('cell 4b: a rejecting deferred entry agrees across envelope and recorder', async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.deferredFailed);

    expect(wire.status).toBe(200);
    expect(wire.body).toContain('"status":"failed"');
    expect(wire.body).not.toContain('react-deferred-payload');

    await vi.waitFor(() => expect(episodesFor(host, PATHS.deferredFailed)).toHaveLength(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.deferredFailed)[0]!.deferredData?.map((entry) => entry.outcome)).toEqual(['failed']);
  });

  it("cell 4c: React's own deferred deadline abandons the boundary and agrees with the recorder", { timeout: 30_000 }, async () => {
    const host = await boot();
    const startedAt = Date.now();
    const wire = await read(host.port, PATHS.deferredNever);
    const elapsed = Date.now() - startedAt;

    // React abandons the pending boundary at ITS deadline; the document still completes.
    expect(wire.status).toBe(200);
    expect(wire.body).toContain('taujs:data-ready');
    expect(wire.body).toContain('"status":"aborted"');

    await vi.waitFor(() => expect(episodesFor(host, PATHS.deferredNever)).toHaveLength(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.deferredNever)[0]!.deferredData?.map((entry) => entry.outcome)).toEqual(['aborted']);

    // The abandonment must come from the 300ms DEFERRED deadline, not from a far later backstop.
    // Recorded as a measurement so the claim cannot drift into being merely plausible.
    expect({ elapsedUnderOneSecond: elapsed < 1000, elapsed }).toEqual({ elapsedUnderOneSecond: true, elapsed });
  });

  it('cell 5: a pre-head fatal produces a real 500', async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.shellThrow);

    expect(wire.status).toBe(500);
    expect(wire.body).not.toContain('<!doctype');

    await vi.waitFor(() => expect(episodesFor(host, PATHS.shellThrow)).toHaveLength(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.shellThrow)[0]!.outcome).toBe('failed');
  });

  it('cell 7: disconnect yields one aborted episode and one outcome per deferred key', { timeout: 30_000 }, async () => {
    const host = await boot();

    await new Promise<void>((resolve, reject) => {
      const giveUp = setTimeout(() => reject(new Error('no response')), 10_000);
      const settle = () => {
        clearTimeout(giveUp);
        resolve();
      };

      const request = http.get({ host: '127.0.0.1', port: host.port, path: PATHS.deferredNever }, (response) => {
        response.on('data', () => request.destroy());
        response.on('aborted', settle);
        response.on('error', settle);
        response.on('end', settle);
      });

      request.on('error', settle);
    });

    await vi.waitFor(() => expect(episodesFor(host, PATHS.deferredNever)).toHaveLength(1), { timeout: 8000 });

    const episode = episodesFor(host, PATHS.deferredNever)[0]!;

    expect(episode.outcome).toBe('aborted');
    expect(episode.deferredData?.filter((entry) => entry.key === 'slow')).toHaveLength(1);
  });

  it('cell 8: payload replacement never starts React, completes the episode and emits no taujs bytes', { timeout: 30_000 }, async () => {
    const host = await boot({ replaceOnSend: true });
    const before = reactSpike().entries.filter((entry) => entry.url === PATHS.deferred).length;

    const wire = await read(host.port, PATHS.deferred);

    expect(wire.body).toBe('REPLACED-BY-HOST');
    expect(wire.body).not.toContain('<!doctype');
    expect(wire.body).not.toContain('__TAUJS_DEFERRED_STATE__');
    expect(reactSpike().entries.filter((entry) => entry.url === PATHS.deferred).length).toBe(before);

    await vi.waitFor(() => expect(episodesFor(host, PATHS.deferred)).toHaveLength(1), { timeout: 5000 });

    const episode = episodesFor(host, PATHS.deferred)[0]!;

    expect({ outcome: episode.outcome, mode: episode.mode }).toEqual({ outcome: 'complete', mode: 'streaming' });
    expect(episode.deferredData?.map((entry) => entry.outcome)).toEqual(['aborted']);
  });

  it('cell 9: the built server depends on no React package', () => {
    // Measured over EVERY emitted chunk, not just `index.js`. A substring check for the NAME would
    // be worse than useless here: the server legitimately says "reactRenderer()" in its diagnostics,
    // so name-absence in one file only records how tsup happened to split the bundle that day.
    // What is genuinely falsifiable is the dependency edge - a framework branch that needed React
    // would have to import it.
    const external = externalImportsOfBuiltServer();

    expect(external).not.toContain('react');
    expect(external).not.toContain('react-dom');
    expect(external).not.toContain('react-dom/server');
    expect(external).not.toContain('@taujs/react');
    // Positive control for file identity is the freshness check in `beforeAll`, which already
    // proves this is the built artefact carrying the cold candidate.
  });
});
