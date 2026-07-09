// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { TaujsConfig } from '../Config';

// Evaluation counter proves the acceptance criterion directly: in production the
// introspection module is never dynamically imported, not merely unused.
const hoisted = vi.hoisted(() => ({
  emitGraphEvaluations: 0,
  registerBootGraphEmission: vi.fn(),
}));

vi.mock('../core/introspection/EmitGraph', () => {
  hoisted.emitGraphEvaluations += 1;
  return { registerBootGraphEmission: hoisted.registerBootGraphEmission };
});

vi.mock('../SSRServer', () => ({
  SSRServer: { __id: 'ssr-server-plugin' },
}));

vi.mock('../network/Network', () => ({
  bannerPlugin: { __id: 'banner-plugin' },
}));

vi.mock('../network/CLI', () => ({
  resolveNet: vi.fn(() => ({ host: '127.0.0.1', port: 5173, hmrPort: 5174 })),
}));

const config: TaujsConfig = {
  apps: [{ appId: 'web', entryPoint: 'web', routes: [{ path: '/', attr: { render: 'ssr' } }] }],
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

  it('development boot lazy-loads the module and registers emission with config + registry + logger', async () => {
    process.env.NODE_ENV = 'development';
    vi.resetModules();
    const { createServer } = await import('../CreateServer');
    const app = mkApp();
    const serviceRegistry = { catalog: {} } as any;

    await createServer({ config, fastify: app, serviceRegistry });

    expect(hoisted.emitGraphEvaluations).toBe(1);
    expect(hoisted.registerBootGraphEmission).toHaveBeenCalledTimes(1);
    const [calledApp, calledConfig, calledRegistry, calledLogger] = hoisted.registerBootGraphEmission.mock.calls[0]!;
    expect(calledApp).toBe(app);
    expect(calledConfig).toBe(config);
    expect(calledRegistry).toBe(serviceRegistry);
    expect(calledLogger).toBeTruthy();
  });

  it('a failing emission module degrades to a warning, never a failed boot', async () => {
    hoisted.registerBootGraphEmission.mockImplementationOnce(() => {
      throw new Error('hostile emission module');
    });

    await expect(bootWith('development')).resolves.toBeTruthy();
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
