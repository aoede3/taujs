// @vitest-environment node
//
// RFC 0018: host-route attribution. Every cell here runs against a REAL Fastify instance
// (`fastify.inject`) and a REAL `createDevIntrospection` - no recorder or channel mock. Titles
// state the claim each cell proves.

import diagnostics_channel from 'node:diagnostics_channel';

import fastify from 'fastify';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { defineService, defineServiceRegistry, callServiceMethod } from '../../services/DataServices';
import { fastifyConfigForRoute } from '../../routes/FastifyRoutes';
import { createRequestContext } from '../../../utils/Telemetry';
import { createDevIntrospection } from '../DevIntrospection';
import { acquire, release, acquisitionCountForTests } from '../HostAttribution';
import { createServer } from '../../../CreateServer';
import { developmentFixture, disposeFixtures } from '../../../test/support/hostOwnership';
import { testRenderer } from '../../../test/support/renderer';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logs } from '../../logging/types';
import type { ServiceRegistry } from '../../services/DataServices';
import type { DevIntrospection } from '../DevIntrospection';
import type { TaujsConfig } from '../../../Config';

// --- test-only plumbing --------------------------------------------------------------------

const CHANNEL_NAME = 'fastify.request.handler';
const startChannel = () => diagnostics_channel.tracingChannel(CHANNEL_NAME).start;

// Node's `Channel` methods are prototype-inherited until first use, at which point Node itself
// assigns an "active" own-property replacement (`markActive`). Restoring a patched method by
// reassigning a reference captured earlier - rather than deleting the own property back to the
// prototype - re-enters that self-mutating state machine wrongly and corrupts it (observed:
// infinite recursion in `Channel.bindStore`, or a `bindStore` that silently never attaches
// afterward). Every patch in this suite goes through this helper so restoration is always by
// presence, never by a stale captured reference.
const patchMethod = <T extends object, K extends keyof T>(obj: T, key: K, replacement: T[K] | undefined): (() => void) => {
  const hadOwn = Object.prototype.hasOwnProperty.call(obj, key);
  const saved = obj[key];
  obj[key] = replacement as T[K];
  return () => {
    if (hadOwn) obj[key] = saved;
    else delete (obj as Record<string, unknown>)[key as string];
  };
};

const mkLogger = (): { logger: Logs; warns: { meta: unknown; msg: string }[] } => {
  const warns: { meta: unknown; msg: string }[] = [];
  const logger: Logs = {
    debug: () => {},
    info: () => {},
    error: () => {},
    warn: (meta?: unknown, msg?: string) => {
      warns.push({ meta, msg: msg ?? '' });
    },
    child: () => logger,
    isDebugEnabled: () => false,
  };
  return { logger, warns };
};

type Gate = { promise: Promise<void>; resolve: () => void };
const makeGate = (): Gate => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A fresh registry per test - the acquire/release WeakMaps are keyed on this object, so reusing
// one across tests would leak ambiguity/acquisition state between cells.
const buildRegistry = (gates: Record<string, Gate> = {}): ServiceRegistry =>
  defineServiceRegistry({
    demo: defineService({
      ok: async (_p: {}) => ({ ok: true }),
      waitFor: async (p: { key: string }) => {
        await gates[p.key]!.promise;
        return { done: true };
      },
    }),
  });

const noopLogger: Logs = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
  isDebugEnabled: () => false,
};

// Mirrors SSRServer.ts's own request-context onRequest hook (claim BEFORE requestStart, recorder
// left unset on a failed claim) - the real seam this RFC's ambient path decides against.
const installPageHook = (app: FastifyInstance, dev: DevIntrospection): void => {
  app.decorateRequest('taujsRequestContext', null);
  app.addHook('onRequest', async (req, reply) => {
    const ctx = createRequestContext(req, reply, noopLogger);
    if (dev.claimRequest(ctx.requestId, req)) ctx.recorder = dev.recorder;
    (req as unknown as { taujsRequestContext: typeof ctx }).taujsRequestContext = ctx;
    ctx.recorder?.requestStart({ requestId: ctx.requestId, url: req.url, method: req.method });
  });
};

// Registers a route carrying τjs's own route-identity marker, exactly as SSRServer.ts's route
// loop does - the fact `selectedRouteFrom` reads to decide Case A.
const taujsPageRoute = (app: FastifyInstance, path: string, appId: string, handler: (req: FastifyRequest, reply: FastifyReply) => unknown): void => {
  app.get(path, { config: fastifyConfigForRoute({ path, appId }) } as never, handler);
};

