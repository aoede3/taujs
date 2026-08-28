// @vitest-environment node
import type { AddressInfo } from 'node:net';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { testRenderer } from './support/renderer';

import type { TaujsConfig } from '../Config';
import type { BaseLogger } from '../core/logging/types';

// Real boot: only SSRServer is mocked (a real no-op plugin function), so createServer's own
// wiring - resolveNet, bannerPlugin, Fastify itself - runs for real end to end.
vi.mock('../SSRServer', () => ({ ssrServerPlugin: () => async () => {} }));

const ORIG_ENV = { ...process.env };
const ORIG_ARGV = [...process.argv];

function setEnv(env: Record<string, string | undefined>) {
  Object.keys(process.env).forEach((k) => delete (process.env as any)[k]);
  Object.assign(process.env, ORIG_ENV, env);
}

function setArgv(args: string[]) {
  process.argv.splice(0, process.argv.length, ...args);
}

const silentLogger: BaseLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

const configWith = (routes: readonly unknown[], server?: Record<string, unknown>): TaujsConfig =>
  ({
    ...(server ? { server } : {}),
    apps: [{ appId: 'web', entryPoint: 'web', renderer: testRenderer(), routes }],
  }) as TaujsConfig;

beforeEach(() => {
  setEnv({ PORT: undefined, FASTIFY_PORT: undefined });
  delete process.env.PORT;
  delete process.env.FASTIFY_PORT;
  setArgv(['node', 'script.js']);
});

afterEach(() => {
  setEnv({});
  setArgv(ORIG_ARGV);
});

describe('createServer({ port }) real boot', () => {
  it('port: 0 requests an ephemeral port and the caller can listen and read it back', async () => {
    const { createServer } = await import('../CreateServer');

    const config = configWith([]);

    const { app, net } = await createServer({ config, port: 0, logger: silentLogger });

    try {
      expect(net.port).toBe(0);

      await app!.listen({ host: '127.0.0.1', port: net.port });
      expect((app!.server.address() as AddressInfo).port).toBeGreaterThan(0);
    } finally {
      await app!.close();
    }
  });
});
