// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { testRenderer } from './support/renderer';

import type { TaujsConfig } from '../Config';

// Evaluation counter proves the acceptance criterion directly: in production the
// introspection module is never dynamically imported, not merely unused.
const hoisted = vi.hoisted(() => ({
  emitGraphEvaluations: 0,
  registerBootGraphEmission: vi.fn(),
  fastifyFactoryCalls: 0,
}));

// Counter proves the before-host-mutation criterion on the τjs-created arm directly: an
// invalid configuration must fail before the Fastify factory is ever invoked, not merely
// before registrations land on an already-created instance.
vi.mock('fastify', () => ({
  default: vi.fn(() => {
    hoisted.fastifyFactoryCalls += 1;
    return { register: vi.fn(async () => undefined), addHook: vi.fn(), log: undefined };
  }),
}));

vi.mock('../core/introspection/EmitGraph', () => {
  hoisted.emitGraphEvaluations += 1;
  return { registerBootGraphEmission: hoisted.registerBootGraphEmission };
});

vi.mock('../SSRServer', () => ({
  ssrServerPlugin: () => ({ __id: 'ssr-server-plugin' }),
}));

vi.mock('../network/Network', () => ({
  bannerPlugin: { __id: 'banner-plugin' },
}));

vi.mock('../network/CLI', () => ({
  resolveNet: vi.fn(() => ({ host: '127.0.0.1', port: 5173, hmrPort: 5174 })),
}));

const config: TaujsConfig = {
  apps: [{ appId: 'web', entryPoint: 'web', renderer: testRenderer(), routes: [{ path: '/', attr: { render: 'ssr' } }] }],
};

const mkApp = () =>
  ({
    register: vi.fn(async () => undefined),
    addHook: vi.fn(),
    log: undefined,
  }) as any;

const originalNodeEnv = process.env.NODE_ENV;
const originalConsoleLog = console.log;

async function bootWith(nodeEnv: string) {
  process.env.NODE_ENV = nodeEnv;
  vi.resetModules();
  const { createServer } = await import('../CreateServer');
  const app = mkApp();
  await createServer({ config, fastify: app });
  return app;
}

beforeEach(() => {
  hoisted.emitGraphEvaluations = 0;
  hoisted.registerBootGraphEmission.mockClear();
  hoisted.fastifyFactoryCalls = 0;
  console.log = vi.fn();
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  console.log = originalConsoleLog;
});