type Harness = { app: FastifyInstance; dev: DevIntrospection; registry: ServiceRegistry; logger: Logs; warns: { meta: unknown; msg: string }[] };
const harnesses: { app: FastifyInstance; dev: DevIntrospection; registry: ServiceRegistry }[] = [];

// installPageHook=false builds a genuinely caller-owned instance - no τjs presence at all, the
// real shape of Wolf's own Fastify app sharing a governed registry.
const buildHarness = (opts?: { installPageHook?: boolean; registry?: ServiceRegistry }): Harness => {
  const { logger, warns } = mkLogger();
  const dev = createDevIntrospection({ logger });
  const registry = opts?.registry ?? buildRegistry();
  const app = fastify();
  if (opts?.installPageHook ?? true) installPageHook(app, dev);
  acquire(registry, dev, logger);
  harnesses.push({ app, dev, registry });
  return { app, dev, registry, logger, warns };
};

afterEach(async () => {
  while (harnesses.length) {
    const h = harnesses.pop()!;
    release(h.registry, h.dev);
    await h.app.close();
  }
});

// ---------------------------------------------------------------------------------------------

describe('the motivating shape: a host route registered before the introspecting server exists', () => {
  it('POST with a JSON body in a child plugin registered under a prefix, before acquire(), is attributed with the full prefixed path and request.method', async () => {
    const { logger } = mkLogger();
    const registry = buildRegistry();
    const dev = createDevIntrospection({ logger });
    const app = fastify();

    // Registered BEFORE the introspecting server ever acquires the binding - order-independence
    // is the whole point of the tracing-channel seam (RFC 0018 Design step 1).
    await app.register(
      async (child) => {
        child.post('/child/:x', async (req) => {
          const body = req.body as { a: number };
          return callServiceMethod(registry, 'demo', 'ok', { a: body.a }, {});
        });
      },
      { prefix: '/api' },
    );

    acquire(registry, dev, logger);
    harnesses.push({ app, dev, registry });

    const res = await app.inject({ method: 'POST', url: '/api/child/42', payload: { a: 1 } });
    expect(res.statusCode).toBe(200);

    const episodes = dev.getEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ kind: 'host', route: '/api/child/:x', method: 'POST', outcome: 'complete', status: 200 });
    expect(episodes[0]!.serviceCalls).toEqual([{ service: 'demo', method: 'ok', ms: expect.any(Number), ok: true }]);
  });
});

describe('one episode per request; τjs-created host with routes added later', () => {
  it('a host handler making three sequential callServiceMethod calls produces one episode with three serviceCalls entries', async () => {
    const { app, dev, registry } = buildHarness({ installPageHook: false });

    app.post('/three', async () => {
      await callServiceMethod(registry, 'demo', 'ok', {}, {});
      await callServiceMethod(registry, 'demo', 'ok', {}, {});
      await callServiceMethod(registry, 'demo', 'ok', {}, {});
      return { done: true };
    });

    const res = await app.inject({ method: 'POST', url: '/three' });
    expect(res.statusCode).toBe(200);

    const episodes = dev.getEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.serviceCalls).toHaveLength(3);
  });

  it('a τjs-created host with a caller route added after the page hook is installed is still attributed', async () => {
    const { app, dev, registry } = buildHarness();

    // Added on the SAME instance the page hook already governs, after that hook is installed -
    // the route itself carries no τjs marker, so `selectedRouteFrom` reads it as a foreign route
    // (Rulings: One episode per request, case "non-τjs route matched but the context is set").
    app.post('/added-later', async () => callServiceMethod(registry, 'demo', 'ok', {}, {}));

    const res = await app.inject({ method: 'POST', url: '/added-later' });
    expect(res.statusCode).toBe(200);

    const episodes = dev.getEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ kind: 'host', route: '/added-later', method: 'POST', outcome: 'complete', status: 200 });
  });
});

describe('explicit context wins', () => {
  it('a handler that passes its own { recorder, requestId } records on that explicit recorder only, no ambient episode', async () => {
    const { app, dev, registry } = buildHarness({ installPageHook: false });
    const otherDev = createDevIntrospection();

    app.post('/explicit', async () => {
      otherDev.recorder.requestStart({ requestId: 'explicit-1', url: '/explicit', method: 'POST' });
      const result = await callServiceMethod(registry, 'demo', 'ok', {}, { recorder: otherDev.recorder, requestId: 'explicit-1' });
      otherDev.recorder.sent({ requestId: 'explicit-1', status: 200, mode: 'fallthrough' });
      return result;
    });

    const res = await app.inject({ method: 'POST', url: '/explicit' });
    expect(res.statusCode).toBe(200);

    // The explicit recorder got exactly the episode its own context implies.
    expect(otherDev.getEpisodes()).toHaveLength(1);
    expect(otherDev.getEpisodes()[0]!.serviceCalls).toHaveLength(1);

    // The ambient registry's own introspection never opened a second, ambient episode.
    expect(dev.getEpisodes()).toHaveLength(0);
  });
});

