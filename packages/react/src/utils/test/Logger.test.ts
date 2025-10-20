// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createUILogger } from '../Logger';

import type { ServerLogs, UILogger } from '../Logger';

const mkSpies = () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  return { logSpy, warnSpy, errSpy };
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('createUILogger - UI-logger-shaped input', () => {
  it('uses provided UI methods and falls back to console for missing ones; forwards raw args', () => {
    const { warnSpy, errSpy } = mkSpies();

    const customLog = vi.fn();
    const uiLogger: Partial<UILogger> = {
      log: customLog, // provided
      // warn/error not provided → fall back to console.warn/error
    };

    const ui = createUILogger(uiLogger);

    const a = { x: 1 };
    const e = new Error('boom');

    ui.log('L', 123, a);
    ui.warn('W', a);
    ui.error('E', e, a);

    expect(customLog).toHaveBeenCalledWith('L', 123, a);
    expect(warnSpy).toHaveBeenCalledWith('W', a);
    expect(errSpy).toHaveBeenCalledWith('E', e, a);
  });

  it('when UI logger defines nothing, falls back to console.* for all', () => {
    const { logSpy, warnSpy, errSpy } = mkSpies();
    const ui = createUILogger({}); // still treated as UI path due to 'in' checks

    ui.log('hello');
    ui.warn('careful');
    ui.error('oops');

    expect(logSpy).toHaveBeenCalledWith('hello');
    expect(warnSpy).toHaveBeenCalledWith('careful');
    expect(errSpy).toHaveBeenCalledWith('oops');
  });
});

describe('createUILogger - Server-logger-shaped input', () => {
  it('maps info/warn/error and stringifies non-strings; does not call debug when not enabled', () => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const debug = vi.fn();
    const isDebugEnabled = vi.fn().mockReturnValue(false);

    const server: ServerLogs = { info, warn, error, debug, isDebugEnabled };
    const ui = createUILogger(server, { debugCategory: 'ssr' });

    const obj = { a: 1 };
    const err = new Error('kaboom');
    // simulate no stack to test (e.stack ?? e.message) branch
    (err as any).stack = undefined;

    ui.log('A', obj);
    ui.warn('B', obj);
    ui.error('C', err);

    expect(info).toHaveBeenCalledWith('A', obj);
    expect(warn).toHaveBeenCalledWith('B', obj);
    expect(error).toHaveBeenCalledWith('C', { args: [err.message] });

    // debug not called because not enabled
    expect(debug).not.toHaveBeenCalled();
  });

  it('uses debug(category, msg) when isDebugEnabled(category) is true', () => {
    const info = vi.fn();
    const debug = vi.fn();
    const isDebugEnabled = vi.fn().mockImplementation((cat) => cat === 'react');

    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn(), debug, isDebugEnabled };

    const ui = createUILogger(server, { debugCategory: 'react' });
    ui.log('hello');

    expect(debug).toHaveBeenCalledWith('react', 'hello', undefined);
    expect(info).not.toHaveBeenCalled();
  });

  it('uses debug even when disabled if preferDebug=true', () => {
    const info = vi.fn();
    const debug = vi.fn();
    const isDebugEnabled = vi.fn().mockReturnValue(false);

    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn(), debug, isDebugEnabled };
    const ui = createUILogger(server, { preferDebug: true }); // default category = 'ssr'

    ui.log('msg');
    expect(debug).toHaveBeenCalledWith('ssr', 'msg', undefined);
    expect(info).not.toHaveBeenCalled();
  });

  it('falls back to info when server has no debug', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };

    const ui = createUILogger(server, { preferDebug: true }); // preferDebug true but no debug fn
    ui.log('abc');

    expect(info).toHaveBeenCalledWith('abc', undefined);
  });

  it('calls child(context) when provided and uses returned sinks; swallows child() throws', () => {
    // 1) successful child
    const infoChild = vi.fn();
    const warnChild = vi.fn();
    const errChild = vi.fn();

    const child = vi.fn().mockReturnValue({
      info: infoChild,
      warn: warnChild,
      error: errChild,
      debug: vi.fn(),
      isDebugEnabled: vi.fn().mockReturnValue(false),
    } satisfies ServerLogs);

    const base: ServerLogs = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      isDebugEnabled: vi.fn().mockReturnValue(false),
      child,
    };

    const uiChild = createUILogger(base, { context: { reqId: 'R1' } });
    uiChild.log('L');
    uiChild.warn('W');
    uiChild.error('E');

    expect(child).toHaveBeenCalledWith({ reqId: 'R1' });
    expect(infoChild).toHaveBeenCalledWith('L', undefined);
    expect(warnChild).toHaveBeenCalledWith('W', undefined);
    expect(errChild).toHaveBeenCalledWith('E', undefined);

    // 2) child throws → catch {} and continue with base sinks
    const throwingChild = vi.fn(() => {
      throw new Error('nope');
    });

    const base2: ServerLogs = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: throwingChild,
    };

    const uiBase = createUILogger(base2, { context: { user: 42 } });
    uiBase.log('X');
    uiBase.warn('Y');
    uiBase.error('Z');

    expect(throwingChild).toHaveBeenCalledWith({ user: 42 });
    expect(base2.info).toHaveBeenCalledWith('X', undefined);
    expect(base2.warn).toHaveBeenCalledWith('Y', undefined);
    expect(base2.error).toHaveBeenCalledWith('Z', undefined);
  });
});

