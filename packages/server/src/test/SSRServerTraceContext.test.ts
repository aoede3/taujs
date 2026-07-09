// @vitest-environment node
import fastify from 'fastify';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { REGEX } from '../core/constants';

const { handleRenderMock, handleNotFoundMock, authHookFn, seenByAuth } = vi.hoisted(() => {
  const seenByAuth: { traceId?: string }[] = [];
  return {
    handleRenderMock: vi.fn(async (req: any, reply: any) => {
      if (req.url.startsWith('/spa')) return reply.callNotFound();
      reply.status(200).send({ traceId: req.taujsRequestContext?.traceId ?? null });
    }),
    handleNotFoundMock: vi.fn(async (req: any, reply: any) => {
      reply.status(200).send({ fallthrough: true, traceId: req.taujsRequestContext?.traceId ?? null });
    }),
    authHookFn: vi.fn((req: any, _reply: any, done: any) => {
      seenByAuth.push({ traceId: req.taujsRequestContext?.traceId });
      done();
    }),
    seenByAuth,
  };
});

vi.mock('../utils/HandleRender', () => ({ handleRender: handleRenderMock }));
vi.mock('../utils/HandleNotFound', () => ({ handleNotFound: handleNotFoundMock }));
vi.mock('../security/Auth', () => ({ createAuthHook: vi.fn(() => authHookFn) }));
vi.mock('../security/CSP', () => ({ cspPlugin: vi.fn(async () => {}) }));
vi.mock('../utils/AssetManager', () => ({
  createMaps: vi.fn(() => ({
    bootstrapModules: new Map(),
    cssLinks: new Map(),
    manifests: new Map(),
    preloadLinks: new Map(),
    renderModules: new Map(),
    ssrManifests: new Map(),
    templates: new Map(),
  })),
  loadAssets: vi.fn(async () => {}),
  processConfigs: vi.fn((configs: any[]) => configs),
}));
vi.mock('../utils/StaticAssets', () => ({ registerStaticAssets: vi.fn(async () => {}) }));

async function buildApp() {
  const { SSRServer } = await import('../SSRServer');
  const app = fastify();
  await app.register(SSRServer as any, {
    configs: [{ appId: 'web', entryPoint: 'web' }],
    routes: [],
    clientRoot: '/tmp/none',
    serviceRegistry: {},
    staticAssets: false,
  });
  return app;
}

beforeEach(() => {
  seenByAuth.length = 0;
  handleRenderMock.mockClear();
  handleNotFoundMock.mockClear();
  authHookFn.mockClear();
});

describe('trace-context hoist (P0B-01)', () => {
  it('rendered requests carry x-trace-id and the handler sees the hoisted context', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/page' });

    const headerTraceId = res.headers['x-trace-id'] as string;
    expect(REGEX.SAFE_TRACE.test(headerTraceId)).toBe(true);
    expect(res.json().traceId).toBe(headerTraceId);
  });

  it('a supplied valid x-trace-id echoes back on the response', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/page', headers: { 'x-trace-id': 'custom-abc-123' } });

    expect(res.headers['x-trace-id']).toBe('custom-abc-123');
    expect(res.json().traceId).toBe('custom-abc-123');
  });

  it('fallthrough responses carry a valid x-trace-id and the same context reaches handleNotFound', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/spa/anything' });

    const headerTraceId = res.headers['x-trace-id'] as string;
    expect(REGEX.SAFE_TRACE.test(headerTraceId)).toBe(true);
    expect(res.json()).toEqual({ fallthrough: true, traceId: headerTraceId });
    expect(handleNotFoundMock).toHaveBeenCalledTimes(1);
  });

  it('two requests get different trace ids', async () => {
    const app = await buildApp();

    const a = await app.inject({ method: 'GET', url: '/page' });
    const b = await app.inject({ method: 'GET', url: '/page' });

    expect(a.headers['x-trace-id']).not.toBe(b.headers['x-trace-id']);
  });

  it('hook order: the auth hook already sees the trace context (trace first)', async () => {
    const app = await buildApp();

    await app.inject({ method: 'GET', url: '/page', headers: { 'x-trace-id': 'order-check-1' } });

    expect(seenByAuth).toEqual([{ traceId: 'order-check-1' }]);
  });
});
