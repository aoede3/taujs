// @vitest-environment node
//
// Development delegator ownership (dev-Vite responsibility 2), caller-owned host.
//
// THE INVARIANT: on a caller-owned host, Vite must not answer a request Fastify selected for a
// CALLER route. Declared τjs pages stay in the middleware path - they are selected too, but skipping
// it would also skip Vite's host check for them. Vite still handles anything unmatched.
//
// Before this, the delegator ran Vite's middleware from an `onRequest` hook on the caller's ROOT
// instance, so Vite saw every request - and answered some of them. The visible symptom was Vite's
// 403 block page returned for a CALLER's own route whenever the `Host` was one Vite does not allow,
// which a proxy or supervisor commonly presents.
//
// THE MECHANISM is two reads, no lookup: `request.is404` is a public Fastify getter over the route
// context Fastify already selected, and `selectedRouteFrom(request)` reads the τjs page identity the
// same request already carries for rendering, auth and CSP. No `findRoute()`, marker protocol,
// URL-prefix list or registry - a second lookup could disagree with Fastify's own selection on
// wildcards, constraints or decoded parameters, which would reintroduce this defect subtler.
//
// Scope: the caller-owned root delegator ONLY. A τjs-created host is unchanged.

import http from 'node:http';

import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CALLER_CSP, closeAll, developmentFixture, OWNER, PATHS, taujsConfig } from './support/hostOwnership';

import type { FastifyInstance } from 'fastify';

/** A host Vite refuses unless declared - the proxy topology in one header. */
const UNDECLARED_HOST = 'proxy.internal';
const CALLER_WILDCARD = '/caller-area';

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

const request = (port: number, url: string, host?: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const call = http.get({ host: '127.0.0.1', port, path: url, ...(host ? { headers: { host } } : {}) }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });

    call.on('error', reject);
    call.setTimeout(20_000, () => reject(new Error('timed out')));
  });

const bootCallerOwned = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  const { root, clientRoot } = await developmentFixture();
  const previousCwd = process.cwd();

  process.chdir(root);

  try {
    const app: FastifyInstance = fastify({ logger: false });

    app.addHook('onRequest', (_request, reply, done) => {
      reply.header('Content-Security-Policy', CALLER_CSP);
      done();
    });
    app.get(PATHS.callerBefore, async () => ({ owner: OWNER.callerBefore }));
    app.get(`${CALLER_WILDCARD}/*`, async () => ({ owner: 'caller-wildcard' }));
    app.setNotFoundHandler(async (_request, reply) => reply.status(404).type('application/json').send({ owner: OWNER.callerNotFound }));

    const createServer = await loadDevelopmentCreateServer();

    await createServer({ config: taujsConfig(), fastify: app, clientRoot, projectRoot: root });
    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();

    return { port: typeof address === 'object' && address !== null ? address.port : 0, close: async () => void (await app.close()) };
  } finally {
    process.chdir(previousCwd);
  }
};

afterEach(async () => {
  await closeAll();
});

describe('caller-owned development host: Vite does not answer for selected CALLER routes', () => {
  it('an EXACT caller route is served by the caller, even under a Host Vite would reject', { timeout: 60_000 }, async () => {
    const host = await bootCallerOwned();

    try {
      const local = await request(host.port, PATHS.callerBefore);

      expect(local.status).toBe(200);
      expect(JSON.parse(local.body)).toEqual({ owner: OWNER.callerBefore });

      // The defect in one assertion: the caller's own route used to return Vite's 403 block page
      // whenever a proxy presented a Host Vite does not allow.
      const proxied = await request(host.port, PATHS.callerBefore, UNDECLARED_HOST);

      expect(proxied.status).toBe(200);
      expect(JSON.parse(proxied.body)).toEqual({ owner: OWNER.callerBefore });
      expect(proxied.body.toLowerCase()).not.toContain('not allowed');
    } finally {
      await host.close();
    }
  });

  it('a WILDCARD caller route is served by the caller too - selection, not URL shape, is the test', { timeout: 60_000 }, async () => {
    const host = await bootCallerOwned();

    try {
      const proxied = await request(host.port, `${CALLER_WILDCARD}/deep/nested`, UNDECLARED_HOST);

      expect(proxied.status).toBe(200);
      expect(JSON.parse(proxied.body)).toEqual({ owner: 'caller-wildcard' });
    } finally {
      await host.close();
    }
  });

  it('a τjs page under an ALLOWED host renders', { timeout: 60_000 }, async () => {
    const host = await bootCallerOwned();

    try {
      const page = await request(host.port, PATHS.taujsPage);

      expect(page.status).toBe(200);
      expect(page.body).toContain('<!doctype html');
    } finally {
      await host.close();
    }
  });

  it('a τjs page under an UNDECLARED host is STILL refused - the bypass is for CALLER routes only', { timeout: 60_000 }, async () => {
    const host = await bootCallerOwned();

    try {
      // The boundary correction this unit needed. "Fastify selected a route" does not mean "the
      // CALLER owns it": a τjs page is selected too, so a bypass keyed on selection alone would
      // also skip Vite's host check for τjs pages - silently removing a DNS-rebinding defence from
      // documents that carry route data in `__INITIAL_DATA__`. τjs pages stay in the middleware
      // path, so the two ownership modes keep the same posture.
      const blocked = await request(host.port, PATHS.taujsPage, UNDECLARED_HOST);

      expect(blocked.status).toBe(403);
      expect(blocked.body.toLowerCase()).toContain('not allowed');
    } finally {
      await host.close();
    }
  });

  it('UNMATCHED Vite resource URLs still reach Vite', { timeout: 60_000 }, async () => {
    const host = await bootCallerOwned();

    try {
      const client = await request(host.port, '/@vite/client');

      expect(client.status).toBe(200);
      expect(client.body.length).toBeGreaterThan(0);
    } finally {
      await host.close();
    }
  });

  it('an UNMATCHED ordinary URL falls through Vite to the CALLER’s 404', { timeout: 60_000 }, async () => {
    const host = await bootCallerOwned();

    try {
      const missing = await request(host.port, '/nothing-here-at-all');

      expect(missing.status).toBe(404);
      expect(JSON.parse(missing.body)).toEqual({ owner: OWNER.callerNotFound });
    } finally {
      await host.close();
    }
  });

  it('an undeclared Host is STILL rejected for Vite-owned resources - the posture is narrowed, not removed', { timeout: 60_000 }, async () => {
    const host = await bootCallerOwned();

    try {
      const blocked = await request(host.port, '/@vite/client', UNDECLARED_HOST);

      expect(blocked.status).toBe(403);
      expect(blocked.body.toLowerCase()).toContain('not allowed');
    } finally {
      await host.close();
    }
  });
});
