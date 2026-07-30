import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../AppError';
import { InitialDataFailure } from '../InitialDataFailure';
import { logResponseFailure } from '../ResponseFailureLog';

const fastifyContext = (error: unknown, logger: any) => ({
  terminal: 'fastify' as const,
  logger,
  error,
  method: 'GET',
  url: '/products/42',
  route: '/products/:id',
});

describe('logResponseFailure', () => {
  it('logs an expected initial-data failure once at warn without a stack', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const failure = new InitialDataFailure(AppError.badRequest('invalid product', { field: 'id' }, 'E_ID'), { id: '42' });

    logResponseFailure(fastifyContext(failure, logger));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'fetch-initial-data',
        origin: 'attr.data',
        kind: 'validation',
        httpStatus: 400,
        code: 'E_ID',
        params: { id: '42' },
      }),
      'invalid product',
    );
    expect(logger.warn.mock.calls[0]![0].stack).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an unexpected initial-data failure with its stack at the streaming terminal', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const failure = new InitialDataFailure(AppError.internal('upstream failed'), { id: '42' });

    logResponseFailure({ terminal: 'streaming', logger, error: failure, clientRoot: '/client', url: '/products/42' });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'fetch-initial-data', clientRoot: '/client', url: '/products/42', stack: expect.any(String) }),
      'upstream failed',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('preserves the existing non-initial terminal formatting', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };

    logResponseFailure({ terminal: 'streaming', logger, error: new Error('render boom'), clientRoot: '/client', url: '/products/42' });

    expect(logger.error).toHaveBeenCalledWith(
      { error: expect.objectContaining({ message: 'render boom' }), clientRoot: '/client', url: '/products/42' },
      'Critical rendering error during stream',
    );
  });

  it('contains a throwing logger so the caller can still terminate the response', () => {
    const logger = {
      warn: vi.fn(() => {
        throw new Error('logger down');
      }),
      error: vi.fn(() => {
        throw new Error('logger down');
      }),
    };
    const failure = new InitialDataFailure(AppError.badRequest('invalid'), {});

    expect(() => logResponseFailure(fastifyContext(failure, logger))).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
