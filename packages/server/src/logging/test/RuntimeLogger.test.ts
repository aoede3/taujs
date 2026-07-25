// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createRuntimeLogger, createRuntimeRequestLogger, type RuntimeLoggerSelection } from '../RuntimeLogger';

const selection = (custom?: RuntimeLoggerSelection['custom']): RuntimeLoggerSelection => ({
  source: custom ? 'fastify' : 'fallback',
  custom,
  debug: ['ssr'],
  minLevel: 'debug',
});

describe('createRuntimeLogger', () => {
  it('binds component context through a child-capable sink exactly once', () => {
    const info = vi.fn();
    const child = vi.fn(() => ({ info }));

    const logger = createRuntimeLogger(selection({ child }), {
      context: { component: 'ssr-server' },
      includeContext: true,
      singleLine: true,
    });

    logger.info({ route: '/' }, 'ready');

    expect(child).toHaveBeenCalledWith({ component: 'ssr-server' });
    expect(info).toHaveBeenCalledWith({ route: '/' }, 'ready');
  });

  it('keeps structured context for a plain sink without child()', () => {
    const info = vi.fn();
    const logger = createRuntimeLogger(selection({ info }), {
      context: { component: 'ssr-server' },
      includeContext: true,
    });

    logger.info({ route: '/' }, 'ready');

    expect(info).toHaveBeenCalledWith({ context: { component: 'ssr-server' }, route: '/' }, 'ready');
  });

  it('derives Fastify-owned requests from req.log without rebinding reqId', () => {
    const info = vi.fn();
    const requestChild = vi.fn(() => ({ info }));
    const appChild = vi.fn();
    const selected: RuntimeLoggerSelection = {
      source: 'fastify',
      custom: { child: appChild },
      minLevel: 'debug',
    };
    const req = { id: 'req-1', log: { child: requestChild } } as any;

    const logger = createRuntimeRequestLogger(selected, req, {
      component: 'ssr-server',
      traceId: 'trace-1',
      reqId: 'req-1',
      url: '/products',
      method: 'GET',
    });
    logger.info({ route: '/products' }, 'rendered');

    expect(appChild).not.toHaveBeenCalled();
    expect(requestChild).toHaveBeenCalledWith({ component: 'ssr-server', traceId: 'trace-1', url: '/products', method: 'GET' });
    expect(info).toHaveBeenCalledWith({ route: '/products' }, 'rendered');
  });

  it('keeps explicit request lineage on the explicit sink and binds reqId', () => {
    const info = vi.fn();
    const explicitChild = vi.fn(() => ({ info }));
    const selected: RuntimeLoggerSelection = {
      source: 'explicit',
      custom: { child: explicitChild },
      minLevel: 'debug',
    };
    const requestChild = vi.fn();
    const req = { id: 'req-2', log: { child: requestChild } } as any;

    const logger = createRuntimeRequestLogger(selected, req, {
      component: 'ssr-server',
      traceId: 'trace-2',
      reqId: 'wrong-value-is-replaced',
      url: '/account',
      method: 'POST',
    });
    logger.info({}, 'rendered');

    expect(requestChild).not.toHaveBeenCalled();
    expect(explicitChild).toHaveBeenCalledWith({
      component: 'ssr-server',
      traceId: 'trace-2',
      reqId: 'req-2',
      url: '/account',
      method: 'POST',
    });
    expect(info).toHaveBeenCalledWith({}, 'rendered');
  });

  it('preserves debug category metadata through the selected sink', () => {
    const debug = vi.fn();
    const logger = createRuntimeLogger(selection({ debug }));

    logger.debug('ssr', { route: '/' }, 'shell');

    expect(debug).toHaveBeenCalledWith({ route: '/', category: 'ssr' }, 'shell');
  });
});