describe('createUILogger - No logger (console fallbacks)', () => {
  it('falls back to console.* with stringified args', () => {
    const { logSpy, warnSpy, errSpy } = mkSpies();
    const ui = createUILogger(undefined);

    const obj = { n: 5 };
    const err = new Error('oops');
    (err as any).stack = undefined; // ensure message path

    ui.log('ok', obj);
    ui.warn('hm', obj);
    ui.error('bad', err);

    expect(logSpy).toHaveBeenCalledWith('ok', obj);
    expect(warnSpy).toHaveBeenCalledWith('hm', obj);
    expect(errSpy).toHaveBeenCalledWith('bad', err);
  });

  it('respects custom debugCategory when debug is available', () => {
    const debug = vi.fn();
    const server: ServerLogs = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug, isDebugEnabled: vi.fn().mockReturnValue(true) };

    const ui = createUILogger(server, { debugCategory: 'custom' });
    ui.log('z');

    expect(debug).toHaveBeenCalledWith('custom', 'z', undefined);
  });
});

describe('createUILogger - UI logger fallbacks', () => {
  it('falls back to console.* when UI methods are missing/undefined', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // UI-shaped input: has "log"/"warn"/"error" keys but they’re undefined.
    // This makes `'log' in logger` true so we take the UI branch,
    // and the nullish coalescing hits console.* fallbacks.
    const uiInput = {
      log: undefined,
      warn: undefined,
      error: undefined,
    } as Partial<ReturnType<typeof createUILogger>> as any;

    const ui = createUILogger(uiInput);

    ui.log('L', 1, { a: 2 });
    ui.warn('W', 3);
    ui.error('E');

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('L', 1, { a: 2 });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('W', 3);

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('E');
  });

  it('uses provided UI methods when present (no console fallback)', () => {
    const logSpy = vi.fn();
    const warnSpy = vi.fn();
    const errSpy = vi.fn();

    const ui = createUILogger({
      log: logSpy,
      warn: warnSpy,
      error: errSpy,
    });

    ui.log('x');
    ui.warn('y');
    ui.error('z');

    expect(logSpy).toHaveBeenCalledWith('x');
    expect(warnSpy).toHaveBeenCalledWith('y');
    expect(errSpy).toHaveBeenCalledWith('z');
  });

  it('aggregates multiple extra args into meta.args (server path)', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };

    const ui = createUILogger(server);
    const err = new Error('kaput');
    (err as any).stack = undefined;

    ui.log('X', 1, { a: 2 }, err, 'tail');

    expect(info).toHaveBeenCalledWith('X', {
      args: ['1', JSON.stringify({ a: 2 }), 'kaput', 'tail'],
    });
  });
});

describe('createUILogger - server fallbacks & preferDebug', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('server path: uses console.* fallbacks when info/warn/error are missing; respects (meta ? ... : ...)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Force the "server" branch without providing info/warn/error (triggers console fallbacks).
    // Using an own property like `child` (or `debug` set to undefined) makes looksServer = true.
    const serverLike = { child: vi.fn() } as Partial<ServerLogs>;

    const ui = createUILogger(serverLike);

    // 1) no meta → only first arg is logged
    ui.log('no-meta');
    expect(logSpy).toHaveBeenCalledWith('no-meta');

    // 2) single non-Error object → passed as meta (second arg present)
    const metaObj = { a: 1 };
    ui.log('with-meta', metaObj);
    expect(logSpy).toHaveBeenCalledWith('with-meta', metaObj);

    // 3) warn path (same ternary behavior)
    ui.warn('warn-no-meta');
    expect(warnSpy).toHaveBeenCalledWith('warn-no-meta');

    const warnMeta = { b: 2 };
    ui.warn('warn-with-meta', warnMeta);
    expect(warnSpy).toHaveBeenCalledWith('warn-with-meta', warnMeta);

    // 4) error path with Error → meta becomes { args: [...] } (truthy → second arg logged)
    const e = new Error('boom');
    (e as any).stack = undefined; // ensure message branch for determinism
    ui.error('err-with-error', e);
    const [m, meta] = (errSpy as any).mock.calls.at(-1)!;
    expect(m).toBe('err-with-error');
    expect(meta).toEqual({ args: ['boom'] }); // from splitMsgAndMeta
  });

  it('server path: error fallback uses console.error(msg) when meta is undefined', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Force looksServer=true but omit s.error so the fallback is used
    const serverLike = { child: vi.fn() } as any;
    const ui = createUILogger(serverLike);

    // No extra args → splitMsgAndMeta returns { msg, meta: undefined }
    ui.error('only-message');

    expect(errSpy).toHaveBeenCalledTimes(1);
    // must be called with exactly one arg (the ternary's else branch)
    expect(errSpy).toHaveBeenCalledWith('only-message');
    expect((errSpy as any).mock.calls[0].length).toBe(1);
  });

  it('preferDebug: when isDebugEnabled is absent, preferDebug=true calls debug; preferDebug=false falls back to info (console.log)', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const debug = vi.fn();

    // Server has debug but no isDebugEnabled/info; info fallback should be console.log
    const server: Partial<ServerLogs> = { debug };

    // preferDebug = true → debug runs
    const uiPrefer = createUILogger(server, { preferDebug: true }); // default category 'ssr'
    uiPrefer.log('dbg');
    expect(debug).toHaveBeenCalledWith('ssr', 'dbg', undefined);
    expect(consoleLog).not.toHaveBeenCalled();

    // preferDebug = false → debug is NOT enabled → falls back to info (console.log fallback)
    debug.mockClear();
    const uiNoPrefer = createUILogger(server, { preferDebug: false });
    uiNoPrefer.log('fallback');
    expect(debug).not.toHaveBeenCalled();
    // meta is undefined, so the fallback wrapper uses console.log(msg) with a single arg
    expect(consoleLog).toHaveBeenCalledWith('fallback');
  });
});