describe('a τjs page request is never double-terminated', () => {
  it('a page loader calling callServiceMethod with a bare context during a rendered request produces one page episode with one terminal and the extra serviceCall on it - no host episode, no second terminal', async () => {
    const { app, dev, registry } = buildHarness();

    taujsPageRoute(app, '/page', 'demo-app', async (req, reply) => {
      const ctx = (req as unknown as { taujsRequestContext: { requestId: string; recorder: import('../EpisodeRecorder').EpisodeRecorder } })
        .taujsRequestContext;
      ctx.recorder.routeMatched({ requestId: ctx.requestId, path: '/page', appId: 'demo-app', render: 'ssr', kind: 'page' });
      // Deliberately bare: no recorder/requestId passed - the real gap this RFC closes.
      await callServiceMethod(registry, 'demo', 'ok', {}, {});
      ctx.recorder.sent({ requestId: ctx.requestId, status: 200, mode: 'ssr' });
      reply.send({ ok: true });
    });

    const res = await app.inject({ method: 'GET', url: '/page' });
    expect(res.statusCode).toBe(200);

    const episodes = dev.getEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ kind: 'page', route: '/page', appId: 'demo-app', mode: 'ssr', outcome: 'complete', status: 200 });
    expect(episodes[0]!.serviceCalls).toHaveLength(1);
  });
});

describe('late lazy opening', () => {
  it('a request whose response has already finished before its first ambient call produces no episode at all', async () => {
    const { app, dev, registry } = buildHarness({ installPageHook: false });

    app.post('/late', async (req, reply) => {
      reply.hijack();
      reply.raw.end('done');
      await new Promise<void>((resolve) => reply.raw.once('finish', resolve));
      await callServiceMethod(registry, 'demo', 'ok', {}, {});
    });

    const before = dev.stats().episodes;
    await app.inject({ method: 'POST', url: '/late' });
    await wait(10);

    expect(dev.stats().episodes).toBe(before);
    expect(dev.getEpisodes()).toHaveLength(0);
  });

  it('a call begun before finish that settles after leaves the episode unchanged and adds no post-terminal serviceCalls entry', async () => {
    const gate = makeGate();
    const registry = buildRegistry({ g1: gate });
    const { app, dev } = buildHarness({ installPageHook: false, registry });

    app.post('/fireforget', async () => {
      // Fired but not awaited: the response completes before this settles.
      void callServiceMethod(registry, 'demo', 'waitFor', { key: 'g1' }, {}).catch(() => {});
      return { started: true };
    });

    const res = await app.inject({ method: 'POST', url: '/fireforget' });
    expect(res.statusCode).toBe(200);

    // The response is already finished; the call is still pending on the gate.
    gate.resolve();
    await wait(20);

    const episodes = dev.getEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.serviceCalls).toHaveLength(0);
    expect(dev.getObservations().edges.find((e) => e.method === 'waitFor')).toBeUndefined();
  });

  it('a registry call made from a setTimeout fired after finish records no episode entry and no observed-edge count', async () => {
    const { app, dev, registry } = buildHarness({ installPageHook: false });

    app.post('/timeout', async () => {
      setTimeout(() => {
        void callServiceMethod(registry, 'demo', 'ok', {}, {}).catch(() => {});
      }, 15);
      return { started: true };
    });

    const res = await app.inject({ method: 'POST', url: '/timeout' });
    expect(res.statusCode).toBe(200);

    await wait(60);

    expect(dev.getEpisodes()).toHaveLength(0);
    expect(dev.getObservations().edges).toHaveLength(0);
  });
});

describe('pre-dispatch rejection', () => {
  it('a handler that throws before its first callServiceMethod call produces no episode and no observed-edge entry, and the 400 it already sends is unchanged', async () => {
    const { app, dev, registry } = buildHarness({ installPageHook: false });

    app.post('/validate', async (req, reply) => {
      const body = req.body as { n?: number };
      if (typeof body?.n !== 'number') {
        reply.code(400);
        return { error: 'bad request' };
      }
      return callServiceMethod(registry, 'demo', 'ok', {}, {});
    });

    const res = await app.inject({ method: 'POST', url: '/validate', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ error: 'bad request' });
    expect(dev.getEpisodes()).toHaveLength(0);
    expect(dev.getObservations().edges).toHaveLength(0);
  });
});

