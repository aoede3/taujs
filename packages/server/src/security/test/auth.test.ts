import { describe, it, vi, expect } from 'vitest';
import { createAuthHook } from '../Auth';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Route } from '../../types';

const mockReply = () => {
  return {
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
  } as unknown as FastifyReply;
};

const makeReq = (url: string, authenticate?: () => Promise<void>, log?: any): FastifyRequest => {
  const req = {
    url,
    headers: { host: 'localhost' },
    server: authenticate ? { authenticate } : {},
    log: log || { warn: vi.fn() },
  };
  return req as unknown as FastifyRequest;
};

describe('createAuthHook', () => {
  it('does nothing if route has no auth config', async () => {
    const routes: Route[] = [{ path: '/public' }];
    const hook = createAuthHook(routes);

    const req = makeReq('/public');
    const reply = mockReply();

    await hook(req, reply);
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('does nothing if auth.required is false', async () => {
    const routes: Route[] = [{ path: '/semi', attr: { render: 'ssr', middleware: { auth: { required: false } } } }];
    const hook = createAuthHook(routes);

    const req = makeReq('/semi');
    const reply = mockReply();

    await hook(req, reply);
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('warns and sends 500 if authenticate is missing', async () => {
    const log = { warn: vi.fn() };
    const routes: Route[] = [{ path: '/protected', attr: { render: 'ssr', middleware: { auth: { required: true } } } }];
    const hook = createAuthHook(routes);

    const req = makeReq('/protected', undefined, log);
    const reply = mockReply();

    await hook(req, reply);

    expect(log.warn).toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith('Server misconfiguration: auth decorator missing.');
  });

  it('calls authenticate if required and present', async () => {
    const authenticate = vi.fn().mockResolvedValue(undefined);
    const routes: Route[] = [
      {
        path: '/secure',
        attr: {
          render: 'streaming',
          meta: {},
          middleware: { auth: { required: true } },
        },
      },
    ];
    const hook = createAuthHook(routes);

    const req = makeReq('/secure', authenticate);
    const reply = mockReply();

    await hook(req, reply);

    expect(authenticate).toHaveBeenCalledWith(req, reply);
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('sends error if authenticate throws', async () => {
    const authenticate = vi.fn().mockRejectedValue(new Error('fail'));
    const routes: Route[] = [{ path: '/fail', attr: { render: 'streaming', meta: {}, middleware: { auth: { required: true } } } }];
    const hook = createAuthHook(routes);

    const req = makeReq('/fail', authenticate);
    const reply = mockReply();

    await hook(req, reply);

    expect(authenticate).toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith(expect.any(Error));
  });
});
