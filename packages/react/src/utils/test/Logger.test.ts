import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../Logger';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('logs to console.log when debug is true', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger(true);

    logger.log('test log');
    expect(logSpy).toHaveBeenCalledWith('test log');
  });

  it('does not log to console.log when debug is false', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger(false);

    logger.log('test log');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('warn always logs (debug true)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger(true);

    logger.warn('test warn');
    expect(warnSpy).toHaveBeenCalledWith('test warn');
  });

  it('warn always logs (debug false)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger(false);

    logger.warn('test warn');
    expect(warnSpy).toHaveBeenCalledWith('test warn');
  });

  it('error always logs (debug true)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger(true);

    logger.error('test error');
    expect(errorSpy).toHaveBeenCalledWith('test error');
  });

  it('error always logs (debug false)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger(false);

    logger.error('test error');
    expect(errorSpy).toHaveBeenCalledWith('test error');
  });

  it('respects custom partial logger (overrides only provided methods)', () => {
    const customWarn = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger(false, { warn: customWarn });

    logger.warn('custom warn');
    expect(customWarn).toHaveBeenCalledWith('custom warn');
    expect(warnSpy).not.toHaveBeenCalled();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.log('no log when debug=false');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('forwards all args to underlying functions', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger(true);

    const a = { x: 1 },
      b = 2,
      c = '3';
    logger.log('L', a, b, c);
    logger.warn('W', a, b, c);
    logger.error('E', a, b, c);

    expect(logSpy).toHaveBeenCalledWith('L', a, b, c);
    expect(warnSpy).toHaveBeenCalledWith('W', a, b, c);
    expect(errorSpy).toHaveBeenCalledWith('E', a, b, c);
  });
});
