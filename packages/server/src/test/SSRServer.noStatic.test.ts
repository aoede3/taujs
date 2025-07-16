import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

import type { FastifyInstance } from 'fastify';

vi.doMock('@fastify/static', () => {
  throw new Error('Module not found');
});

describe('SSRServer without static plugin installed', () => {
  it('throws error if @fastify/static is not installed and no registerStaticAssets provided', async () => {
    const app: FastifyInstance = Fastify();
    const { SSRServer } = await import('../SSRServer');

    await expect(
      app.register(SSRServer, {
        clientRoot: 'dummy',
        configs: [],
        routes: [],
        serviceRegistry: {},
      }),
    ).rejects.toThrow('Static asset handling requires @fastify/static to be installed');
  });
});