describe('host terminal contract', () => {
  const statusCases: { status: number; via: 'sent' | 'failed' }[] = [
    { status: 200, via: 'sent' },
    { status: 301, via: 'sent' },
    { status: 400, via: 'failed' },
    { status: 500, via: 'failed' },
  ];

  for (const { status, via } of statusCases) {
    it(`a ${status} finish produces exactly one ${via} with kind 'host' and that status`, async () => {
      const { app, dev, registry } = buildHarness({ installPageHook: false });
      app.post('/status', async (_req, reply) => {
        await callServiceMethod(registry, 'demo', 'ok', {}, {});
        reply.code(status);
        return { status };
      });

      const res = await app.inject({ method: 'POST', url: '/status' });
      expect(res.statusCode).toBe(status);

      const episodes = dev.getEpisodes();
      expect(episodes).toHaveLength(1);
      expect(episodes[0]!.outcome).toBe(via === 'sent' ? 'complete' : 'failed');
      expect(episodes[0]!.status).toBe(status);
      expect(episodes[0]!.kind).toBe('host');
      expect(episodes[0]!.mode).toBeNull();
      if (via === 'failed') {
        expect(episodes[0]!.error).toEqual({ kind: 'http', message: `HTTP ${status}` });
      }
    });
  }

  it('a close with no preceding finish produces one aborted, never a failed or sent', async () => {
    const { app, dev, registry } = buildHarness({ installPageHook: false });
    const gate = makeGate();

    app.post('/abort', async (_req, reply) => {
      await callServiceMethod(registry, 'demo', 'ok', {}, {});
      // `.inject()` has no real socket to sever - destroying the raw response itself is what
      // fires `close` without a preceding `finish`, the same discriminator the page pipeline uses.
      reply.raw.destroy();
      await gate.promise;
      return { unreachable: true };
    });

    await app
      .inject({ method: 'POST', url: '/abort' })
      .catch(() => {})
      .finally(() => gate.resolve());
    await wait(20);

    const episodes = dev.getEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.outcome).toBe('aborted');
  });

  it('a finish immediately followed by its own close (the ordinary sequence, not a disconnect) still produces exactly one terminal', async () => {
    const { app, dev, registry } = buildHarness({ installPageHook: false });

    app.post('/ordinary', async () => callServiceMethod(registry, 'demo', 'ok', {}, {}));

    const res = await app.inject({ method: 'POST', url: '/ordinary' });
    expect(res.statusCode).toBe(200);
    await wait(10);

    expect(dev.getEpisodes()).toHaveLength(1);
    expect(dev.getEpisodes()[0]!.outcome).toBe('complete');
  });
});

describe('shared registry ambiguity', () => {
  it('two servers sharing a registry produce no route-attributed edge for it, with exactly one warning, re-armed once unambiguous', async () => {
    const registry = buildRegistry();
    const { logger, warns } = mkLogger();
    const devA = createDevIntrospection({ logger });
    const devB = createDevIntrospection({ logger });
    const appA = fastify();
    acquire(registry, devA, logger);
    harnesses.push({ app: appA, dev: devA, registry });

    appA.post('/shared', async () => callServiceMethod(registry, 'demo', 'ok', {}, {}));

    // Still unambiguous: one introspection governs this registry.
    let res = await appA.inject({ method: 'POST', url: '/shared' });
    expect(res.statusCode).toBe(200);
    expect(devA.getEpisodes()).toHaveLength(1);

    // Now ambiguous: a second introspection acquires the SAME registry.
    acquire(registry, devB, logger);
    res = await appA.inject({ method: 'POST', url: '/shared' });
    expect(res.statusCode).toBe(200);
    expect(devA.getEpisodes()).toHaveLength(1); // unchanged - declined, not a second episode
    expect(devB.getEpisodes()).toHaveLength(0);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toContain('shared by more than one');

    // A second ambiguous call while still ambiguous does not warn again.
    res = await appA.inject({ method: 'POST', url: '/shared' });
    expect(res.statusCode).toBe(200);
    expect(warns).toHaveLength(1);

    // Back to unambiguous: released, re-armed.
    release(registry, devB);
    res = await appA.inject({ method: 'POST', url: '/shared' });
    expect(res.statusCode).toBe(200);
    expect(devA.getEpisodes()).toHaveLength(2);

    // Ambiguous again: warns once more.
    acquire(registry, devB, logger);
    res = await appA.inject({ method: 'POST', url: '/shared' });
    expect(res.statusCode).toBe(200);
    expect(warns).toHaveLength(2);
    release(registry, devB);
  });
});

