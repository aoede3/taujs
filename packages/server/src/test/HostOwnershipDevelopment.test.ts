// @vitest-environment node
//
// RFC 0010 development ownership regressions: gates 3, 5 and 7 of the implementation plan.
//
// One real development boot proves the whole seam, because a real Vite server is expensive and the
// assertions all depend on the same running host:
//
//   - the single caller-root Vite hook serves URLs Fastify did not route;
//   - a caller route is unchanged by τjs being present;
//   - boot-graph emission registers once inside the owned scope and reaches its terminal after a
//     real `listen()`;
//   - `app.close()` closes the real Vite server exactly once.
//
// Vite and the graph emitter are wrapped, never replaced: both call through to the real
// implementation so the lifecycle assertions cannot pass vacuously.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CALLER_CSP, OWNER, PATHS, closeAll, developmentFixture, observe, taujsConfig } from './support/hostOwnership';

import type { FastifyInstance } from 'fastify';

const viteInstrument = vi.hoisted(() => ({ closeCount: 0 }));
const graphInstrument = vi.hoisted(() => ({ registrations: 0 }));

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vite')>();

  return {
    ...actual,
    // Wraps the REAL server so close counting measures real teardown.
    createServer: async (...args: Parameters<typeof actual.createServer>) => {
      const server = await actual.createServer(...args);
      const close = server.close.bind(server);

      server.close = async () => {
        viteInstrument.closeCount += 1;

        return close();
      };

      return server;
    },
  };
});

vi.mock('../core/introspection/EmitGraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/introspection/EmitGraph')>();

  return {
    ...actual,
    registerBootGraphEmission: (...args: Parameters<typeof actual.registerBootGraphEmission>) => {
      graphInstrument.registrations += 1;
      actual.registerBootGraphEmission(...args);
      // Registered immediately after the real emitter, so awaiting this resolves only once the
      // graph hook itself has completed. Sampling when `listen()` resolves would be premature.
      args[0].addHook('onListen', async () => {
        graphTerminal.resolve();
      });
    },
  };
});

let graphTerminal: { promise: Promise<void>; resolve: () => void };
const freshTerminal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });

  graphTerminal = { promise, resolve };
};
freshTerminal();

const loadDevelopmentCreateServer = async () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  vi.resetModules();

  try {
    return (await import('../CreateServer')).createServer;
  } finally {
    process.env.NODE_ENV = original;
  }
};

const buildCallerHost = (): FastifyInstance => {
  const app = fastify({ logger: false });

  app.decorate('authenticate', async () => undefined);
  app.addHook('onRequest', (_request, reply, done) => {
    reply.header('Content-Security-Policy', CALLER_CSP);
    done();
  });
  app.get(PATHS.callerBefore, async () => ({ owner: OWNER.callerBefore }));
  app.setNotFoundHandler(async (_request, reply) => reply.status(404).type('application/json').send({ owner: OWNER.callerNotFound }));

  return app;
};

/** The plan's frozen comparison fields. Volatile headers are excluded deliberately. */
const frozen = (response: Parameters<typeof observe>[0]) => {
  const seen = observe(response);

  return { status: seen.status, body: seen.body, type: seen.type, csp: seen.csp, traceId: seen.traceId };
};

afterEach(async () => {
  await closeAll();
});

describe('RFC 0010 - caller-owned development host', () => {
  it('serves Vite, leaves caller routes untouched, emits the graph once and closes Vite once', async () => {
    const cwd = process.cwd();
    const { root, clientRoot } = await developmentFixture();
    const closesBefore = viteInstrument.closeCount;
    const registrationsBefore = graphInstrument.registrations;

    freshTerminal();

    // Control: the same caller host with τjs absent, for the frozen-field comparison.
    const control = buildCallerHost();
    await control.ready();
    const controlRoute = frozen(await control.inject(PATHS.callerBefore));
    await control.close();

    const app = buildCallerHost();
    process.chdir(root);

    try {
      const createServer = await loadDevelopmentCreateServer();
      await createServer({ config: taujsConfig(), fastify: app, clientRoot, projectRoot: root, debug: ['ssr'] });

      // Gate 5: a real listener, then wait for the emission terminal rather than for listen().
      await app.listen({ host: '127.0.0.1', port: 0 });
      await graphTerminal.promise;

      expect(graphInstrument.registrations - registrationsBefore).toBe(1);

      const graphPath = path.resolve(root, 'node_modules', '.taujs', 'graph.json');
      expect(existsSync(graphPath)).toBe(true);
      expect(JSON.parse(await readFile(graphPath, 'utf8'))).toMatchObject({ source: 'boot' });

      // Gate 3a: the single caller-root hook reaches a URL Fastify routed nowhere, and Vite answers
      // with its actual client module rather than merely a 200.
      const viteClient = await app.inject('/@vite/client');
      expect(viteClient.statusCode).toBe(200);
      expect(viteClient.headers['content-type']).toContain('javascript');
      expect(viteClient.body).toMatch(/createHotContext|__vite__|HMRClient/);

      // Gate 3b: the caller's own route is behaviourally equivalent to τjs being absent, compared on
      // the frozen fields. Not literal byte identity: volatile headers are excluded deliberately,
      // because request IDs and runtime metadata would make this flaky without indicating leakage.
      expect(frozen(await app.inject(PATHS.callerBefore))).toEqual(controlRoute);

      // ...while τjs still owns its declared page.
      const page = observe(await app.inject(PATHS.taujsPage));
      expect(page.status).toBe(200);
      expect(page.body).toContain(OWNER.taujsPage);
    } finally {
      process.chdir(cwd);
      // Gate 7: not swallowed - a close failure must fail the test, not disappear.
      await app.close();
    }

    expect(viteInstrument.closeCount - closesBefore).toBe(1);
  }, 30_000);
});