describe('createServer — graph emission wiring (structural gate)', () => {
  it('production boot never loads the introspection module and registers no hook', async () => {
    const app = await bootWith('production');

    expect(hoisted.emitGraphEvaluations).toBe(0);
    expect(hoisted.registerBootGraphEmission).not.toHaveBeenCalled();
    expect(app.addHook).not.toHaveBeenCalled();
  });

  // RFC 0010 delta: boot-graph emission used to be wired here, on whatever instance `createServer`
  // was handed - which on a caller-owned host meant an `onListen` hook on the caller's root. It now
  // registers inside the scope τjs owns, next to the dev files and recorder that share its
  // lifecycle, so `createServer` neither loads the emission module nor registers a hook.
  //
  // This file can only prove the negative half, because it mocks the SSR plugin out. The positive
  // half - that the owned scope acquired the registration and emits exactly once after a real
  // `listen()` - is proved by `HostOwnershipDevelopment.test.ts` against a real Vite boot and the
  // real graph artefact. Without that pairing, deleting the registration outright would leave every
  // assertion here green.
  it('development boot no longer wires emission here: the owned scope owns it', async () => {
    process.env.NODE_ENV = 'development';
    vi.resetModules();
    const { createServer } = await import('../CreateServer');
    const app = mkApp();
    const serviceRegistry = { catalog: {} } as any;

    await createServer({ config, fastify: app, serviceRegistry });

    expect(hoisted.emitGraphEvaluations).toBe(0);
    expect(hoisted.registerBootGraphEmission).not.toHaveBeenCalled();
    expect(app.addHook).not.toHaveBeenCalled();
  });

  it('a failing emission module degrades to a warning, never a failed boot', async () => {
    hoisted.registerBootGraphEmission.mockImplementationOnce(() => {
      throw new Error('hostile emission module');
    });

    await expect(bootWith('development')).resolves.toBeTruthy();
  });

  // Post-freeze ruling 2026-08-08: the admission shout wording is FROZEN at review; these cells
  // test the exact message, development-only emission, and absence when the list is empty.
  it('introspection.allowedHosts shouts the exact frozen warning in dev, never in prod, never when empty', async () => {
    const shoutText =
      'τjs introspection overlay admits additional hostnames. Ensure any rewriting proxy validates the browser-facing Host; otherwise use a trusted development network only.';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const declared = { ...config, introspection: { allowedHosts: ['web.plt.local'] } };

    try {
      process.env.NODE_ENV = 'development';
      vi.resetModules();
      let { createServer } = await import('../CreateServer');
      await createServer({ config: declared, fastify: mkApp() });
      expect(warnSpy.mock.calls.some((c) => c.join(' ').includes(shoutText))).toBe(true);

      warnSpy.mockClear();
      await createServer({ config: { ...config, introspection: { allowedHosts: [] } }, fastify: mkApp() });
      expect(warnSpy.mock.calls.some((c) => c.join(' ').includes(shoutText))).toBe(false);

      warnSpy.mockClear();
      process.env.NODE_ENV = 'production';
      vi.resetModules();
      ({ createServer } = await import('../CreateServer'));
      await createServer({ config: declared, fastify: mkApp() });
      expect(warnSpy.mock.calls.some((c) => c.join(' ').includes(shoutText))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('an invalid introspection.allowedHosts fails in EVERY mode BEFORE any host mutation', async () => {
    for (const mode of ['development', 'production']) {
      process.env.NODE_ENV = mode;
      vi.resetModules();
      const { createServer } = await import('../CreateServer');
      const app = mkApp();

      await expect(createServer({ config: { ...config, introspection: { allowedHosts: ['web.plt.local:3042'] } }, fastify: app }), mode).rejects.toThrow(
        /not an exact DNS hostname/,
      );
      // The caller-supplied host was never touched: validation precedes registration entirely.
      expect(app.register, mode).not.toHaveBeenCalled();
      expect(app.addHook, mode).not.toHaveBeenCalled();
    }
  });

  it('an invalid introspection.allowedHosts on a τjs-CREATED host fails BEFORE Fastify creation, in every mode', async () => {
    for (const mode of ['development', 'production']) {
      process.env.NODE_ENV = mode;
      vi.resetModules();
      const { createServer } = await import('../CreateServer');

      await expect(createServer({ config: { ...config, introspection: { allowedHosts: ['.plt.local'] } } }), mode).rejects.toThrow(/not an exact DNS hostname/);
      // The factory counter is the stronger half of the before-host-mutation contract: no
      // Fastify instance ever existed, so there was nothing to mutate.
      expect(hoisted.fastifyFactoryCalls, mode).toBe(0);
    }
  });

  it('allowNonLoopback shouts the exact boot-summary warning in dev, and never in prod', async () => {
    const shoutText = 'τjs introspection overlay exposed to non-loopback clients. For trusted dev networks only.';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      process.env.NODE_ENV = 'development';
      vi.resetModules();
      let { createServer } = await import('../CreateServer');
      await createServer({ config: { ...config, introspection: { allowNonLoopback: true } }, fastify: mkApp() });
      expect(warnSpy.mock.calls.some((c) => c.join(' ').includes(shoutText))).toBe(true);

      warnSpy.mockClear();
      process.env.NODE_ENV = 'production';
      vi.resetModules();
      ({ createServer } = await import('../CreateServer'));
      await createServer({ config: { ...config, introspection: { allowNonLoopback: true } }, fastify: mkApp() });
      expect(warnSpy.mock.calls.some((c) => c.join(' ').includes(shoutText))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
