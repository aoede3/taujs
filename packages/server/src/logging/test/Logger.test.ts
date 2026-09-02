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

// The runtime mode is snapshotted at module evaluation, so a Logger test that needs a specific
// mode selects the environment and then imports Logger - it never mutates NODE_ENV mid-test and
// never substitutes an assertion on the resolver for one on Logger's own behaviour.
async function importLoggerWithEnv(nodeEnv: string | undefined) {
  const previous = process.env.NODE_ENV;

  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;

  vi.resetModules();

  try {
    return await import('../Logger');
  } finally {
    process.env.NODE_ENV = previous;
  }
}

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

  it('formatTimestamp uses HH:mm:ss.SSS in development and ISO in every production-mode environment', async () => {
    const development = await importLoggerWithEnv('development');
    development.createLogger().info({}, 'hello');

    const firstArg = (console.log as any).mock.calls[0][0] as string;
    expect(firstArg).toMatch(/^03:04:05\.006 \[info\] hello$/);

    // `production`, `test`, unset and any other value are ONE mode, so the production timestamp
    // is pinned across all four rather than only the literal `production`.
    for (const nodeEnv of ['production', 'test', undefined, 'staging']) {
      (console.log as any).mockClear();

      const productionMode = await importLoggerWithEnv(nodeEnv);
      productionMode.createLogger().info({}, 'prod');

      const prodArg = (console.log as any).mock.calls[0][0] as string;
      expect(prodArg, `NODE_ENV=${String(nodeEnv)}`).toMatch(/^\d{4}-\d{2}-\d{2}T03:04:05\.006Z \[info\] prod$/);
    }
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

  it('includeStack: default includes warn (in development) and error, strips stack otherwise; boolean and fn work', async () => {
    const development = await importLoggerWithEnv('development');
    const loggerA = development.createLogger({ minLevel: 'debug' });

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

    // Every non-development environment is production mode, so `test` strips warn stacks exactly
    // as `production` does - the delta this unit deliberately introduced.
    for (const nodeEnv of ['production', 'test']) {
      const productionMode = await importLoggerWithEnv(nodeEnv);
      const loggerB = productionMode.createLogger({ minLevel: 'debug' });

      loggerB.warn({ stack: 'S3' }, 'prod warn');

      const prodWarn = (console.warn as any).mock.calls.pop()!;
      expect(prodWarn.length, `NODE_ENV=${nodeEnv}`).toBe(1);
    }

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

  it('passes semantic messages and structured debug categories to custom sinks', () => {
    const custom = { info: vi.fn(), debug: vi.fn() };
    const logger = createLogger({ custom, minLevel: 'debug' });
    logger.configure(['ssr']);

    logger.info({ route: '/products' }, 'Rendered response');
    logger.debug('ssr', { strategy: 'streaming' }, 'Shell ready');

    expect(custom.info).toHaveBeenCalledWith({ route: '/products' }, 'Rendered response');
    expect(custom.debug).toHaveBeenCalledWith({ strategy: 'streaming', category: 'ssr' }, 'Shell ready');
    expect(custom.info.mock.calls[0]?.[1]).not.toMatch(/\[info\]/);
    expect(custom.debug.mock.calls[0]?.[1]).not.toMatch(/\[debug:ssr\]/);
  });

  it('lets a custom child own bindings once instead of echoing them in context', () => {
    const childInfo = vi.fn();
    const customChild = vi.fn(() => ({ info: childInfo }));
    const logger = createLogger({
      custom: { child: customChild },
      context: { component: 'ssr-server' },
      includeContext: true,
    });

    logger.child({ requestId: 'episode-1' }).info({ route: '/products' }, 'Rendered response');

    expect(customChild).toHaveBeenCalledWith({ component: 'ssr-server', requestId: 'episode-1' });
    expect(childInfo).toHaveBeenCalledWith({ route: '/products' }, 'Rendered response');
  });

  it('retains wrapper context when a custom sink has no child seam', () => {
    const info = vi.fn();
    const logger = createLogger({
      custom: { info },
      context: { component: 'ssr-server' },
      includeContext: true,
    });

    logger.child({ requestId: 'episode-2' }).info({ route: '/account' }, 'Rendered response');

    expect(info).toHaveBeenCalledWith({ context: { component: 'ssr-server', requestId: 'episode-2' }, route: '/account' }, 'Rendered response');
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

  it('info-level (stacks excluded) hostile and revoked proxies fail closed: no throw, marker as { value }', () => {
    const logger = createLogger({
      includeStack: false,
      includeContext: false,
      minLevel: 'debug',
    });

    const hostile = new Proxy(
      { leak: 'raw-secret-value' },
      {
        ownKeys() {
          throw new Error('no keys for you');
        },
      },
    );
    expect(() => logger.info(hostile, 'hostile at info')).not.toThrow();
    const hostileCall = (console.log as any).mock.calls.pop()!;
    expect(hostileCall[1]).toEqual({ value: '[unredactable]' });
    expect(JSON.stringify(hostileCall)).not.toContain('raw-secret-value');

    const { proxy, revoke } = Proxy.revocable({ leak: 'raw-secret-value' }, {});
    revoke();
    expect(() => logger.info(proxy, 'revoked at info')).not.toThrow();
    const revokedCall = (console.log as any).mock.calls.pop()!;
    expect(revokedCall[1]).toEqual({ value: '[unredactable]' });
    expect(JSON.stringify(revokedCall)).not.toContain('raw-secret-value');
  });

  it('a denied throwing getter never executes: through the stacks-excluded path, context assembly, or child()', () => {
    let executed = 0;
    const withDeniedGetter = (): Record<string, unknown> => ({
      keep: 1,
      get password(): string {
        executed += 1;
        throw new Error('must never run');
      },
    });

    const logger = createLogger({ includeStack: false, includeContext: false, minLevel: 'debug' });
    expect(() => logger.info(withDeniedGetter(), 'denied getter at info')).not.toThrow();

    const ctxLogger = createLogger({ context: withDeniedGetter(), includeContext: true, minLevel: 'debug' });
    expect(() => ctxLogger.info({ ok: 1 }, 'denied getter in context')).not.toThrow();

    const childSpy = vi.fn().mockReturnValue({ info: vi.fn() });
    const parent = createLogger({ custom: { info: vi.fn(), child: childSpy } as any });
    expect(() => parent.child(withDeniedGetter())).not.toThrow();
    expect(JSON.stringify(childSpy.mock.calls)).not.toContain('password');

    expect(executed).toBe(0);
  });

  it('deep metadata stays bounded when stacks are excluded - even past any recursion limit', () => {
    const logger = createLogger({ includeStack: false, includeContext: false, minLevel: 'debug' });

    let deep: any = { leaf: true };
    for (let i = 0; i < 100_000; i += 1) deep = { down: deep };

    expect(() => logger.info(deep, 'deep at info')).not.toThrow();
    const call = (console.log as any).mock.calls.pop()!;
    const serialised = JSON.stringify(call[1]);
    expect(serialised).toContain('"[depth]"');
    expect(serialised).not.toContain('leaf');
  });

  it('a throwing stack getter is skipped without being read when stacks are excluded, and is [unreadable] when included', () => {
    let read = 0;
    const meta = () => ({
      ok: 1,
      get stack(): string {
        read += 1;
        throw new Error('stack read');
      },
    });

    const stripping = createLogger({ includeStack: false, includeContext: false, minLevel: 'debug' });
    expect(() => stripping.info(meta(), 'stack getter stripped')).not.toThrow();
    expect(read).toBe(0);
    const stripped = (console.log as any).mock.calls.pop()!;
    expect(stripped[1]).toEqual({ ok: 1 });

    const including = createLogger({ includeStack: true, includeContext: false, minLevel: 'debug' });
    expect(() => including.info(meta(), 'stack getter included')).not.toThrow();
    expect(read).toBe(1);
    const included = (console.log as any).mock.calls.pop()!;
    expect(included[1]).toEqual({ ok: 1, stack: '[unreadable]' });
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

    logger.error();

    expect(custom.error).toHaveBeenCalledTimes(1);
    const args = (custom.error as any).mock.calls[0];
    expect(args[0]).toEqual({});
    expect(args[1]).toBe('');
  });

  it('defaults message to empty string for debug(category) when omitted (with meta)', () => {
    const logger = createLogger({ minLevel: 'debug' });
    logger.configure(['routes']);

    logger.debug('routes', { d: 1 });

    expect(console.log).toHaveBeenCalledTimes(1);
    const call = (console.log as any).mock.calls[0];
    expect(call[0]).toMatch(/\[debug:routes\] $/);
    expect(call[1]).toEqual({ d: 1, category: 'routes' });
  });

  it('defaults message to empty string for debug(category) when both meta and message omitted', () => {
    const logger = createLogger({ minLevel: 'debug' });
    logger.configure(['routes']);

    logger.debug('routes');

    expect(console.log).toHaveBeenCalledTimes(1);
    const call = (console.log as any).mock.calls[0];
    expect(call.length).toBe(2);
    expect(call[0]).toMatch(/\[debug:routes\] $/);
    expect(call[1]).toEqual({ category: 'routes' });
  });

  describe('redaction: the default denylist applies to all assembled metadata before any sink', () => {
    it("drops a denylisted key's entire subtree in nested objects", () => {
      const logger = createLogger({ includeContext: false });

      logger.info({ userId: 7, nested: { password: 'x', keep: 'y' } }, 'nested');

      const meta = (console.log as any).mock.calls.pop()![1];
      expect(meta.userId).toBe(7);
      expect(meta.nested.password).toBeUndefined();
      expect(meta.nested.keep).toBe('y');
    });

    it('redacts denylisted keys inside arrays of objects', () => {
      const logger = createLogger({ includeContext: false });

      logger.info(
        {
          items: [
            { name: 'a', token: 't1' },
            { name: 'b', token: 't2' },
          ],
        },
        'array',
      );

      const meta = (console.log as any).mock.calls.pop()![1];
      expect(meta.items).toEqual([{ name: 'a' }, { name: 'b' }]);
    });

    it('is cycle-safe and still redacts the rest of a cyclic metadata object', () => {
      const logger = createLogger({ includeContext: false });

      const circular: any = { secret: 's', keep: 'k' };
      circular.self = circular;

      logger.info(circular, 'cyclic');

      const meta = (console.log as any).mock.calls.pop()![1];
      expect(meta.secret).toBeUndefined();
      expect(meta.keep).toBe('k');
      expect(meta.self).toBe('[circular]');
    });

    it('custom sink receives redacted metadata, never the raw denylisted values', () => {
      const custom = { info: vi.fn() };
      const logger = createLogger({ custom: custom as any, includeContext: false });

      logger.info({ apiKey: 'raw-secret-value', ok: true }, 'via custom sink');

      expect(custom.info).toHaveBeenCalledTimes(1);
      const meta = (custom.info as any).mock.calls[0][0];
      expect(meta.apiKey).toBeUndefined();
      expect(meta.ok).toBe(true);
      expect(JSON.stringify((custom.info as any).mock.calls)).not.toContain('raw-secret-value');
    });

    it('console fallback receives redacted metadata when there is no custom sink', () => {
      const logger = createLogger({ includeContext: false });

      logger.error({ password: 'raw-secret-value', code: 'E1' }, 'via console fallback');

      expect(console.error).toHaveBeenCalledTimes(1);
      const meta = (console.error as any).mock.calls[0][1];
      expect(meta.password).toBeUndefined();
      expect(meta.code).toBe('E1');
      expect(JSON.stringify((console.error as any).mock.calls)).not.toContain('raw-secret-value');
    });

    it('the singleLine JSON path emits redacted JSON', () => {
      const logger = createLogger({ singleLine: true, includeContext: false, minLevel: 'debug' });

      logger.info({ cookie: 'raw-secret-value', note: 'hello' }, 'single line');

      expect(console.log).toHaveBeenCalledTimes(1);
      const line = (console.log as any).mock.calls[0][0] as string;
      expect(line).not.toContain('raw-secret-value');
      expect(line).not.toContain('cookie');
      expect(line).toContain('"note":"hello"');
    });

    it('redacts a denied key merged in from child-logger context', () => {
      const base = createLogger({
        includeContext: true,
        context: { session: 'raw-secret-value', app: 'tau' },
      });

      base.info({ extra: 1 }, 'ctx redaction');

      const meta = (console.log as any).mock.calls.pop()![1];
      expect(meta.context.session).toBeUndefined();
      expect(meta.context.app).toBe('tau');
      expect(meta.extra).toBe(1);
    });

    it('does not touch the message string - "token" in the message passes through untouched', () => {
      const logger = createLogger({ includeContext: false });

      logger.info({ ok: true }, 'refresh the token now');

      const call = (console.log as any).mock.calls.pop()!;
      expect(call[0]).toContain('refresh the token now');
    });

    it('a mixed object keeps non-denied siblings intact alongside a dropped denied subtree', () => {
      const logger = createLogger({ includeContext: false });

      logger.info({ userId: 42, secret: 'raw-secret-value', label: 'kept', count: 3 }, 'mixed');

      const meta = (console.log as any).mock.calls.pop()![1];
      expect(meta).toEqual({ userId: 42, label: 'kept', count: 3 });
    });

    it('an Error in error-level metadata keeps name/message/stack for the sink and drops its denied enumerable props', () => {
      const custom = { error: vi.fn() };
      const logger = createLogger({ custom: custom as any, includeContext: false });

      const err = new Error('boom') as Error & { apiToken?: string; requestPath?: string };
      err.apiToken = 'raw-secret-value';
      err.requestPath = '/checkout';

      logger.error({ err }, 'error instance');

      const meta = (custom.error as any).mock.calls[0][0];
      expect(meta.err.name).toBe('Error');
      expect(meta.err.message).toBe('boom');
      expect(meta.err.stack).toEqual(expect.any(String));
      expect(meta.err.requestPath).toBe('/checkout');
      expect(meta.err.apiToken).toBeUndefined();
      expect(JSON.stringify((custom.error as any).mock.calls)).not.toContain('raw-secret-value');
    });

    it('a Date in error-level metadata is rebuilt to the same instant, shedding expando properties', () => {
      const custom = { error: vi.fn() };
      const logger = createLogger({ custom: custom as any, includeContext: false });

      const when = new Date('2026-09-02T00:00:00Z') as Date & { apiToken?: string };
      when.apiToken = 'raw-secret-value';
      logger.error({ when }, 'date instance');

      const meta = (custom.error as any).mock.calls[0][0];
      expect(meta.when).toBeInstanceOf(Date);
      expect(meta.when.getTime()).toBe(when.getTime());
      expect(meta.when).not.toBe(when);
      expect(JSON.stringify((custom.error as any).mock.calls)).not.toContain('raw-secret-value');
    });

    it('the custom child seam receives redacted bindings - a pino-style sink never retains denied context', () => {
      const childSpy = vi.fn().mockReturnValue({ info: vi.fn() });
      const custom = { info: vi.fn(), child: childSpy };
      const logger = createLogger({ custom: custom as any });

      logger.child({ session: 'raw-secret-value', component: 'svc' });

      expect(childSpy).toHaveBeenCalledTimes(1);
      const bindings = childSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(bindings.session).toBeUndefined();
      expect(bindings.component).toBe('svc');
      expect(JSON.stringify(childSpy.mock.calls)).not.toContain('raw-secret-value');
    });

    it('logger.error on a hostile proxy fails closed: no throw, no raw metadata, the marker survives', () => {
      const custom = { error: vi.fn() };
      const logger = createLogger({ custom: custom as any, includeContext: false });

      const hostile = new Proxy(
        { leak: 'raw-secret-value' },
        {
          ownKeys() {
            throw new Error('no keys for you');
          },
        },
      );

      expect(() => logger.error(hostile, 'hostile proxy')).not.toThrow();
      const meta = (custom.error as any).mock.calls[0][0];
      expect(meta).toEqual({ value: '[unredactable]' });
      expect(JSON.stringify((custom.error as any).mock.calls)).not.toContain('raw-secret-value');
    });
  });
});
