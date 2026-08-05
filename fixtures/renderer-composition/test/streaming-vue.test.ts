// @vitest-environment node
//
// Streaming transport, Vue leg: the cold Fastify-owned document stream driven by the REAL
// @taujs/vue renderer, against the BUILT @taujs/server.
//
// Vue's semantics are measured INDEPENDENTLY. React's fatal/recoverable taxonomy is not assumed
// here, and the deadline is configured through Vue's own public option shape.
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
import { vueRenderer } from '@taujs/vue/renderer';
import fastify from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertBuiltServerIsFresh, externalImportsOfBuiltServer } from './support/built-server';

import { createDevIntrospection } from '../../../packages/server/src/core/introspection/DevIntrospection';

import type { FastifyInstance } from 'fastify';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'streaming-vue');
const CLIENT_ROOT = path.join(FIXTURE, 'client');

const PATHS = {
  plain: '/vue-plain',
  deferred: '/vue-deferred',
  deferredNever: '/vue-deferred-never',
  shellThrow: '/vue-shell-throw',
  /** Throws inside `headContent`, i.e. BEFORE `onHead`: the genuine pre-head fatal. */
  headThrow: '/vue-head-throw',
  /** Same never-settling entry, read through the THROWING accessor instead of the result one. */
  deferredNeverThrowing: '/vue-deferred-never-throwing',
} as const;

const CONFIGURED_DEADLINE_MS = 300;
const HOLD_MS = 400;

type VueGlobals = { entries: Array<{ url: string; at: number }>; gateFor: (url: string) => { promise: Promise<void>; release: () => void } };