describe('request-ID collision across instances', () => {
  it('a host request claiming first, then a colliding page request: one attributed episode, one declined-with-warning request, never conflated', async () => {
    const { logger, warns } = mkLogger();
    const registry = buildRegistry();
    const dev = createDevIntrospection({ logger });
    const gate = makeGate();

    const host = fastify({ genReqId: () => 'collide-a' });
    host.post('/host', async () => {
      const r = await callServiceMethod(registry, 'demo', 'ok', {}, {});
      await gate.promise;
      return r;
    });
    acquire(registry, dev, logger);
    harnesses.push({ app: host, dev, registry });

    const page = fastify({ genReqId: () => 'collide-a' });
    installPageHook(page, dev);
    taujsPageRoute(page, '/page', 'demo-app', async () => ({ ok: true }));
    harnesses.push({ app: page, dev, registry });

    const hostPromise = host.inject({ method: 'POST', url: '/host' });
    await wait(20);
    const pageRes = await page.inject({ method: 'GET', url: '/page' });
    gate.resolve();
    const hostRes = await hostPromise;

    expect(hostRes.statusCode).toBe(200);
    expect(pageRes.statusCode).toBe(200);

    const episodes = dev.getEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ kind: 'host', requestId: 'collide-a' });
    expect(warns.some((w) => w.msg.toLowerCase().includes('collision'))).toBe(true);
  });

  it('a page request claiming first, then a colliding host request: one attributed episode, one declined-with-warning request, never conflated', async () => {
    const { logger, warns } = mkLogger();
    const registry = buildRegistry();
    const dev = createDevIntrospection({ logger });
    const gate = makeGate();

    const page = fastify({ genReqId: () => 'collide-b' });
    installPageHook(page, dev);
    taujsPageRoute(page, '/page', 'demo-app', async (req, reply) => {
      await gate.promise;
      const ctx = (req as unknown as { taujsRequestContext?: { requestId: string; recorder?: import('../EpisodeRecorder').EpisodeRecorder } })
        .taujsRequestContext;
      ctx?.recorder?.sent({ requestId: ctx.requestId, status: 200, mode: 'ssr' });
      reply.send({ ok: true });
    });
    acquire(registry, dev, logger);
    harnesses.push({ app: page, dev, registry });

    const host = fastify({ genReqId: () => 'collide-b' });
    host.post('/host', async () => callServiceMethod(registry, 'demo', 'ok', {}, {}));
    harnesses.push({ app: host, dev, registry });

    const pagePromise = page.inject({ method: 'GET', url: '/page' });
    await wait(20);
    const hostRes = await host.inject({ method: 'POST', url: '/host' });
    gate.resolve();
    const pageRes = await pagePromise;

    expect(hostRes.statusCode).toBe(200);
    expect(pageRes.statusCode).toBe(200);

    const episodes = dev.getEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ kind: 'page', requestId: 'collide-b' });
    expect(warns.some((w) => w.msg.toLowerCase().includes('collision'))).toBe(true);
  });
});

