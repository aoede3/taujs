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
    logger.info({}, 'hello');

    const firstArg = (console.log as any).mock.calls[0][0] as string;
    expect(firstArg).toMatch(/^03:04:05\.006 \[info\] hello$/);

    (console.log as any).mockClear();
    process.env.NODE_ENV = 'production';
    logger.info({}, 'prod');
    const prodArg = (console.log as any).mock.calls[0][0] as string;
    expect(prodArg).toMatch(/^\d{4}-\d{2}-\d{2}T03:04:05\.006Z \[info\] prod$/);
  });

  it('minLevel gating: info suppressed when minLevel=warn, warn+error allowed; debug suppressed unless enabled', () => {
    const logger = createLogger({ minLevel: 'warn' });

    logger.info({}, 'nope');
    expect(console.log).not.toHaveBeenCalled();

    logger.warn({}, 'allowed');
    expect(console.warn).toHaveBeenCalledTimes(1);

    logger.error({}, 'allowed');
    expect(console.error).toHaveBeenCalledTimes(1);

    logger.configure(['routes']);
    logger.debug('routes', {}, 'debug msg'); // still blocked by minLevel=warn
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
    logger.debug('auth', {}, 'nope');
    expect(console.log).not.toHaveBeenCalled();

    logger.debug('routes', {}, 'enabled');
    expect(console.log).toHaveBeenCalledTimes(1);

    const msg = (console.log as any).mock.calls[0][0] as string;
    expect(msg).toContain('[debug:routes] enabled');
  });

  it('includeStack: default includes warn (in non-prod) and error, strips stack otherwise; boolean and fn work', () => {
    const loggerA = createLogger({ minLevel: 'debug' });

    const circular: any = { a: 1, stack: 'S', inner: { someStack: 'X' } };
    circular.self = circular;

    loggerA.info(circular, 'strip stack');
    const infoArgs = (console.log as any).mock.calls.pop()!;
    const infoMeta = infoArgs[1];
    expect(infoMeta.stack).toBeUndefined();
    expect(infoMeta.inner).toEqual({});
    expect(infoMeta.self).toBe('[circular]');

    loggerA.warn({ stack: 'S2' }, 'keep stack');
    const warnArgs = (console.warn as any).mock.calls.pop()!;
    const warnMeta = warnArgs[1];
    expect(warnMeta.stack).toBe('S2');

    process.env.NODE_ENV = 'production';
    const loggerB = createLogger({ minLevel: 'debug' });
    loggerB.warn({ stack: 'S3' }, 'prod warn');
    const prodWarn = (console.warn as any).mock.calls.pop()!;
    expect(prodWarn.length).toBe(1);

    const loggerC = createLogger({ includeStack: true, minLevel: 'debug' });
    loggerC.info({ stack: 'S4' }, 'boolean true');
    const cArgs = (console.log as any).mock.calls.pop()!;
    expect(cArgs[1].stack).toBe('S4');

    const loggerD = createLogger({ includeStack: false, minLevel: 'debug' });
    loggerD.error({ stack: 'S5' }, 'boolean false');
    const dArgs = (console.error as any).mock.calls.pop()!;
    expect(dArgs.length).toBe(1);

    const fn = vi.fn((lvl: any) => lvl === 'error');
    const loggerE = createLogger({ includeStack: fn, minLevel: 'debug' });
    loggerE.info({ stack: 'S6' }, 'fn info');
    const eInfo = (console.log as any).mock.calls.pop()!;
    expect(eInfo.length).toBe(1);
    loggerE.error({ stack: 'S7' }, 'fn err');
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
    child.info({ extra: 1 }, 'with ctx');
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
    logger.info({ a: 1 }, 'no ctx');
    let m = (console.log as any).mock.calls.pop()![1];
    expect(m).toEqual({ a: 1 });

    logger.warn({ b: 2 }, 'with ctx');
    m = (console.warn as any).mock.calls.pop()![1];
    expect(m).toEqual({ context: { foo: 1 }, b: 2 });
    expect(fn).toHaveBeenCalledWith('info');
    expect(fn).toHaveBeenCalledWith('warn');
  });

  it('custom sinks: per-level only; no fallback to .info or .log; otherwise console fallback', () => {
    const customAll = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(), // unused in new pino-first path
    };
    const logger1 = createLogger({ custom: customAll, includeContext: false, minLevel: 'debug' });

    logger1.info({ a: 1 }, 'msg1');
    expect(customAll.info).toHaveBeenCalledTimes(1);
    expect(customAll.log).not.toHaveBeenCalled();

    const customNoDebug: any = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };
    const logger2 = createLogger({ custom: customNoDebug, includeContext: false, minLevel: 'debug' });
    logger2.configure(['routes']);
    logger2.debug('routes', { d: 2 }, 'd2');
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(customNoDebug.info).not.toHaveBeenCalled();
    expect(customNoDebug.log).not.toHaveBeenCalled();

    const customOnlyLog = { log: vi.fn() };
    const logger3 = createLogger({ custom: customOnlyLog as any, includeContext: false, minLevel: 'debug' });
    logger3.warn({ w: 1 }, 'w1');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(customOnlyLog.log).not.toHaveBeenCalled();

    const logger4 = createLogger({ includeContext: false, minLevel: 'debug' });
    logger4.error({}, 'e1');
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('hasMeta toggles: meta omitted vs provided', () => {
    const logger = createLogger();

    logger.info({}, 'no meta');
    const noMeta = (console.log as any).mock.calls.pop()!;
    expect(noMeta.length).toBe(1);

    logger.info({ k: 1 }, 'with meta');
    const call = (console.log as any).mock.calls.pop()!;
    expect(call[0]).toMatch(/\[info\] with meta$/);
    expect(call[1]).toEqual({ k: 1 });
  });

  it('falls back to console when custom sink throws (with and without meta)', () => {
    const custom = {
      info: vi.fn(() => {
        throw new Error('boom');
      }),
    };

    const logger = createLogger({
      custom: custom as any,
      includeContext: false,
      minLevel: 'debug',
    });

    // ---- with meta -> hasMeta === true -> consoleFallback(formatted, finalMeta)
    logger.info({ x: 1 }, 'with meta');

    expect(custom.info).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledTimes(1);

    let call = (console.log as any).mock.calls[0];
    expect(call.length).toBe(2); // formatted + meta
    expect(call[0]).toMatch(/\[info\] with meta$/);
    expect(call[1]).toEqual({ x: 1 });

    (console.log as any).mockClear();

    // ---- without meta -> hasMeta === false -> consoleFallback(formatted)
    logger.info(undefined as any, 'no meta');

    expect(custom.info).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenCalledTimes(1);

    call = (console.log as any).mock.calls[0];
    expect(call.length).toBe(1); // formatted only
    expect(call[0]).toMatch(/\[info\] no meta$/);
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
    l2.debug('auth', {}, 'x');
    expect(l2DebugSpy).toHaveBeenCalledTimes(1);
  });

  it('stripStacks handles arrays and deep nesting (via includeStack: false)', () => {
    const logger = createLogger({ includeStack: false });

    const meta = [{ stack: 'S' }, { deep: { anotherStack: 'X', ok: 1 } }];
    logger.info(meta as any, 'array');
    const m = (console.log as any).mock.calls.pop()![1];

    expect(m).toHaveProperty('value');
    expect(Array.isArray(m.value)).toBe(true);

    expect(m.value[0].stack).toBeUndefined();
    expect((m.value[1].deep as any).anotherStack).toBeUndefined();
    expect((m.value[1].deep as any).ok).toBe(1);
  });

  it('child() preserves other config and merges context', () => {
    const base = createLogger({
      minLevel: 'debug',
      includeContext: true,
      context: { a: 1 },
    });
    const c = base.child({ b: 2 });

    c.info({ k: 3 }, 'm');
    const meta = (console.log as any).mock.calls.pop()![1];
    expect(meta).toEqual({ context: { a: 1, b: 2 }, k: 3 });
  });

  it('forces default case for color tag path by calling emit with a bogus level; uses console fallback', () => {
    const logger = new (Logger as any)({});
    (logger as any).shouldEmit = () => true;

    (logger as any).emit('other', 'hi');
    expect(console.log).toHaveBeenCalled();
  });

  it('emits single-line when singleLine=true and hasMeta (console fallback only)', () => {
    const logger = createLogger({
      singleLine: true,
      includeContext: false,
      minLevel: 'debug',
    });

    const meta = { a: 1, nested: { b: 2 }, note: 'hello\nworld' };

    logger.info(meta, 'one-line');

    expect(console.log).toHaveBeenCalledTimes(1);
    const onlyArgList = (console.log as any).mock.calls[0];
    expect(onlyArgList.length).toBe(1);

    const line = onlyArgList[0] as string;
    expect(line).toMatch(/\[info\] one-line\s+{/);
    expect(line).toContain('"a":1');
    expect(line).toContain('"b":2');
    expect(line).toContain('"note":"hello\\nworld"');
  });

  it('hasMeta falls through to ": false" when meta is a primitive (non-object)', () => {
    const logger = createLogger({ minLevel: 'debug', includeContext: false });

    logger.info('hello' as any, 'primitive meta');

    expect(console.log).toHaveBeenCalledTimes(1);
    const call = (console.log as any).mock.calls[0];

    expect(call.length).toBe(2);
    expect(call[0]).toMatch(/\[info\] primitive meta$/);
  });

  it('sets hasMeta to false when finalMeta is non-object (via stripStacks override)', () => {
    const logger = createLogger({
      includeStack: false,
      includeContext: false,
      minLevel: 'debug',
    });

    const stripSpy = vi.spyOn(logger as any, 'stripStacks').mockReturnValue('not-an-object' as any);

    logger.info({ k: 1 }, 'primitive finalMeta');

    expect(stripSpy).toHaveBeenCalled();

    expect(console.log).toHaveBeenCalledTimes(1);
    const call = (console.log as any).mock.calls[0];

    expect(call.length).toBe(1);
    expect(call[0]).toMatch(/\[info\] primitive finalMeta$/);
  });

  it('defaults message to empty string for info when omitted', () => {
    const logger = createLogger({ includeContext: false }); // console fallback path
    logger.info({ k: 1 });

    expect(console.log).toHaveBeenCalledTimes(1);
    const call = (console.log as any).mock.calls[0];
    expect(call[0]).toMatch(/\[info\] $/);
    expect(call[1]).toEqual({ k: 1 });
  });

  it('defaults message to empty string for warn when omitted', () => {
    const logger = createLogger();
    logger.warn();

    expect(console.warn).toHaveBeenCalledTimes(1);
    const call = (console.warn as any).mock.calls[0];
    expect(call.length).toBe(1);
    expect(call[0]).toMatch(/\[warn\] $/);
  });

  it('defaults message to empty string for error when omitted (custom sink path)', () => {
    const custom = { error: vi.fn() };
    const logger = createLogger({ custom: custom as any, includeContext: false });

    logger.error(); // -> custom.error({}, "<ts> [error] ")

    expect(custom.error).toHaveBeenCalledTimes(1);
    const args = (custom.error as any).mock.calls[0];
    expect(args[0]).toEqual({});
    expect(args[1]).toMatch(/\[error\] $/);
  });

  it('defaults message to empty string for debug(category) when omitted (with meta)', () => {
    const logger = createLogger({ minLevel: 'debug' });
    logger.configure(['routes']);

    logger.debug('routes', { d: 1 });

    expect(console.log).toHaveBeenCalledTimes(1);
    const call = (console.log as any).mock.calls[0];
    expect(call[0]).toMatch(/\[debug:routes\] $/);
    expect(call[1]).toEqual({ d: 1 });
  });

  it('defaults message to empty string for debug(category) when both meta and message omitted', () => {
    const logger = createLogger({ minLevel: 'debug' });
    logger.configure(['routes']);

    logger.debug('routes');

    expect(console.log).toHaveBeenCalledTimes(1);
    const call = (console.log as any).mock.calls[0];
    expect(call.length).toBe(1);
    expect(call[0]).toMatch(/\[debug:routes\] $/);
  });
});