const vueSpike = (): VueGlobals => (globalThis as unknown as { __vueSpike: VueGlobals }).__vueSpike;

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
      gate.entriesWhenWaiting = vueSpike().entries.length;
      await gateOpened;
    }

    return options.replaceOnSend ? 'REPLACED-BY-HOST' : payload;
  });

  await createServer({
    config: {
      apps: [
        {
          appId: 'vue-spike',
          entryPoint: 'app',
          renderer: vueRenderer(),
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
                    vueSpike()
                      .gateFor(PATHS.deferred)
                      .promise.then(() => ({ value: 'vue-deferred-payload' })),
                },
              },
            },
            {
              path: PATHS.deferredNeverThrowing,
              attr: {
                render: 'streaming',
                meta: {},
                hydrate: true,
                deferred: {
                  slow: () =>
                    vueSpike()
                      .gateFor(PATHS.deferredNeverThrowing)
                      .promise.then(() => ({ value: 'never' })),
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
                    vueSpike()
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
describe('Vue leg: preconditions', () => {
  it('precondition: the CONFIGURED deferred deadline is active, not the renderer default', { timeout: 30_000 }, async () => {
    const host = await boot();
    const startedAt = Date.now();
    const wire = await read(host.port, PATHS.deferredNever);
    const elapsed = Date.now() - startedAt;

    expect(wire.status).toBe(200);
    // Near the configured value, nowhere near a multi-second default.
    expect({ nearConfigured: elapsed < CONFIGURED_DEADLINE_MS * 4, elapsed }).toEqual({ nearConfigured: true, elapsed });
  });

  it('cells 1 and 2: Vue is not entered while onSend holds, and its budget starts at that entry', { timeout: 30_000 }, async () => {
    const host = await boot({ gateOnSendFor: PATHS.deferred });
    const before = vueSpike().entries.length;

    const pending = read(host.port, PATHS.deferred);

    await vi.waitFor(() => expect(host.gate.waited).toBe(1), { timeout: 5000 });
    expect(host.gate.entriesWhenWaiting).toBe(before);

    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    host.gate.open();

    await vi.waitFor(() => expect(vueSpike().entries.length).toBe(before + 1), { timeout: 5000 });

    const wire = await pending;

    // The hold exceeds the configured budget, so a handler-origin deadline would have expired.
    expect(HOLD_MS).toBeGreaterThan(CONFIGURED_DEADLINE_MS);
    expect(wire.body).toContain('vue-deferred-payload');
  });
});

describe('Vue leg: the frozen evidence bill', () => {
  it('cell 0: an ordinary streamed Vue document with NO deferred data is delivered complete', async () => {
    const host = await boot();
    const cold = await read(host.port, PATHS.plain);

    // The baseline the deferred cells are read against. It was registered but never requested,
    // which left this leg without a no-deferred-data control.
    expect(cold.status).toBe(200);
    expect(cold.body).toContain('vue:/vue-plain');
    expect(cold.body).toContain('taujs:data-ready');
  });

  it('cell 3: a streamed Vue document carrying deferred data is delivered complete', async () => {
    const host = await boot();
    const cold = await read(host.port, PATHS.deferred);

    expect(cold.status).toBe(200);
    expect(cold.body).toContain('vue:/vue-deferred');
    expect(cold.body).toContain('taujs:data-ready');
  });

  it('cell 4: deferred outcomes agree across output, envelope and recorder', async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.deferred);

    expect(wire.body).toContain('vue-deferred-payload');
    expect(wire.body).toContain('"status":"complete"');

    await vi.waitFor(() => expect(episodesFor(host, PATHS.deferred)).toHaveLength(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.deferred)[0]!.deferredData?.map((entry) => entry.outcome)).toEqual(['complete']);
  });

  it("cell 4c: Vue's deadline document is COMPLETE and hydratable through the documented accessor", { timeout: 30_000 }, async () => {
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
      hasBootstrapScript: cold.body.includes('vue-client.js'),
      hasDataReadyEvent: cold.body.includes('taujs:data-ready'),
    }).toEqual({
      // The ruled expectation, met: abandon the pending read, render the aborted branch, and
      // COMPLETE the document with its hydration seed intact.
      status: 200,
      cleanEnd: true,
      hasInitialData: true,
      hasDeferredEnvelope: true,
      hasBootstrapScript: true,
      hasDataReadyEvent: true,
    });
  });

  it('SHARP EDGE: the THROWING read at the deadline aborts the transfer, as its documented native semantics', { timeout: 30_000 }, async () => {
    const host = await boot();
    const cold = await read(host.port, PATHS.deferredNeverThrowing);

    // `useDeferredData` is the throwing read; Vue's own source warns it cannot substitute fallback
    // UI in SSR. At the deadline the rejection ends the transfer with no seed at all. Recorded as
    // observed here as renderer semantics rather than a transport property.
    expect(cold.body).not.toContain('__INITIAL_DATA__');
    expect(cold.body).not.toContain('taujs:data-ready');

    expect(cold.status).toBe(200);
    expect(cold.errored).not.toBeNull();

    // The recorder must still classify it. Every other terminal cell in this leg asserts the
    // episode, and a sharp edge is exactly where an unclassified response would hide.
    await vi.waitFor(() => expect(episodesFor(host, PATHS.deferredNeverThrowing).length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.deferredNeverThrowing)[0]!.outcome).toBe('failed');
  });

  it('cell 5a: a PRE-HEAD failure (headContent throws) produces a real 500 through the cold path', async () => {
    const host = await boot();
    const wire = await read(host.port, PATHS.headThrow);

    expect(wire.status).toBe(500);
    expect(wire.body).not.toContain('<!doctype');
    expect(wire.body).not.toContain('vue:');

    await vi.waitFor(() => expect(episodesFor(host, PATHS.headThrow)).toHaveLength(1), { timeout: 5000 });
    expect(episodesFor(host, PATHS.headThrow)[0]!.outcome).toBe('failed');
  });

  it('cell 5b: a component throw AFTER the head is still pre-byte, and produces a real 500', async () => {
    const host = await boot();
    const cold = await read(host.port, PATHS.shellThrow);

    // Vue calls `onHead` BEFORE it renders a component byte, so this throw happens after the head.
    // That is NOT commitment: publishing a head resolves the shell inside the host, and the shell
    // only reaches Fastify when the cold document resumes and yields it. Vue throws first, so no
    // byte ever left the process.
    //
    // Under the frozen byte contract - commitment is the first byte YIELDED TO FASTIFY - this stays
    // a pre-byte failure and can still become a real 500. Deliberately not described as
    // "post-commit" or "post-byte": those named the OLD transport, where publishing a head entered
    // raw-socket commitment.
    expect(cold.status).toBe(500);
    expect(cold.body).not.toContain('<!doctype');
    expect(cold.body).not.toContain('vue:');
    expect(cold.body).not.toContain('taujs:data-ready');

    await vi.waitFor(() => expect(episodesFor(host, PATHS.shellThrow).length).toBeGreaterThanOrEqual(1), { timeout: 5000 });

    const episode = episodesFor(host, PATHS.shellThrow)[0]!;

    expect(episode.outcome).toBe('failed');
    // PROVENANCE: Vue's own error, not a placeholder the transport substituted.
    expect(episode.error?.message).toContain('vue shell failure');
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

  it('cell 8: payload replacement never starts Vue and completes the episode', { timeout: 30_000 }, async () => {
    const host = await boot({ replaceOnSend: true });
    const before = vueSpike().entries.filter((entry) => entry.url === PATHS.deferred).length;

    const wire = await read(host.port, PATHS.deferred);

    expect(wire.body).toBe('REPLACED-BY-HOST');
    expect(wire.body).not.toContain('__TAUJS_DEFERRED_STATE__');
    expect(vueSpike().entries.filter((entry) => entry.url === PATHS.deferred).length).toBe(before);

    await vi.waitFor(() => expect(episodesFor(host, PATHS.deferred)).toHaveLength(1), { timeout: 5000 });

    const episode = episodesFor(host, PATHS.deferred)[0]!;

    expect({ outcome: episode.outcome, mode: episode.mode }).toEqual({ outcome: 'complete', mode: 'streaming' });
    expect(episode.deferredData?.map((entry) => entry.outcome)).toEqual(['aborted']);
  });

  it('cell 9: the built server depends on no Vue package', () => {
    // Measured over EVERY emitted chunk, not just `index.js`. A substring check for the NAME would
    // be worse than useless here: the server legitimately says "vueRenderer()" in its diagnostics,
    // so name-absence in one file only records how tsup happened to split the bundle that day.
    // What is genuinely falsifiable is the dependency edge - a framework branch that needed Vue
    // would have to import it.
    const external = externalImportsOfBuiltServer();

    expect(external).not.toContain('vue');
    expect(external).not.toContain('@vue/server-renderer');
    expect(external).not.toContain('@taujs/vue');
  });
});