describe('the complete no-throw boundary', () => {
  it('feature detection: when bindStore/unbindStore are absent, attribution is unavailable for the whole boot with exactly one warning, and the response is unaffected', async () => {
    const channel = startChannel();
    // Deliberately simulating an older/changed Node build for this one cell.
    const restoreBind = patchMethod(channel, 'bindStore', undefined);
    const restoreUnbind = patchMethod(channel, 'unbindStore', undefined);

    try {
      const { app, dev, registry, warns } = buildHarness({ installPageHook: false });
      app.post('/nofeature', async () => callServiceMethod(registry, 'demo', 'ok', {}, {}));

      const res = await app.inject({ method: 'POST', url: '/nofeature' });
      expect(res.statusCode).toBe(200);
      expect(dev.getEpisodes()).toHaveLength(0);
      expect(warns.some((w) => w.msg.toLowerCase().includes('bindstore'))).toBe(true);
      expect(warns.filter((w) => w.msg.toLowerCase().includes('bindstore'))).toHaveLength(1);
    } finally {
      restoreBind();
      restoreUnbind();
    }
  });

  it('acquisition fault: a throw inside bindStore degrades to no attribution, never a broken boot, and the next boot on a fresh registry acquires cleanly', async () => {
    const channel = startChannel();
    const restoreBind = patchMethod(channel, 'bindStore', () => {
      throw new Error('boundary-2-bind');
    });

    let harness: Harness | undefined;
    try {
      harness = buildHarness({ installPageHook: false });
      harness.app.post('/faulted', async () => callServiceMethod(harness!.registry, 'demo', 'ok', {}, {}));

      const res = await harness.app.inject({ method: 'POST', url: '/faulted' });
      expect(res.statusCode).toBe(200);
      expect(harness.dev.getEpisodes()).toHaveLength(0);
    } finally {
      restoreBind();
    }

    // Release this boot's acquisition NOW (mirroring CreateServer.ts's release-on-failure) so the
    // global bind counter returns to zero before the next boot - otherwise the acquisitions
    // counter would still read >0 and the next acquire would not see a fresh 0-to-1 transition.
    release(harness.registry, harness.dev);
    await harness.app.close();
    harnesses.splice(
      harnesses.findIndex((h) => h.dev === harness!.dev),
      1,
    );

    // A fresh boot, same process, real bindStore restored: acquires and attributes cleanly.
    const clean = buildHarness({ installPageHook: false });
    clean.app.post('/clean', async () => callServiceMethod(clean.registry, 'demo', 'ok', {}, {}));
    const res2 = await clean.app.inject({ method: 'POST', url: '/clean' });
    expect(res2.statusCode).toBe(200);
    expect(clean.dev.getEpisodes()).toHaveLength(1);
  });

  it('lifecycle attachment: a throw on the SECOND listener registration removes the first, leaves the coordinator inactive, produces no episode, identical response bytes, and a clean next request', async () => {
    const { app, dev, registry } = buildHarness({ installPageHook: false });

    let armed = true; // only the FIRST request through this instance is faulted
    let firstRemoved = false;
    app.addHook('preHandler', async (_req, reply) => {
      if (!armed) return;
      armed = false;

      const raw = reply.raw as unknown as { on: typeof reply.raw.on; removeListener: typeof reply.raw.removeListener };
      const realOn = raw.on.bind(raw);
      const realRemoveListener = raw.removeListener.bind(raw);
      let sawFinish = false;

      raw.removeListener = ((event: string, listener: (...a: unknown[]) => void) => {
        if (event === 'finish') firstRemoved = true;
        return realRemoveListener(event, listener);
      }) as typeof raw.removeListener;

      raw.on = ((event: string, listener: (...a: unknown[]) => void) => {
        if (event === 'finish') {
          sawFinish = true;
          return realOn(event, listener);
        }
        if (event === 'close' && sawFinish) {
          throw new Error('boundary-5-second-listener');
        }
        return realOn(event, listener);
      }) as typeof raw.on;
    });

    app.post('/faulted-attach', async () => callServiceMethod(registry, 'demo', 'ok', {}, {}));

    const faulted = await app.inject({ method: 'POST', url: '/faulted-attach' });
    expect(faulted.statusCode).toBe(200);
    expect(dev.getEpisodes()).toHaveLength(0);
    expect(dev.stats().episodes).toBe(0);
    expect(firstRemoved).toBe(true);

    // Compare against an unfaulted instance for byte-identical response bytes.
    const control = buildHarness({ installPageHook: false });
    control.app.post('/faulted-attach', async () => callServiceMethod(control.registry, 'demo', 'ok', {}, {}));
    const controlRes = await control.app.inject({ method: 'POST', url: '/faulted-attach' });
    expect(faulted.payload).toBe(controlRes.payload);
    expect(faulted.statusCode).toBe(controlRes.statusCode);

    // The NEXT request on the same faulted instance attributes cleanly (the fault only ever hit
    // that one preHandler-installed request).
    const clean = await app.inject({ method: 'POST', url: '/faulted-attach' });
    expect(clean.statusCode).toBe(200);
    expect(dev.getEpisodes()).toHaveLength(1);
  });

  it('a fault inside routeMatched after requestStart has already run leaves one finalised, partially populated episode - never pending - identical response bytes, and a clean next request', async () => {
    const { app, dev, registry } = buildHarness({ installPageHook: false });

    // requestStart is a real recorder call the assembler already completed; only routeMatched is
    // replaced, and only for this one request, so the fault lands strictly AFTER requestStart.
    const realRouteMatched = dev.recorder.routeMatched;
    dev.recorder.routeMatched = () => {
      throw new Error('boundary-6-routematched');
    };

    app.post('/faulted-routematched', async () => callServiceMethod(registry, 'demo', 'ok', {}, {}));

    const faulted = await app.inject({ method: 'POST', url: '/faulted-routematched' });
    dev.recorder.routeMatched = realRouteMatched;

    const control = buildHarness({ installPageHook: false });
    control.app.post('/faulted-routematched', async () => callServiceMethod(control.registry, 'demo', 'ok', {}, {}));
    const controlRes = await control.app.inject({ method: 'POST', url: '/faulted-routematched' });

    expect(faulted.statusCode).toBe(200);
    expect(faulted.statusCode).toBe(controlRes.statusCode);
    expect(faulted.payload).toBe(controlRes.payload);

    // The terminal listeners were already attached before routeMatched ever ran, so the episode
    // still reaches a terminal - it is finalised, not left pending. routeMatched itself never
    // executed, so none of ITS assignments landed: the episode keeps requestStart's own defaults
    // (kind stays 'page', route stays null) - the actual truth this fault leaves behind, not the
    // 'host'-shaped episode a successful routeMatched would have written.
    const episodes = dev.getEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('page');
    expect(episodes[0]!.route).toBeNull();
    expect(episodes[0]!.outcome).toBe('complete');
    expect(episodes[0]!.status).toBe(200);
    expect(dev.stats().episodes).toBe(1);

    // The NEXT request on the same instance, routeMatched restored, attributes cleanly and fully.
    const clean = await app.inject({ method: 'POST', url: '/faulted-routematched' });
    expect(clean.statusCode).toBe(200);
    const cleanEpisodes = dev.getEpisodes().filter((e) => e.kind === 'host');
    expect(cleanEpisodes).toHaveLength(1);
    expect(cleanEpisodes[0]).toMatchObject({ kind: 'host', route: '/faulted-routematched', method: 'POST', outcome: 'complete', status: 200 });
    expect(cleanEpisodes[0]!.serviceCalls).toHaveLength(1);
  });
});

