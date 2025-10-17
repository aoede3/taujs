// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { pinoAdapter, winstonAdapter } from '../Adapters';
import type { BaseLogger } from '../Logger';

describe('logger adapters', () => {
  let pino: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  let winston: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    pino = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    winston = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    vi.clearAllMocks();
  });

  describe('pinoAdapter', () => {
    it('maps methods and uses (meta ?? {}, message) order', () => {
      const logger: BaseLogger = pinoAdapter(pino);

      // meta omitted -> {}
      logger.debug?.('d-msg');
      expect(pino.debug).toHaveBeenCalledWith({}, 'd-msg');

      // meta explicitly undefined -> {}
      logger.info?.('i-msg', undefined);
      expect(pino.info).toHaveBeenCalledWith({}, 'i-msg');

      // meta null -> {}
      logger.warn?.('w-msg', null as any);
      expect(pino.warn).toHaveBeenCalledWith({}, 'w-msg');

      // cover error's `meta ?? {}` too:
      logger.error?.('e1'); // omitted meta
      expect(pino.error).toHaveBeenCalledWith({}, 'e1');

      logger.error?.('e2', undefined); // explicit undefined
      expect(pino.error).toHaveBeenCalledWith({}, 'e2');

      // meta object passes through
      const meta = { a: 1, b: 'x' };
      logger.error?.('e3', meta);
      expect(pino.error).toHaveBeenCalledWith(meta, 'e3');
    });
  });

  describe('winstonAdapter', () => {
    it('maps methods and uses (message, meta) order with transparent meta', () => {
      const logger: BaseLogger = winstonAdapter(winston);

      // meta omitted -> undefined is forwarded
      logger.debug?.('d-msg');
      expect(winston.debug).toHaveBeenCalledWith('d-msg', undefined);

      // meta explicitly undefined
      logger.info?.('i-msg', undefined);
      expect(winston.info).toHaveBeenCalledWith('i-msg', undefined);

      // meta object
      const meta = { y: true };
      logger.warn?.('w-msg', meta);
      expect(winston.warn).toHaveBeenCalledWith('w-msg', meta);

      // meta null passes through
      logger.error?.('e-msg', null as any);
      expect(winston.error).toHaveBeenCalledWith('e-msg', null);
    });
  });
});
