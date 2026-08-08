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

import { CALLER_CSP, OWNER, PATHS, closeAll, developmentFixture, observe, productionFixture, taujsConfig } from './support/hostOwnership';

import type { FastifyInstance } from 'fastify';

const viteInstrument = vi.hoisted(() => ({ closeCount: 0 }));
const graphInstrument = vi.hoisted(() => ({ registrations: 0 }));
const introspectionInstrument = vi.hoisted(() => ({ instances: [] as unknown[] }));

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

// Wrapped, never replaced (same convention as the Vite mock): the SC-09 recorder-key evidence
// needs the LIVE introspection instance a real development boot creates, because the caller-owned
// scope decoration is not visible from the root app.
vi.mock('../core/introspection/DevIntrospection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/introspection/DevIntrospection')>();

  return {
    ...actual,
    createDevIntrospection: (...args: Parameters<typeof actual.createDevIntrospection>) => {
      const instance = actual.createDevIntrospection(...args);
      introspectionInstrument.instances.push(instance);

      return instance;
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

  return { status: seen.status, body: seen.body, type: seen.type, csp: seen.csp, requestId: seen.requestId };
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

      // SC-09 recorder-key evidence, supplied-host leg: the live introspection instance holds an
      // episode keyed by exactly the response's canonical x-request-id.
      const introspection = introspectionInstrument.instances.at(-1) as { findEpisode: (id: string) => { url: { pathname: string } } | undefined };
      expect(introspection).toBeTruthy();
      const episode = introspection.findEpisode(page.requestId!);
      expect(episode).toBeTruthy();
      expect(episode!.url.pathname).toBe(PATHS.taujsPage);
    } finally {
      process.chdir(cwd);
      // Gate 7: not swallowed - a close failure must fail the test, not disappear.
      await app.close();
    }

    expect(viteInstrument.closeCount - closesBefore).toBe(1);
  }, 30_000);
});

describe('SC-09 - τjs-created development host', () => {
  it('adopts a valid inbound x-request-id at construction and keys the recorder episode with it', async () => {
    const { root, clientRoot } = await developmentFixture();
    const cwd = process.cwd();
    process.chdir(root);
    let app: FastifyInstance | undefined;

    try {
      const createServer = await loadDevelopmentCreateServer();
      const result = await createServer({ config: taujsConfig(), clientRoot, projectRoot: root, debug: ['ssr'] });
      app = result.app;

      const inbound = 'sc09-dev-created-adopt-1';
      const page = observe(await app!.inject({ method: 'GET', url: PATHS.taujsPage, headers: { 'x-request-id': inbound } }));

      // Construction-time adoption: the inbound value IS req.id, so it is the identity everywhere.
      expect(page.status).toBe(200);
      expect(page.requestId).toBe(inbound);

      // Recorder-key evidence, created-host leg: the episode is keyed by that same identity.
      const introspection = introspectionInstrument.instances.at(-1) as { findEpisode: (id: string) => { url: { pathname: string } } | undefined };
      const episode = introspection.findEpisode(inbound);
      expect(episode).toBeTruthy();
      expect(episode!.url.pathname).toBe(PATHS.taujsPage);
    } finally {
      process.chdir(cwd);
      await app?.close();
    }
  }, 30_000);
});

// RFC 0013: the attached HMR transport is a MODE-A facility. These cells run the PRODUCT PATH
// (createServer), not the resolver helper, because the contract is "reject BEFORE mutation" -
// a later move or mis-threading of the helper call would silently break that, and a
// helper-only test would stay green.
describe('RFC 0013 - attached transport and host ownership (product path)', () => {
  const attachedConfig = () => {
    const config = taujsConfig() as any;
    config.server = { ...(config.server ?? {}), hmrTransport: 'attached' };

    return config;
  };

  it('DEVELOPMENT mode B: rejects, and the caller host is left untouched', async () => {
    const { root, clientRoot } = await developmentFixture();
    const app = buildCallerHost();
    await app.ready();

    // Inventory BEFORE: what the caller owns on its own server.
    const upgradeBefore = app.server.listenerCount('upgrade');
    const routesBefore = app.printRoutes();

    process.chdir(root);
    try {
      const createServer = await loadDevelopmentCreateServer();

      await expect(createServer({ config: attachedConfig(), fastify: app, clientRoot, projectRoot: root })).rejects.toThrow(
        /requires a τjs-created Fastify host/,
      );

      // Rejected BEFORE mutation: no upgrade listener installed, no routes registered.
      expect(app.server.listenerCount('upgrade')).toBe(upgradeBefore);
      expect(app.printRoutes()).toBe(routesBefore);
    } finally {
      await app.close();
    }
  });

  it('PRODUCTION mode B: the same configuration completes createServer - the option is inert', async () => {
    // A real production fixture (built manifests), so completion is genuine rather than
    // masked by an unrelated asset failure.
    const clientRoot = await productionFixture();
    const app = buildCallerHost();
    // Self-contained cwd. Earlier cells chdir into temp fixtures that their cleanup then
    // deletes, so even READING `process.cwd()` here can throw `uv_cwd` - move to a directory
    // known to exist before anything else, and never ask where we were.
    process.chdir(path.dirname(clientRoot));

    // Production installs no HMR facility, so a mode-B deployment sharing ONE configuration
    // file must still boot rather than being refused for a development-only option.
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    vi.resetModules();

    try {
      const { createServer } = await import('../CreateServer');
      await expect(createServer({ config: attachedConfig(), fastify: app, clientRoot })).resolves.toBeDefined();
    } finally {
      process.env.NODE_ENV = original;
      await app.close();
    }
  });
});
