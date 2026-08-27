// @vitest-environment node
//
// The dev delegator's `onRequest` hook (packages/server/src/utils/DevServer.ts) leaves its promise
// pending on purpose when Vite answers a request itself - Connect's missing `next()` call is the
// ownership signal. This proves the stop with a real Vite dev server: when Vite owns the request,
// the τjs render handler must not run, the caller's not-found handler must not run, and Fastify's
// own `onResponse` hook still fires exactly once. A pass-through control proves the same host still
// routes normally when Vite does not answer.
//
// One real development boot carries every cell, because a real Vite server is expensive and the
// assertions all depend on the same running host (same convention as HostOwnershipDevelopment.test.ts).
//
// `handleRender` is wrapped, never replaced: it calls through to the real implementation, so the
// call-count assertion cannot pass vacuously.

import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OWNER, PATHS, closeAll, developmentFixture, observe, taujsConfig } from './support/hostOwnership';

import type { FastifyInstance } from 'fastify';

const renderInstrument = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../utils/HandleRender', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/HandleRender')>();

  return {
    ...actual,
    // Wraps the REAL handler so the call count measures whether the τjs route handler actually ran.
    handleRender: async (...args: Parameters<typeof actual.handleRender>) => {
      renderInstrument.calls += 1;

      return actual.handleRender(...args);
    },
  };
});

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

const notFoundInstrument = vi.hoisted(() => ({ calls: 0 }));

const buildCallerHost = (): { app: FastifyInstance; onResponseCounts: Map<string, number> } => {
  const app = fastify({ logger: false });
  const onResponseCounts = new Map<string, number>();

  app.decorate('authenticate', async () => undefined);
  app.addHook('onResponse', async (request) => {
    const url = request.raw.url ?? '';
    onResponseCounts.set(url, (onResponseCounts.get(url) ?? 0) + 1);
  });
  app.get(PATHS.callerBefore, async () => ({ owner: OWNER.callerBefore }));
  app.setNotFoundHandler(async (_request, reply) => {
    notFoundInstrument.calls += 1;

    return reply.status(404).type('application/json').send({ owner: OWNER.callerNotFound });
  });

  return { app, onResponseCounts };
};

afterEach(async () => {
  await closeAll();
});

describe('dev delegator - ownership signal (RFC 0010, no next() means Vite answered)', () => {
  it('a Vite-served asset stops the lifecycle; a pass-through request continues normally', async () => {
    const cwd = process.cwd();
    const { root, clientRoot } = await developmentFixture();
    const { app, onResponseCounts } = buildCallerHost();

    process.chdir(root);

    try {
      const createServer = await loadDevelopmentCreateServer();
      await createServer({ config: taujsConfig(), fastify: app, clientRoot, projectRoot: root });

      // --- Cell 1: Vite answers the request itself. The promise stays pending, so the hook chain
      // never continues past this hook - the τjs render handler and the caller's not-found handler
      // must both be untouched, while Fastify's own onResponse still fires from its raw-response
      // listener.
      const rendersBeforeAsset = renderInstrument.calls;
      const notFoundBeforeAsset = notFoundInstrument.calls;

      const viteClient = await app.inject('/@vite/client');

      expect(viteClient.statusCode).toBe(200);
      expect(viteClient.headers['content-type']).toContain('javascript');
      expect(viteClient.body).toMatch(/createHotContext|__vite__|HMRClient/);

      expect(renderInstrument.calls).toBe(rendersBeforeAsset);
      expect(notFoundInstrument.calls).toBe(notFoundBeforeAsset);
      expect(onResponseCounts.get('/@vite/client')).toBe(1);

      // --- Cell 2: pass-through control, τjs page. Vite calls next() (it does not own this URL),
      // so the promise resolves and the hook chain continues into the τjs route, which DOES render.
      const rendersBeforePage = renderInstrument.calls;

      const page = observe(await app.inject(PATHS.taujsPage));

      expect(page.status).toBe(200);
      expect(page.body).toContain(OWNER.taujsPage);
      expect(renderInstrument.calls - rendersBeforePage).toBe(1);
      expect(onResponseCounts.get(PATHS.taujsPage)).toBe(1);

      // --- Cell 2b: pass-through control, caller route. Same lifecycle continuation, on a route
      // the τjs config never declared.
      const callerRoute = await app.inject(PATHS.callerBefore);

      expect(callerRoute.statusCode).toBe(200);
      expect(JSON.parse(callerRoute.body)).toEqual({ owner: OWNER.callerBefore });
      expect(onResponseCounts.get(PATHS.callerBefore)).toBe(1);
    } finally {
      process.chdir(cwd);
      await app.close();
    }
  }, 30_000);
});
