import { describe, expect, test, vi, beforeEach } from 'vitest';

import { verifyContracts, isAuthRequired, hasAuthenticate } from '../verifyMiddleware';

import type { FastifyInstance } from 'fastify';
import type { Route } from '../../types';

const logSpy = vi.fn();
const errorSpy = vi.fn();

vi.mock('../../utils/Logger', async () => {
  const actual = await vi.importActual<typeof import('../../utils/Logger')>('../../utils/Logger');

  return {
    ...actual,
    createLogger: () => ({
      log: logSpy,
      warn: vi.fn(),
      error: errorSpy,
    }),
  };
});

describe('verifyContracts full functional coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('covers isAuthRequired true and hasAuthenticate true', () => {
    const contracts = [
      {
        key: 'auth',
        required: isAuthRequired,
        verify: hasAuthenticate,
        errorMessage: 'Missing .authenticate',
      },
    ];

    const routes: Route[] = [
      {
        path: '/should-pass',
        attr: {
          render: 'ssr',
          middleware: {
            auth: {
              required: true,
            },
          },
        },
      },
    ];

    const app = {
      authenticate: () => {},
    } as unknown as FastifyInstance;

    expect(() => verifyContracts(app, routes, contracts, true)).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Middleware "auth" verified ✓$/));
  });

  test('covers isAuthRequired false', () => {
    const contracts = [
      {
        key: 'auth',
        required: isAuthRequired,
        verify: hasAuthenticate,
        errorMessage: 'Missing .authenticate',
      },
    ];

    const routes: Route[] = [
      {
        path: '/auth-not-required',
        attr: {
          render: 'ssr',
          middleware: {
            auth: {
              required: false,
            },
          },
        },
      },
    ];

    const app = {
      authenticate: () => {},
    } as unknown as FastifyInstance;

    expect(() => verifyContracts(app, routes, contracts, true)).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Middleware "auth" not used/));
  });

  test('covers hasAuthenticate false', () => {
    const contracts = [
      {
        key: 'auth',
        required: isAuthRequired,
        verify: hasAuthenticate,
        errorMessage: 'Missing .authenticate',
      },
    ];

    const routes: Route[] = [
      {
        path: '/auth-required',
        attr: {
          render: 'ssr',
          middleware: {
            auth: {
              required: true,
            },
          },
        },
      },
    ];

    const app = {} as unknown as FastifyInstance;

    expect(() => verifyContracts(app, routes, contracts, true)).toThrow('[τjs] Missing .authenticate');
    expect(errorSpy).toHaveBeenCalledWith('[τjs] Missing .authenticate');
  });
});
