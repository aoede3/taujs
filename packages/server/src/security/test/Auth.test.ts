// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  matchRouteMock: vi.fn(),
}));

vi.mock('../../utils/DataRoutes', () => ({
  matchRoute: hoisted.matchRouteMock,
}));

import { createAuthHook } from '../Auth';

const { matchRouteMock } = hoisted;

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
    matchRouteMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeReqReply(opts: { url?: string; host?: string; method?: string; authenticate?: ((req: any, reply: any) => any) | undefined }) {
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as any;
    const req = {
      url: opts.url ?? '/path?x=1',
      method: opts.method ?? 'GET',
      headers: { host: opts.host ?? 'example.test' },
      server: {
        authenticate: opts.authenticate,
      },
    } as any;
    const done = vi.fn(); // for Fastify onRequest callback-style signature
    return { req, reply, done };
  }

  it('returns early when no route matches', async () => {
    matchRouteMock.mockReturnValue(undefined);

    const hook = createAuthHook([], logger as any);
    const { req, reply, done } = makeReqReply({});

    await (hook as any).call({} as any, req, reply, done);

    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
    expect(matchRouteMock).toHaveBeenCalledWith('/path', []);
  });

  it('logs debug "(none)" and returns when route has no auth config', async () => {
    matchRouteMock.mockReturnValue({
      route: { appId: 'appA', attr: { middleware: {} } },
      params: {},
    });

    const hook = createAuthHook([], logger as any);
    const { req, reply, done } = makeReqReply({ url: '/noauth?y=2', host: 'localhost:3000', method: 'POST' });

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
    matchRouteMock.mockReturnValue({
      route: { appId: 'appB', attr: { middleware: { auth: { required: true } } } },
      params: {},
    });

    const hook = createAuthHook([], logger as any);
    const { req, reply, done } = makeReqReply({
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

    matchRouteMock.mockReturnValue({
      route: { appId: 'appC', attr: { middleware: { auth: { roles: ['user'] } } } },
      params: {},
    });

    const hook = createAuthHook([], logger as any);
    const { req, reply, done } = makeReqReply({
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

    matchRouteMock.mockReturnValue({
      route: { appId: 'appD', attr: { middleware: { auth: true } } },
      params: {},
    });

    const hook = createAuthHook([], logger as any);
    const { req, reply, done } = makeReqReply({
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
});
