// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createRuntimeLogger, type RuntimeLoggerSelection } from '../RuntimeLogger';

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

  it('preserves debug category metadata through the selected sink', () => {
    const debug = vi.fn();
    const logger = createRuntimeLogger(selection({ debug }));

    logger.debug('ssr', { route: '/' }, 'shell');

    expect(debug).toHaveBeenCalledWith({ route: '/', category: 'ssr' }, 'shell');
  });
});
