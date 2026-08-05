// @vitest-environment node
//
// Development behind a proxy: the acceptance evidence for `config.vite.server.allowedHosts`.
//
// Vite 6.1+ enforces `server.allowedHosts` as a DNS-rebinding defence, rejecting any request whose
// `Host` is not localhost-like. A reverse proxy or process supervisor commonly presents such a
// host, and τjs development behind one then answered 403 - with no way to allow it through the
// declared Vite surface, because composition wrote `server` as a whole object AFTER the user spread.
//
// This drives REAL development boots with a REAL Vite server and a REAL listener, because the
// defining feature of the topology is the rewritten `Host` arriving on the wire. `inject()` would
// exercise the same middleware but would not be the thing under test.
//
// Both ownership modes are covered: a caller-owned host (RFC 0010 mode B) and a τjs-created host.
// The security posture is asserted in the same boot as the fix - an ALLOWED host serves while an
// UNDECLARED one is still refused, so admitting the field cannot be mistaken for weakening it.

import http from 'node:http';

import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeAll, developmentFixture, PATHS, taujsConfig } from './support/hostOwnership';

import type { TaujsConfig } from '../Config';
import type { FastifyInstance } from 'fastify';

/**
 * The host value is the one ACTUALLY observed in the original report, so this regression stays
 * traceable to its evidence. Nothing here is specific to that proxy: any hostname a proxy or
 * supervisor substitutes reproduces it, and no product code knows the value.
 */
const PROXY_HOST = 'web.plt.local';
const UNDECLARED_HOST = 'not-declared.example';

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

/** A real request with a proxy-rewritten `Host`, which is the whole topology in one header. */
const requestAs = (port: number, host: string, url: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: url, headers: { host } }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });

    request.on('error', reject);
  });

const withAllowedHosts = (allowedHosts?: string[]): TaujsConfig => ({
  ...taujsConfig(),
  ...(allowedHosts ? { vite: { server: { allowedHosts } } } : {}),
});

type Boot = { port: number; close: () => Promise<void> };

const bootDevelopment = async (options: { callerOwned: boolean; allowedHosts?: string[] }): Promise<Boot> => {
  const { root, clientRoot } = await developmentFixture();
  const previousCwd = process.cwd();

  process.chdir(root);

  try {
    const createServer = await loadDevelopmentCreateServer();
    const config = withAllowedHosts(options.allowedHosts);

    let app: FastifyInstance | undefined;

    if (options.callerOwned) {
      app = fastify({ logger: false });
      await createServer({ config, fastify: app, clientRoot, projectRoot: root });
    } else {
      app = (await createServer({ config, clientRoot, projectRoot: root })).app;
    }

    // A τjs-created host returns its instance optionally; a boot that produced none is a failed
    // precondition for every assertion below, so say so here rather than at a confusing call site.
    if (!app) throw new Error('development boot produced no Fastify instance');

    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    return { port, close: async () => void (await app.close()) };
  } finally {
    process.chdir(previousCwd);
  }
};

afterEach(async () => {
  await closeAll();
});

describe.each([
  ['caller-owned host', true],
  ['τjs-created host', false],
] as const)('development behind a proxy - %s', (_label, callerOwned) => {
  it('refuses a proxy host when none is declared, which is the defect this unit fixes', async () => {
    const boot = await bootDevelopment({ callerOwned });

    try {
      const blocked = await requestAs(boot.port, PROXY_HOST, PATHS.taujsPage);

      // Vite's own block page, not a τjs response: the request never reaches routing.
      expect(blocked.status).toBe(403);
      expect(blocked.body.toLowerCase()).toContain('not allowed');
    } finally {
      await boot.close();
    }
  });

  it('serves the page and Vite resources once the host is declared', async () => {
    const boot = await bootDevelopment({ callerOwned, allowedHosts: [PROXY_HOST] });

    try {
      const page = await requestAs(boot.port, PROXY_HOST, PATHS.taujsPage);

      expect(page.status).toBe(200);
      expect(page.body).toContain('<!doctype html');

      // Modules matter as much as the page: a development page that cannot load `/@vite/client`
      // renders once and never hydrates or hot-reloads, which would look like a partial fix.
      const client = await requestAs(boot.port, PROXY_HOST, '/@vite/client');

      expect(client.status).toBe(200);
    } finally {
      await boot.close();
    }
  });

  it('still refuses an UNDECLARED host, so the defence is narrowed rather than removed', async () => {
    const boot = await bootDevelopment({ callerOwned, allowedHosts: [PROXY_HOST] });

    try {
      const blocked = await requestAs(boot.port, UNDECLARED_HOST, PATHS.taujsPage);

      expect(blocked.status).toBe(403);
      expect(blocked.body.toLowerCase()).toContain('not allowed');
    } finally {
      await boot.close();
    }
  });
});
