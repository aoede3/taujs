// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../Parser', () => {
  return {
    parseDebugInput: vi.fn(() => undefined),
  };
});

vi.mock('picocolors', () => ({
  default: {
    gray: (s: string) => s,
    cyan: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
  },
}));

import { createLogger, Logger, DEBUG_CATEGORIES, type DebugCategory } from '../Logger';
import { parseDebugInput } from '../Parser';

const parseDebugInputMock = parseDebugInput as unknown as Mock;

const originalEnv = { ...process.env };

describe('Logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T03:04:05.006Z'));
    process.env = { ...originalEnv, NODE_ENV: 'test' };

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('formatTimestamp uses HH:mm:ss.SSS in non-production and ISO in production', () => {
    const logger = createLogger();
    logger.info('hello');

    const firstArg = (console.log as any).mock.calls[0][0] as string;
    expect(firstArg).toMatch(/^03:04:05\.006 \[info\] hello$/);

    (console.log as any).mockClear();
    process.env.NODE_ENV = 'production';
    logger.info('prod');
    const prodArg = (console.log as any).mock.calls[0][0] as string;
    expect(prodArg).toMatch(/^\d{4}-\d{2}-\d{2}T03:04:05\.006Z \[info\] prod$/);
  });

  it('minLevel gating: info suppressed when minLevel=warn, warn+error allowed; debug suppressed unless enabled', () => {
    const logger = createLogger({ minLevel: 'warn' });

    logger.info('nope');
    expect(console.log).not.toHaveBeenCalled();

    logger.warn('allowed');
    expect(console.warn).toHaveBeenCalledTimes(1);

    logger.error('allowed');
    expect(console.error).toHaveBeenCalledTimes(1);

    logger.configure(['routes']);
    logger.debug('routes', 'debug msg');
    expect(console.log).toHaveBeenCalledTimes(0);
  });

  it('configure(): true enables all, array enables subset, object supports all + per-flag toggles', () => {
    const logger = createLogger();

    logger.configure(true);
    for (const c of DEBUG_CATEGORIES) {
      expect(logger.isDebugEnabled(c)).toBe(true);
    }

    logger.configure(['auth', 'vite']);
    expect(logger.isDebugEnabled('auth')).toBe(true);
    expect(logger.isDebugEnabled('vite')).toBe(true);
    expect(logger.isDebugEnabled('routes')).toBe(false);

    logger.configure({ all: true, auth: false, network: true });
    expect(logger.isDebugEnabled('auth')).toBe(false);
    expect(logger.isDebugEnabled('network')).toBe(true);
    expect(logger.isDebugEnabled('routes')).toBe(true);
  });

  it('debug() only emits for enabled categories', () => {
    const logger = createLogger({ minLevel: 'debug' });

    logger.configure(['routes']);
    logger.debug('auth', 'nope');
    expect(console.log).not.toHaveBeenCalled();

    logger.debug('routes', 'enabled');
    expect(console.log).toHaveBeenCalledTimes(1);

    const msg = (console.log as any).mock.calls[0][0] as string;
    expect(msg).toContain('[debug:routes] enabled');
  });

  it('includeStack: default includes warn (in non-prod) and error, strips stack otherwise; boolean and fn work', () => {
    const loggerA = createLogger({ minLevel: 'debug' });

    const circular: any = { a: 1, stack: 'S', inner: { someStack: 'X' } };
    circular.self = circular;

    loggerA.info('strip stack', circular);
    const infoArgs = (console.log as any).mock.calls.pop()!;
    const infoMeta = infoArgs[1];
    expect(infoMeta.stack).toBeUndefined();
    expect(infoMeta.inner).toEqual({});
    expect(infoMeta.self).toBe('[circular]');

    loggerA.warn('keep stack', { stack: 'S2' });
    const warnArgs = (console.warn as any).mock.calls.pop()!;
    const warnMeta = warnArgs[1];
    expect(warnMeta.stack).toBe('S2');

    process.env.NODE_ENV = 'production';
    const loggerB = createLogger({ minLevel: 'debug' });
    loggerB.warn('prod warn', { stack: 'S3' });
    const prodWarn = (console.warn as any).mock.calls.pop()!;
    expect(prodWarn.length).toBe(1);

    const loggerC = createLogger({ includeStack: true, minLevel: 'debug' });
    loggerC.info('boolean true', { stack: 'S4' });
    const cArgs = (console.log as any).mock.calls.pop()!;
    expect(cArgs[1].stack).toBe('S4');

    const loggerD = createLogger({ includeStack: false, minLevel: 'debug' });
    loggerD.error('boolean false', { stack: 'S5' });
    const dArgs = (console.error as any).mock.calls.pop()!;
    expect(dArgs.length).toBe(1);

    const fn = vi.fn((lvl: any) => lvl === 'error');
    const loggerE = createLogger({ includeStack: fn, minLevel: 'debug' });
    loggerE.info('fn info', { stack: 'S6' });
    const eInfo = (console.log as any).mock.calls.pop()!;
    expect(eInfo.length).toBe(1);
    loggerE.error('fn err', { stack: 'S7' });
    const eErr = (console.error as any).mock.calls.pop()!;
    expect(eErr[1].stack).toBe('S7');
    expect(fn).toHaveBeenCalledWith('info');
    expect(fn).toHaveBeenCalledWith('error');
  });

  it('includeContext: boolean and function; child() merges parent and child context', () => {
    const base = createLogger({
      includeContext: true,
      context: { app: 'tau', version: 1 },
    });

    const child = base.child({ reqId: 'abc' });
    child.info('with ctx', { extra: 1 });
    const call = (console.log as any).mock.calls.pop()!;
    const meta = call[1];
    expect(meta).toEqual({
      context: { app: 'tau', version: 1, reqId: 'abc' },
      extra: 1,
    });

    const fn = vi.fn((lvl: any) => lvl !== 'info');
    const logger = createLogger({
      includeContext: fn,
      context: { foo: 1 },
    });
    logger.info('no ctx', { a: 1 });
    let m = (console.log as any).mock.calls.pop()![1];
    expect(m).toEqual({ a: 1 });

    logger.warn('with ctx', { b: 2 });
    m = (console.warn as any).mock.calls.pop()![1];
    expect(m).toEqual({ context: { foo: 1 }, b: 2 });
    expect(fn).toHaveBeenCalledWith('info');
    expect(fn).toHaveBeenCalledWith('warn');
  });

  it('custom sinks: prefer exact level, then debug->info fallback, else log; otherwise console fallback', () => {
    const customAll = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };
    const logger1 = createLogger({ custom: customAll, includeContext: false, minLevel: 'debug' });

    logger1.info('msg1', { a: 1 });
    expect(customAll.info).toHaveBeenCalledTimes(1);
    expect(customAll.log).not.toHaveBeenCalled();

    logger1.configure(['auth']);
    logger1.debug('auth', 'd1', { d: 1 });
    expect(customAll.debug).toHaveBeenCalledTimes(1);

    const customNoDebug: any = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };
    const logger2 = createLogger({ custom: customNoDebug, includeContext: false, minLevel: 'debug' });
    logger2.configure(['routes']);
    logger2.debug('routes', 'd2', { d: 2 });
    expect(customNoDebug.info).toHaveBeenCalledTimes(1);
    expect(customNoDebug.log).not.toHaveBeenCalled();

    const customOnlyLog = { log: vi.fn() };
    const logger3 = createLogger({ custom: customOnlyLog, includeContext: false, minLevel: 'debug' });
    logger3.warn('w1', { w: 1 });
    expect(customOnlyLog.log).toHaveBeenCalledTimes(1);

    const logger4 = createLogger({ includeContext: false, minLevel: 'debug' });
    logger4.error('e1');
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('hasMeta toggles: meta omitted vs provided', () => {
    const logger = createLogger();

    logger.info('no meta');
    const noMeta = (console.log as any).mock.calls.pop()!;
    expect(noMeta.length).toBe(1);

    logger.info('with meta', { k: 1 });
    const call = (console.log as any).mock.calls.pop()!;
    expect(call[0]).toMatch(/\[info\] with meta$/);
    expect(call[1]).toEqual({ k: 1 });
  });

  it('createLogger parses debug input and calls configure only when parsed is defined', () => {
    parseDebugInputMock.mockReturnValueOnce(undefined);
    const spy = vi.spyOn(Logger.prototype, 'configure');

    const l1 = createLogger({ debug: 'foo' as any });
    expect(spy).not.toHaveBeenCalled();

    parseDebugInputMock.mockReturnValueOnce(['auth', 'errors'] satisfies DebugCategory[]);
    const l2 = createLogger({ debug: 'auth,errors' as any, minLevel: 'debug' });
    expect(spy).toHaveBeenCalledTimes(1);

    const l2DebugSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    l2.debug('auth', 'x');
    expect(l2DebugSpy).toHaveBeenCalledTimes(1);
  });

  it('stripStacks handles arrays and deep nesting (via includeStack: false)', () => {
    const logger = createLogger({ includeStack: false });

    const meta = [{ stack: 'S' }, { deep: { anotherStack: 'X', ok: 1 } }];
    logger.info('array', meta);
    const m = (console.log as any).mock.calls.pop()![1];
    expect(m[0].stack).toBeUndefined();
    expect((m[1].deep as any).anotherStack).toBeUndefined();
    expect((m[1].deep as any).ok).toBe(1);
  });

  it('child() preserves other config and merges context', () => {
    const base = createLogger({
      minLevel: 'debug',
      includeContext: true,
      context: { a: 1 },
    });
    const c = base.child({ b: 2 });

    c.info('m', { k: 3 });
    const meta = (console.log as any).mock.calls.pop()![1];
    expect(meta).toEqual({ context: { a: 1, b: 2 }, k: 3 });
  });

  it('forces default case in coloredLevel switch by monkey-patching and calling emit with a bogus level', () => {
    const custom = { log: vi.fn() };
    const logger = new (Logger as any)({ custom });

    (logger as any).shouldEmit = () => true;

    (logger as any).emit('other', 'hi');
    expect(custom.log).toHaveBeenCalled();
  });

  it('emits single-line when singleLine=true and hasMeta, replacing newlines and returning early', () => {
    const custom = { info: vi.fn() };
    const logger = createLogger({
      custom,
      singleLine: true,
      includeContext: false,
      minLevel: 'debug',
    });

    const meta = { a: 1, nested: { b: 2 }, note: 'hello\nworld' };

    logger.info('one-line', meta);

    expect(custom.info).toHaveBeenCalledTimes(1);
    const onlyArgList = (custom.info as any).mock.calls[0];
    expect(onlyArgList.length).toBe(1);

    const line = onlyArgList[0] as string;
    expect(line).toMatch(/\[info\] one-line\s+{/);
    expect(line).toContain('"a":1');
    expect(line).toContain('"b":2');
    expect(line).toContain('"note":"hello\\nworld"');
  });

  it('hasMeta falls through to ": false" when meta is a primitive (non-object)', () => {
    const logger = createLogger({ minLevel: 'debug', includeContext: false });

    logger.info('primitive meta', 'hello');

    expect(console.log).toHaveBeenCalledTimes(1);
    const call = (console.log as any).mock.calls[0];

    expect(call.length).toBe(1);
    expect(call[0]).toMatch(/\[info\] primitive meta$/);
  });
});
