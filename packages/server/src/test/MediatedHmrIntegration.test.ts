// @vitest-environment node
//
// RFC 0014 integration (M1 delivery, M2 lifecycle counts, M5 warning controls): the real §1
// recipe, wired against the real public `createServer()` path, a real caller-owned Fastify host,
// `hmrTransport: 'mediated'`, real listener throughout - never Fastify's `inject()` for anything
// upgrade/socket-shaped. `MediatedHmr`'s controller is WRAPPED (never replaced - the same
// convention `HostOwnershipDevelopment.test.ts` uses for Vite's `close()`) purely so the test can
// count the internal source's real listener lifecycle; the product itself never exposes it.

import http from 'node:http';

import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { developmentFixture, disposeFixtures, taujsConfig } from './support/hostOwnership';

import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { MediatedHmrController } from '../utils/MediatedHmr';

const instrument: MediatedHmrController[] = [];
const noteClientServedCalls: number[] = [];

vi.mock('../utils/MediatedHmr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/MediatedHmr')>();

  return {
    ...actual,
    createMediatedHmr: (opts: Parameters<typeof actual.createMediatedHmr>[0]) => {
      const controller = actual.createMediatedHmr(opts);
      if (controller.source) {
        instrument.push(controller);
        // Wrapped, never replaced: counts real calls the DevServer observation hook makes, which
        // the product itself never exposes.
        const originalNoteClientServed = controller.noteClientServed;
        controller.noteClientServed = () => {
          noteClientServedCalls.push(instrument.length);
          originalNoteClientServed();
        };
      }

      return controller;
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

const cwd = process.cwd();
const open: FastifyInstance[] = [];

afterEach(async () => {
  const apps = open.splice(0);
  await Promise.all(apps.map((app) => app.close().catch(() => undefined)));
  process.chdir(cwd);
  await disposeFixtures();
  instrument.length = 0;
  noteClientServedCalls.length = 0;
});

type Booted = {
  app: FastifyInstance;
  port: number;
  /** Root `upgrade` listener count captured BEFORE the recipe wired its one listener. */
  preWireListenerCount: number;
  handledCount: () => number;
};

/** Boots a real caller-owned host through the real `createServer()` path, `hmrTransport: 'mediated'`, then wires the RFC 0014 §1 recipe exactly as written (hooks registered before `listen()`, as the recipe requires). */
const boot = async (overrides: { mountPrefix?: string; publicBasePath?: string } = {}): Promise<Booted> => {
  const { root, clientRoot } = await developmentFixture();
  process.chdir(root);

  const app = fastify({ logger: false });
  open.push(app);

  const createServer = await loadDevelopmentCreateServer();
  const config = {
    ...taujsConfig(),
    server: {
      hmrTransport: 'mediated' as const,
      ...(overrides.mountPrefix !== undefined ? { mountPrefix: overrides.mountPrefix } : {}),
      ...(overrides.publicBasePath !== undefined ? { publicBasePath: overrides.publicBasePath } : {}),
    },
  };
  const tau = await createServer({ config, fastify: app, clientRoot, projectRoot: root });

  const preWireListenerCount = app.server.listenerCount('upgrade');
  let handled = 0;

  // RFC 0014 §1 - the exact developer-facing recipe.
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (tau.dev.hmr.tryHandleUpgrade(req, socket, head)) {
      handled += 1;
      return;
    }
    socket.destroy(); // the application decides what happens to upgrades that are not τjs's
  };
  app.server.on('upgrade', onUpgrade);
  app.addHook('onClose', async () => {
    app.server.off('upgrade', onUpgrade);
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;

  return { app, port, preWireListenerCount, handledCount: () => handled };
};

const getClientBytes = (port: number): Promise<string> =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/@vite/client' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
        res.on('error', reject);
      })
      .on('error', reject);
  });

/** A plain GET, resolving with the status code only - used to drive the delegator without needing the body. */
const getStatus = (port: number, requestPath: string): Promise<number> =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: requestPath }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', reject);
      })
      .on('error', reject);
  });

/** A real `vite-hmr` dial via Node's global `WebSocket`, at the app's own bound port - no second port. */
const dialHmr = (port: number): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, 'vite-hmr');
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('HMR dial timed out waiting for a message'));
    }, 5000);

    ws.addEventListener('message', (event) => {
      clearTimeout(timer);
      const message: unknown = JSON.parse(String((event as MessageEvent).data));
      ws.close();
      resolve(message);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('HMR dial errored'));
    });
  });

