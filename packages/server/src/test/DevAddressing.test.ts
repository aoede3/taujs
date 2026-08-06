// @vitest-environment node
/**
 * RFC 0012 PR 2 acceptance - development addressing: the shared dev Vite base and the
 * mount-domain confinement of the delegator, proven on SEPARATE strip and preserve real
 * development boots (real Vite, real caller-owned host - the delegator's guarded arm; the
 * owned-scope arm shares the same hook and `scope.prefix` sourcing).
 *
 * There is deliberately NO request-path rewriting to test: pinned Vite (7.3.6) middleware
 * mode natively accepts BOTH public-prefixed and proxy-stripped request paths - its
 * baseMiddleware answers a base mismatch with a plain `next()` into its own transform and
 * static middlewares registered immediately after (dist/node/chunks/config.js, base
 * mismatch fallthrough and middleware stack assembly). τjs owns exactly two dev
 * transformations: the derived `base` (emission) and the mount-domain guard (confinement).
 * These boots PIN that middleware contract: if a future Vite stops accepting stripped
 * paths, the strip cells fail and the question comes back for review.
 *
 * Mutation standard: reverting the dev `base` derivation fails the page-HTML cells;
 * reverting the mount-domain guard fails the out-of-mount cell (verified on disk).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import fastify from 'fastify';

import { CALLER_CSP, OWNER, PATHS, closeAll, developmentFixture, taujsConfig } from './support/hostOwnership';

import type { FastifyInstance } from 'fastify';
import type { TaujsConfig } from '../Config';

afterEach(closeAll);

// Real development boots. NODE_ENV is snapshotted at module evaluation (System.ts), so each
// boot re-imports createServer under development, mirroring HostOwnershipDevelopment.test.ts.
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

const withServer = (server: NonNullable<TaujsConfig['server']>): TaujsConfig => ({ ...taujsConfig(), server });

describe('RFC 0012 PR 2 - STRIP development evidence (mount "", publicBasePath "/pub")', () => {
  it('serves stripped module URLs natively, emits public-space HTML, and falls through to the host', async () => {
    const createServer = await loadDevelopmentCreateServer();
    const { clientRoot } = await developmentFixture();
    const app = buildCallerHost();

    await createServer({ config: withServer({ publicBasePath: '/pub' }), fastify: app, clientRoot });

    try {
      // A STRIPPED module request arrives in root space; Vite (base '/pub/') accepts it
      // natively - middleware mode falls a base mismatch through to its own transform
      // middleware. This cell PINS that contract.
      const module = await app.inject({ method: 'GET', url: '/app/entry-client.ts' });
      expect(module.statusCode).toBe(200);
      expect(String(module.headers['content-type'])).toContain('javascript');

      // A query-carrying module request serves identically - nothing rewrites the URL.
      const withQuery = await app.inject({ method: 'GET', url: '/app/entry-client.ts?import' });
      expect(withQuery.statusCode).toBe(200);

      // The served page emits PUBLIC-space URLs: Vite's own client via the derived base,
      // and the τjs-generated bootstrap via publicBasePath.
      const page = await app.inject({ method: 'GET', url: PATHS.taujsPage });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('src="/pub/@vite/client"');
      expect(page.body).toContain('src="/pub/app/entry-client.ts"');

      // Fallthrough: a miss leaves Vite via next() and the CALLER's not-found answers -
      // the delegation never captures the host.
      const miss = await app.inject({ method: 'GET', url: '/no-such-page' });
      expect(miss.statusCode).toBe(404);
      expect(miss.body).toContain(OWNER.callerNotFound);
    } finally {
      await app.close();
    }
  });
});

describe('RFC 0012 PR 2 - PRESERVE development evidence (mountPrefix "/mnt")', () => {
  it('serves mount-space module URLs, emits mounted HTML, and confines the delegator to the subtree', async () => {
    const createServer = await loadDevelopmentCreateServer();
    const { clientRoot } = await developmentFixture();
    const app = buildCallerHost();

    await createServer({ config: withServer({ mountPrefix: '/mnt' }), fastify: app, clientRoot });

    try {
      // A PRESERVED module request arrives in mount space; Vite's base is '/mnt/', so its
      // baseMiddleware strips and serves - the designed path.
      const module = await app.inject({ method: 'GET', url: '/mnt/app/entry-client.ts' });
      expect(module.statusCode).toBe(200);
      expect(String(module.headers['content-type'])).toContain('javascript');

      // The mounted page emits mount-space URLs throughout.
      const page = await app.inject({ method: 'GET', url: `/mnt${PATHS.taujsPage}` });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('src="/mnt/@vite/client"');
      expect(page.body).toContain('src="/mnt/app/entry-client.ts"');

      // MOUNT-DOMAIN GUARD: the same module URL OUTSIDE the mount never reaches Vite - the
      // caller's own not-found answers. Reverting the guard serves JavaScript here (Vite
      // would accept the stripped spelling natively), which is exactly the leak the guard
      // exists to stop.
      const outside = await app.inject({ method: 'GET', url: '/app/entry-client.ts' });
      expect(outside.statusCode).toBe(404);
      expect(outside.body).toContain(OWNER.callerNotFound);

      // A miss INSIDE the mount still falls through to the caller.
      const insideMiss = await app.inject({ method: 'GET', url: '/mnt/no-such-page' });
      expect(insideMiss.statusCode).toBe(404);
      expect(insideMiss.body).toContain(OWNER.callerNotFound);
    } finally {
      await app.close();
    }
  });
});