describe('channel compatibility', () => {
  it('bindStore and unbindStore exist and are callable on this Node build, and a store bound on them is genuinely visible inside a route handler', async () => {
    const channel = startChannel();
    expect(typeof channel.bindStore).toBe('function');
    expect(typeof channel.unbindStore).toBe('function');

    const { app, dev, registry } = buildHarness({ installPageHook: false });
    app.post('/compat', async () => callServiceMethod(registry, 'demo', 'ok', {}, {}));
    const res = await app.inject({ method: 'POST', url: '/compat' });

    expect(res.statusCode).toBe(200);
    expect(dev.getEpisodes()).toHaveLength(1);
  });
});

describe('byte-identical response path', () => {
  it('response bytes and headers are identical for the same request whether host attribution is active or not', async () => {
    const registryOn = buildRegistry();
    const registryOff = buildRegistry();
    const { logger } = mkLogger();
    const dev = createDevIntrospection({ logger });

    const appOn = fastify();
    appOn.post('/x', async () => callServiceMethod(registryOn, 'demo', 'ok', {}, {}));
    acquire(registryOn, dev, logger);
    harnesses.push({ app: appOn, dev, registry: registryOn });

    const appOff = fastify();
    appOff.post('/x', async () => callServiceMethod(registryOff, 'demo', 'ok', {}, {}));

    const [on, off] = await Promise.all([appOn.inject({ method: 'POST', url: '/x' }), appOff.inject({ method: 'POST', url: '/x' })]);

    expect(on.statusCode).toBe(off.statusCode);
    expect(on.payload).toBe(off.payload);
    expect(on.headers['content-type']).toBe(off.headers['content-type']);
    expect(on.headers['content-length']).toBe(off.headers['content-length']);

    await appOff.close();
  });
});

describe('observations.json for a page-only run', () => {
  it('is unchanged in shape except the required schemaVersion bump, with version 2 asserted separately', () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: 'pg-1', url: '/p', method: 'GET' });
    dev.recorder.routeMatched({ requestId: 'pg-1', path: '/p', appId: 'demo-app', render: 'ssr', kind: 'page' });
    dev.recorder.serviceCall({ requestId: 'pg-1', service: 'demo', method: 'ok', ms: 1, ok: true });
    dev.recorder.sent({ requestId: 'pg-1', status: 200, mode: 'ssr' });

    const obs = dev.getObservations();
    const { schemaVersion, ...rest } = obs;

    expect(schemaVersion).toBe(2);
    expect(rest).toEqual({
      bootId: dev.bootId,
      updatedAt: obs.updatedAt,
      edges: [
        {
          service: 'demo',
          method: 'ok',
          routes: [{ routeId: 'demo-app:/p', appId: 'demo-app', path: '/p', count: 1 }],
          count: 1,
          lastObservedAt: obs.updatedAt,
          sampleRequestIds: ['pg-1'],
        },
      ],
      shapes: [],
    });
  });
});

