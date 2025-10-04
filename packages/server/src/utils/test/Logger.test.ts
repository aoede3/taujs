import { describe, it, expect, vi } from 'vitest';

import { createLogger, debugLog } from '../../logging/Logger';

describe('createLogger', () => {
  it('should log to console when debug is true', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger(true);

    logger.log('test log');
    expect(logSpy).toHaveBeenCalledWith('test log');

    logSpy.mockRestore();
  });

  it('should not log to console when debug is false', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger(false);

    logger.log('test log');
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it('should warn to console when debug is true', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger(true);

    logger.warn('test warn');
    expect(warnSpy).toHaveBeenCalledWith('test warn');

    warnSpy.mockRestore();
  });

  it('should not warn to console when debug is false', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger(false);

    logger.warn('test warn');
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('should error to console when debug is true', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger(true);

    logger.error('test error');
    expect(errorSpy).toHaveBeenCalledWith('test error');

    errorSpy.mockRestore();
  });

  it('should not error to console when debug is false', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger(false);

    logger.error('test error');
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe('debugLog', () => {
  const method = 'GET';
  const url = '/foo';
  const mockReq = { method, url };

  it('logs formatted message using provided logger', () => {
    const log = vi.fn();
    const logger = { log, warn: vi.fn(), error: vi.fn() };
    debugLog(logger, 'Test message', mockReq as any);
    expect(log).toHaveBeenCalledWith('[τjs] GET /foo Test message');
  });

  it('logs without method/url if req is undefined', () => {
    const log = vi.fn();
    const logger = { log, warn: vi.fn(), error: vi.fn() };
    debugLog(logger, 'No request');
    expect(log).toHaveBeenCalledWith('[τjs]  No request');
  });
});
