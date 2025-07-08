import { describe, expect, test, vi, beforeEach } from 'vitest';
import { verifyContracts } from '../security/verifyMiddleware';
import type { FastifyInstance } from 'fastify';
import type { Route } from '../SSRServer';

const mockLogger = {
  error: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
};

vi.mock('../utils/Logger', async () => {
  const actual = await vi.importActual<typeof import('../utils/Logger')>('../utils/Logger');
  return {
    ...actual,
    createLogger: () => mockLogger,
  };
});

describe('verifyContracts full coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    {
      path: '/auth-optional',
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

  test('covers required and verify functions when all valid', () => {
    const app = {
      authenticate: () => {},
    } as unknown as FastifyInstance;

    expect(() =>
      verifyContracts(
        app,
        routes,
        [
          {
            key: 'auth',
            required: (r) => r.attr?.middleware?.auth?.required === true,
            verify: (app) => typeof app.authenticate === 'function',
            errorMessage: 'Missing .authenticate',
          },
        ],
        true,
      ),
    ).not.toThrow();

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.log).toHaveBeenCalled();
  });

  test('calls debugLog when middleware is not used in any route', () => {
    const app = {} as FastifyInstance;

    const routes: Route[] = [{ path: '/no-middleware', attr: { render: 'ssr' } }];

    verifyContracts(
      app,
      routes,
      [
        {
          key: 'auth',
          required: (r) => r.attr?.middleware?.auth?.required === true,
          verify: () => false, // won't be called
          errorMessage: 'should not be thrown',
        },
      ],
      true,
    );

    expect(mockLogger.log).toHaveBeenCalledWith('[τjs]  Middleware "auth" not used in any routes');
  });
});