describe('RFC 0014 integration - the §1 recipe on a real caller-owned Fastify host', () => {
  it('delivers a same-origin dial, claims exactly once, and cleans up on close', async () => {
    const { app, port, preWireListenerCount, handledCount } = await boot();

    expect(preWireListenerCount).toBe(0);
    expect(app.server.listenerCount('upgrade')).toBe(1);

    const clientBytes = await getClientBytes(port);
    expect(clientBytes).toMatch(/createHotContext|__vite__|HMRClient/);
    // RFC 0014 §3, R1-a: with `ws.server` set and no port declared, Vite compiles `hmrPort` to the
    // literal `null` into the served client, so its `socketHost` derivation falls through to
    // `importMetaUrl.port` - the PAGE's own origin port. This is the load-bearing proof of "no
    // port declared, same-origin dial", not merely the absence of some digit string.
    expect(clientBytes).toContain('const hmrPort = null;');
    expect(clientBytes).toContain('${hmrPort || importMetaUrl.port}');

    const controller = instrument.at(-1)!;
    expect(controller.source!.listenerCount('upgrade')).toBe(1); // Vite's own guarded listener

    const connected = await dialHmr(port);
    expect(connected).toEqual({ type: 'connected' });

    // Exactly one claim: the recipe's own counter, driven by `tryHandleUpgrade`'s real return value.
    expect(handledCount()).toBe(1);

    // The root still carries exactly the recipe's one listener, and no second port was ever bound.
    expect(app.server.listenerCount('upgrade')).toBe(1);
    expect((app.server.address() as AddressInfo).port).toBe(port);

    await app.close();

    expect(app.server.listenerCount('upgrade')).toBe(0);
    expect(controller.source!.listenerCount('upgrade')).toBe(0);
  });

  it('repeats cleanly across two boot/close cycles in one process - nothing accumulates', async () => {
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const { app, port, handledCount } = await boot();

      expect(app.server.listenerCount('upgrade')).toBe(1);

      const connected = await dialHmr(port);
      expect(connected).toEqual({ type: 'connected' });
      expect(handledCount()).toBe(1);

      const controller = instrument.at(-1)!;
      expect(controller.source!.listenerCount('upgrade')).toBe(1);

      await app.close();

      expect(app.server.listenerCount('upgrade')).toBe(0);
      expect(controller.source!.listenerCount('upgrade')).toBe(0);

      // afterEach only runs once the `it` finishes - undo the chdir before the next iteration.
      process.chdir(cwd);
    }
  });
});

// RFC 0014 §6 (M5): the DevServer observation wiring itself - a real served `/@vite/client`
// reaches `noteClientServed()` exactly once, and a request for something else does not. The
// timer/warning mechanism this feeds is unit-proven under fake timers in MediatedHmr.test.ts;
// this is the one link only a real boot can prove: the delegator's onRequest hook actually calls
// it, without disturbing the is404/selected-route delegation it rides alongside.
describe('RFC 0014 integration - never-wired wiring (M5)', () => {
  it('an unrelated request does NOT call noteClientServed(); a real /@vite/client delivery does', async () => {
    const { port } = await boot();

    // An unrelated path first, so a false positive (the hook firing regardless of pathname) would
    // show up before the real signal does.
    await new Promise<void>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/no-such-module.js' }, (res) => {
          res.resume();
          res.on('end', () => resolve());
        })
        .on('error', reject);
    });
    expect(noteClientServedCalls).toHaveLength(0);

    await getClientBytes(port);
    await vi.waitFor(() => expect(noteClientServedCalls.length).toBeGreaterThanOrEqual(1));
  });

  // Reviewer correction: the FIRST version of this observation matched only
  // `${publicBasePath}/@vite/client`, which never fires under RFC 0012's STRIP topology - the
  // exact topology where the mediated WebSocket pathname also will not be claimed (hmrBase
  // symmetry, RFC 0013 §3.3), so the never-wired warning is most needed there. These two cells
  // pin both received spellings: strip (mountPrefix '' + publicBasePath non-empty, so Fastify
  // receives the UNPREFIXED path) and a preserve control (mountPrefix === publicBasePath, so
  // Fastify receives the prefixed path, matching every earlier cell in this file).
  it("STRIP topology (mountPrefix '' + publicBasePath '/pub'): GET /@vite/client (as Fastify receives it) calls noteClientServed() exactly once", async () => {
    const { port } = await boot({ mountPrefix: '', publicBasePath: '/pub' });

    const status = await getStatus(port, '/@vite/client');
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);

    await vi.waitFor(() => expect(noteClientServedCalls).toHaveLength(1));
  });

  it("PRESERVE topology control (mountPrefix '/pub' + publicBasePath '/pub'): GET /pub/@vite/client calls noteClientServed() exactly once", async () => {
    const { port } = await boot({ mountPrefix: '/pub', publicBasePath: '/pub' });

    const status = await getStatus(port, '/pub/@vite/client');
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);

    await vi.waitFor(() => expect(noteClientServedCalls).toHaveLength(1));
  });
});
