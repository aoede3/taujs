// @vitest-environment node
import fastify from 'fastify';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { REGEX } from '../core/constants';

const { handleRenderMock, handleNotFoundMock, authHookFn, seenByAuth } = vi.hoisted(() => {
  const seenByAuth: { requestId?: string }[] = [];
  return {
    handleRenderMock: vi.fn(async (req: any, reply: any) => {
      if (req.url.startsWith('/spa')) return reply.callNotFound();
      reply.status(200).send({ requestId: req.taujsRequestContext?.requestId ?? null });
    }),
    handleNotFoundMock: vi.fn(async (req: any, reply: any) => {
      reply.status(200).send({ fallthrough: true, requestId: req.taujsRequestContext?.requestId ?? null });
    }),
    authHookFn: vi.fn((req: any, _reply: any, done: any) => {
      seenByAuth.push({ requestId: req.taujsRequestContext?.requestId });
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
    templates: new Map(),
  })),
  loadAssets: vi.fn(async () => {}),
  processConfigs: vi.fn((configs: any[]) => configs),
}));
vi.mock('../utils/StaticAssets', () => ({ registerStaticAssets: vi.fn(async () => {}) }));

async function buildApp() {
  const { ssrServerPlugin } = await import('../SSRServer');
  const app = fastify();
  // RFC 0010: this suite was written against the root-installing plugin, so the faithful
  // translation is the τjs-created form. Request context on τjs routes is identical in both.
  await app.register(ssrServerPlugin({ callerOwnedHost: false }) as any, {
    configs: [{ appId: 'web', entryPoint: 'web' }],
    routes: [{ path: '/page', appId: 'web', attr: { render: 'ssr' } }],
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

describe('request-context hoist (P0B-01)', () => {
  it('rendered requests carry x-request-id and the handler sees the hoisted context', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/page' });

    const headerRequestId = res.headers['x-request-id'] as string;
    expect(REGEX.SAFE_REQUEST_ID.test(headerRequestId)).toBe(true);
    expect(res.json().requestId).toBe(headerRequestId);
  });

  it('an inbound x-request-id is never reinterpreted after construction: the host req.id echoes (SC-09)', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/page', headers: { 'x-request-id': 'custom-abc-123' } });

    // This host configured no construction-time adoption (`genReqId`), so its own req.id is the
    // canonical identity; τjs does not select the header on its behalf.
    expect(res.headers['x-request-id']).not.toBe('custom-abc-123');
    expect(REGEX.SAFE_REQUEST_ID.test(res.headers['x-request-id'] as string)).toBe(true);
    expect(res.json().requestId).toBe(res.headers['x-request-id']);
  });

  it('fallthrough responses carry a valid x-request-id and the same context reaches handleNotFound', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/spa/anything' });

    const headerRequestId = res.headers['x-request-id'] as string;
    expect(REGEX.SAFE_REQUEST_ID.test(headerRequestId)).toBe(true);
    expect(res.json()).toEqual({ fallthrough: true, requestId: headerRequestId });
    expect(handleNotFoundMock).toHaveBeenCalledTimes(1);
  });

  it('two requests get different request ids', async () => {
    const app = await buildApp();

    const a = await app.inject({ method: 'GET', url: '/page' });
    const b = await app.inject({ method: 'GET', url: '/page' });

    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('hook order: the auth hook already sees the request context (context first)', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/page' });

    expect(seenByAuth).toEqual([{ requestId: res.headers['x-request-id'] }]);
  });

  it('non-dev boot registers no /__taujs routes and no introspection state (spec 03 §8 #1)', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/__taujs/graph', headers: { 'x-taujs-token': 'anything' } });

    // No overlay route exists: Fastify sends the URL through the ordinary τjs not-found path.
    expect(handleRenderMock).not.toHaveBeenCalled();
    expect(handleNotFoundMock).toHaveBeenCalledTimes(1);
    expect(res.json().requestId).toBeTruthy();
    expect((app as any).taujsIntrospection).toBeUndefined();
  });
});
