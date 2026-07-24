// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createAuthHook } from '../Auth';
import { fastifyConfigForRoute } from '../../core/routes/FastifyRoutes';
import type { Route } from '../../core/config/types';

describe('createAuthHook', () => {
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeReqReply(opts: { url?: string; host?: string; method?: string; authenticate?: ((req: any, reply: any) => any) | undefined; route?: Route }) {
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as any;
    const req = {
      url: opts.url ?? '/path?x=1',
      method: opts.method ?? 'GET',
      headers: { host: opts.host ?? 'example.test' },
      routeOptions: { config: opts.route ? fastifyConfigForRoute(opts.route) : {} },
      params: {},
      server: {
        authenticate: opts.authenticate,
      },
    } as any;
    const done = vi.fn(); // for Fastify onRequest callback-style signature
    return { req, reply, done };
  }

  it('does not apply taujs auth metadata to a host-owned or unmatched Fastify route', async () => {
    const authenticate = vi.fn();
    const hook = createAuthHook(logger as any);
    const { req, reply, done } = makeReqReply({ url: '/admin/metrics', authenticate });

    await (hook as any).call({} as any, req, reply, done);

    expect(authenticate).not.toHaveBeenCalled();
    expect(req.routeMeta).toBeUndefined();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('logs debug "(none)" and returns when route has no auth config', async () => {
    const route = { appId: 'appA', attr: { render: 'ssr', middleware: {} } } as Route;

    const hook = createAuthHook(logger as any);
    const { req, reply, done } = makeReqReply({ route, url: '/noauth?y=2', host: 'localhost:3000', method: 'POST' });

    await (hook as any).call({} as any, req, reply, done);

    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      'auth',
      {
        method: 'POST',
        url: '/noauth?y=2',
      },
      '(none)',
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('warns and replies 500 when auth required but server.authenticate is missing', async () => {
    const route = { path: '/secure', appId: 'appB', attr: { render: 'ssr', middleware: { auth: { required: true } } } } as Route;

    const hook = createAuthHook(logger as any);
    const { req, reply, done } = makeReqReply({
      route,
      url: '/secure?z=3',
      host: '0.0.0.0:5173',
      method: 'GET',
      authenticate: undefined,
    });

    await (hook as any).call({} as any, req, reply, done);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ path: '/secure', appId: 'appB' }, 'Route requires auth but Fastify authenticate decorator is missing');
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith('Server misconfiguration: auth decorator missing.');
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('invokes authenticate and logs success when auth passes', async () => {
    const authenticate = vi.fn(async () => {
      /* success */
    });

    const route = { appId: 'appC', attr: { render: 'ssr', middleware: { auth: { roles: ['user'] } } } } as Route;

    const hook = createAuthHook(logger as any);
    const { req, reply, done } = makeReqReply({
      route,
      url: '/auth/success?ok=1',
      host: 'example.com',
      method: 'PUT',
      authenticate,
    });

    await (hook as any).call({} as any, req, reply, done);

    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenNthCalledWith(
      1,
      'auth',
      {
        method: 'PUT',
        url: '/auth/success?ok=1',
      },
      'Invoking authenticate(...)',
    );
    expect(authenticate).toHaveBeenCalledWith(req, reply);
    expect(logger.debug).toHaveBeenNthCalledWith(
      2,
      'auth',
      {
        method: 'PUT',
        url: '/auth/success?ok=1',
      },
      'Authentication successful',
    );
    expect(reply.send).not.toHaveBeenCalled();
    expect(reply.status).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('invokes authenticate and sends error when it throws', async () => {
    const err = new Error('nope');
    const authenticate = vi.fn(async () => {
      throw err;
    });

    const route = { path: '/auth/fail', appId: 'appD', attr: { render: 'ssr', middleware: { auth: {} } } } as Route;

    const hook = createAuthHook(logger as any);
    const { req, reply, done } = makeReqReply({
      route,
      url: '/auth/fail?q=1',
      host: 'dev.local:1234',
      method: 'DELETE',
      authenticate,
    });

    await (hook as any).call({} as any, req, reply, done);

    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenNthCalledWith(
      1,
      'auth',
      {
        method: 'DELETE',
        url: '/auth/fail?q=1',
      },
      'Invoking authenticate(...)',
    );
    expect(logger.debug).toHaveBeenNthCalledWith(
      2,
      'auth',
      {
        method: 'DELETE',
        url: '/auth/fail?q=1',
      },
      'Authentication failed',
    );
    expect(reply.send).toHaveBeenCalledWith(err);
    expect(reply.status).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not log success when the decorator rejects by sending a reply without throwing', async () => {
    const authenticate = vi.fn(async (_req: any, reply: any) => {
      // Documented non-throwing rejection: reply.code(401).send(); return;
      reply.sent = true;
    });

    const route = { appId: 'appG', attr: { render: 'ssr', middleware: { auth: { strategy: 'jwt' } } } } as Route;

    const hook = createAuthHook(logger as any);
    const { req, reply, done } = makeReqReply({ route, url: '/auth/soft-reject', authenticate });

    await (hook as any).call({} as any, req, reply, done);

    expect(logger.debug).toHaveBeenNthCalledWith(
      2,
      'auth',
      {
        method: 'GET',
        url: '/auth/soft-reject',
      },
      'Authentication handled by decorator (reply already sent)',
    );
    expect(logger.debug).not.toHaveBeenCalledWith('auth', expect.anything(), 'Authentication successful');
  });
});