describe('release-gate through the real createServer (no serviceRegistry supplied)', () => {
  it('a boot with no serviceRegistry that fails after acquiring host attribution releases the binding, so a clean boot afterwards acquires and attributes normally', async () => {
    const cwd = process.cwd();

    // isDevelopment is snapshotted once at module load (System.ts), so a real development boot
    // needs a fresh module graph loaded with NODE_ENV already set - the same seam
    // HostOwnershipDevelopment.test.ts uses. The plugin under test, the HostAttribution module it
    // acquires against, AND the callServiceMethod this test's own host handler calls through must
    // all come from this SAME fresh graph - the statically-imported callServiceMethod at the top
    // of this file closes over a DIFFERENT HostAttribution instance (a different `als` and a
    // different registrySets WeakMap), so it would never see this boot's acquisition at all.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    vi.resetModules();
    let freshCreateServer: typeof createServer;
    let freshAcquisitionCount: typeof acquisitionCountForTests;
    let freshCallServiceMethod: typeof callServiceMethod;
    let freshDefineService: typeof defineService;
    let freshDefineServiceRegistry: typeof defineServiceRegistry;
    try {
      freshCreateServer = (await import('../../../CreateServer')).createServer;
      freshAcquisitionCount = (await import('../HostAttribution')).acquisitionCountForTests;
      ({
        callServiceMethod: freshCallServiceMethod,
        defineService: freshDefineService,
        defineServiceRegistry: freshDefineServiceRegistry,
      } = await import('../../services/DataServices'));
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }

    const before = freshAcquisitionCount();

    // No serviceRegistry: SSRServer.ts normalises the absent option to a fresh `{}` it owns and
    // acquires against THAT object - opts.serviceRegistry stays undefined, the exact condition the
    // leak needs. The malformed route (an unclosed regexp constraint) is not a duplicate path, so
    // extractRoutes' own boot-time check does not reject it before registration; Fastify's router
    // only rejects it when the route loop actually calls .get(), which runs AFTER introspection is
    // created and host attribution is acquired.
    const faulted = await developmentFixture();
    process.chdir(faulted.root);
    const faultedConfig: TaujsConfig = {
      apps: [
        {
          appId: 'fault-app',
          entryPoint: 'app',
          renderer: testRenderer(),
          routes: [{ path: '/fault/:id(', attr: { render: 'ssr' } }] as never,
        },
      ],
    };
    try {
      await expect(freshCreateServer({ config: faultedConfig, clientRoot: faulted.clientRoot, projectRoot: faulted.root })).rejects.toThrow();
    } finally {
      process.chdir(cwd);
    }

    // Released via the disposer CreateServer's catch calls - never leaked because no registry was
    // supplied to compute `opts.serviceRegistry && ...` against.
    expect(freshAcquisitionCount()).toBe(before);

    // A clean boot afterwards, with a real, externally-held registry: acquires and attributes
    // normally - proof the channel genuinely (re)binds rather than resting on a leaked prior count.
    const clean = await developmentFixture();
    process.chdir(clean.root);
    const registry = freshDefineServiceRegistry({ demo: freshDefineService({ ok: async (_p: {}) => ({ ok: true }) }) });
    const cleanConfig: TaujsConfig = {
      apps: [{ appId: 'clean-app', entryPoint: 'app', renderer: testRenderer(), routes: [{ path: '/clean-page', attr: { render: 'ssr' } }] }],
    };
    let result: Awaited<ReturnType<typeof createServer>>;
    try {
      result = await freshCreateServer({ config: cleanConfig, clientRoot: clean.clientRoot, projectRoot: clean.root, serviceRegistry: registry });
    } finally {
      process.chdir(cwd);
    }

    const app = result.app!;
    app.post('/host-clean', async () => freshCallServiceMethod(registry, 'demo', 'ok', {}, {}));

    const res = await app.inject({ method: 'POST', url: '/host-clean' });
    expect(res.statusCode).toBe(200);

    const introspection = (app as unknown as { taujsIntrospection?: DevIntrospection }).taujsIntrospection;
    expect(introspection).toBeDefined();
    expect(introspection!.getEpisodes().some((e) => e.kind === 'host' && e.route === '/host-clean')).toBe(true);

    await app.close();
    await disposeFixtures();
  }, 20_000);
});
