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

describe('createUILogger - enableDebug gate', () => {
  it('returns no-op functions when enableDebug is false (default)', () => {
    const { logSpy, warnSpy, errSpy } = mkSpies();
    const ui = createUILogger(undefined); // enableDebug defaults to false

    ui.log('should not appear');
    ui.warn('should not appear');
    ui.error('should not appear');

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('returns no-op functions when enableDebug is explicitly false', () => {
    const { logSpy, warnSpy, errSpy } = mkSpies();
    const customLog = vi.fn();

    const ui = createUILogger({ log: customLog }, { enableDebug: false });

    ui.log('nope');
    ui.warn('nope');
    ui.error('nope');

    expect(customLog).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('returns no-op functions even when server logger is provided and enableDebug is false', () => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();

    const server: ServerLogs = { info, warn, error };
    const ui = createUILogger(server, { enableDebug: false });

    ui.log('hidden');
    ui.warn('hidden');
    ui.error('hidden');

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('enables logging when enableDebug is true', () => {
    const { logSpy } = mkSpies();
    const ui = createUILogger(undefined, { enableDebug: true });

    ui.log('now visible');

    expect(logSpy).toHaveBeenCalledWith('now visible');
  });
});

describe('createUILogger - UI-logger-shaped input', () => {
  it('uses provided UI methods and falls back to console for missing ones; forwards raw args', () => {
    const { warnSpy, errSpy } = mkSpies();

    const customLog = vi.fn();
    const uiLogger: Partial<UILogger> = {
      log: customLog,
    };

    const ui = createUILogger(uiLogger, { enableDebug: true });

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
    const ui = createUILogger({}, { enableDebug: true });

    ui.log('hello');
    ui.warn('careful');
    ui.error('oops');

    expect(logSpy).toHaveBeenCalledWith('hello');
    expect(warnSpy).toHaveBeenCalledWith('careful');
    expect(errSpy).toHaveBeenCalledWith('oops');
  });

  it('falls back to console.* when UI methods are missing/undefined', () => {
    const { logSpy, warnSpy, errSpy } = mkSpies();

    const uiInput = {
      log: undefined,
      warn: undefined,
      error: undefined,
    } as Partial<UILogger>;

    const ui = createUILogger(uiInput, { enableDebug: true });

    ui.log('L', 1, { a: 2 });
    ui.warn('W', 3);
    ui.error('E');

    expect(logSpy).toHaveBeenCalledWith('L', 1, { a: 2 });
    expect(warnSpy).toHaveBeenCalledWith('W', 3);
    expect(errSpy).toHaveBeenCalledWith('E');
  });

  it('uses provided UI methods when present (no console fallback)', () => {
    const logSpy = vi.fn();
    const warnSpy = vi.fn();
    const errSpy = vi.fn();

    const ui = createUILogger(
      {
        log: logSpy,
        warn: warnSpy,
        error: errSpy,
      },
      { enableDebug: true },
    );

    ui.log('x');
    ui.warn('y');
    ui.error('z');

    expect(logSpy).toHaveBeenCalledWith('x');
    expect(warnSpy).toHaveBeenCalledWith('y');
    expect(errSpy).toHaveBeenCalledWith('z');
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
    const ui = createUILogger(server, { debugCategory: 'ssr', enableDebug: true });

    const obj = { a: 1 };
    const err = new Error('kaboom');
    (err as any).stack = undefined;

    ui.log('A', obj);
    ui.warn('B', obj);
    ui.error('C', err);

    expect(info).toHaveBeenCalledWith('A', obj);
    expect(warn).toHaveBeenCalledWith('B', obj);
    expect(error).toHaveBeenCalledWith('C', { args: [err.message] });

    expect(debug).not.toHaveBeenCalled();
  });

  it('uses debug(category, msg) when isDebugEnabled(category) is true', () => {
    const info = vi.fn();
    const debug = vi.fn();
    const isDebugEnabled = vi.fn().mockImplementation((cat) => cat === 'react');

    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn(), debug, isDebugEnabled };

    const ui = createUILogger(server, { debugCategory: 'react', enableDebug: true });
    ui.log('hello');

    expect(debug).toHaveBeenCalledWith('react', 'hello', undefined);
    expect(info).not.toHaveBeenCalled();
  });

  it('uses debug even when disabled if preferDebug=true', () => {
    const info = vi.fn();
    const debug = vi.fn();
    const isDebugEnabled = vi.fn().mockReturnValue(false);

    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn(), debug, isDebugEnabled };
    const ui = createUILogger(server, { preferDebug: true, enableDebug: true });

    ui.log('msg');
    expect(debug).toHaveBeenCalledWith('ssr', 'msg', undefined);
    expect(info).not.toHaveBeenCalled();
  });

  it('falls back to info when server has no debug', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };

    const ui = createUILogger(server, { preferDebug: true, enableDebug: true });
    ui.log('abc');

    expect(info).toHaveBeenCalledWith('abc', undefined);
  });

  it('calls child(context) when provided and uses returned sinks', () => {
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

    const uiChild = createUILogger(base, { context: { reqId: 'R1' }, enableDebug: true });
    uiChild.log('L');
    uiChild.warn('W');
    uiChild.error('E');

    expect(child).toHaveBeenCalledWith({ reqId: 'R1' });
    expect(infoChild).toHaveBeenCalledWith('L', undefined);
    expect(warnChild).toHaveBeenCalledWith('W', undefined);
    expect(errChild).toHaveBeenCalledWith('E', undefined);
  });

  it('swallows child() throws and continues with base sinks', () => {
    const throwingChild = vi.fn(() => {
      throw new Error('nope');
    });

    const base: ServerLogs = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: throwingChild,
    };

    const uiBase = createUILogger(base, { context: { user: 42 }, enableDebug: true });
    uiBase.log('X');
    uiBase.warn('Y');
    uiBase.error('Z');

    expect(throwingChild).toHaveBeenCalledWith({ user: 42 });
    expect(base.info).toHaveBeenCalledWith('X', undefined);
    expect(base.warn).toHaveBeenCalledWith('Y', undefined);
    expect(base.error).toHaveBeenCalledWith('Z', undefined);
  });

  it('aggregates multiple extra args into meta.args (server path)', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };

    const ui = createUILogger(server, { enableDebug: true });
    const err = new Error('kaput');
    (err as any).stack = undefined;

    ui.log('X', 1, { a: 2 }, err, 'tail');

    expect(info).toHaveBeenCalledWith('X', {
      args: ['1', JSON.stringify({ a: 2 }), 'kaput', 'tail'],
    });
  });

  it('respects custom debugCategory when debug is available', () => {
    const debug = vi.fn();
    const server: ServerLogs = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug,
      isDebugEnabled: vi.fn().mockReturnValue(true),
    };

    const ui = createUILogger(server, { debugCategory: 'custom', enableDebug: true });
    ui.log('z');

    expect(debug).toHaveBeenCalledWith('custom', 'z', undefined);
  });
});

describe('createUILogger - console fallbacks', () => {
  it('server path: uses console.* fallbacks when info/warn/error are missing; no meta', () => {
    const { logSpy, warnSpy, errSpy } = mkSpies();

    const serverLike = { child: vi.fn() } as Partial<ServerLogs>;
    const ui = createUILogger(serverLike, { enableDebug: true });

    ui.log('no-meta');
    ui.warn('warn-no-meta');
    ui.error('err-no-meta');

    expect(logSpy).toHaveBeenCalledWith('no-meta');
    expect(warnSpy).toHaveBeenCalledWith('warn-no-meta');
    expect(errSpy).toHaveBeenCalledWith('err-no-meta');
  });

  it('server path: uses console.* fallbacks when info/warn/error are missing; with meta', () => {
    const { logSpy, warnSpy, errSpy } = mkSpies();

    const serverLike = { child: vi.fn() } as Partial<ServerLogs>;
    const ui = createUILogger(serverLike, { enableDebug: true });

    const metaObj = { a: 1 };
    ui.log('with-meta', metaObj);

    const warnMeta = { b: 2 };
    ui.warn('warn-with-meta', warnMeta);

    const e = new Error('boom');
    (e as any).stack = undefined;
    ui.error('err-with-error', e);

    expect(logSpy).toHaveBeenCalledWith('with-meta', metaObj);
    expect(warnSpy).toHaveBeenCalledWith('warn-with-meta', warnMeta);

    const [m, meta] = (errSpy as any).mock.calls.at(-1)!;
    expect(m).toBe('err-with-error');
    expect(meta).toEqual({ args: ['boom'] });
  });

  it('server path: error fallback uses console.error(msg) when meta is undefined', () => {
    const { errSpy } = mkSpies();

    const serverLike = { child: vi.fn() } as any;
    const ui = createUILogger(serverLike, { enableDebug: true });

    ui.error('only-message');

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('only-message');
    expect((errSpy as any).mock.calls[0].length).toBe(1);
  });

  it('preferDebug: when isDebugEnabled is absent, preferDebug=true calls debug', () => {
    const { logSpy } = mkSpies();
    const debug = vi.fn();

    const server: Partial<ServerLogs> = { debug };

    const uiPrefer = createUILogger(server, { preferDebug: true, enableDebug: true });
    uiPrefer.log('dbg');

    expect(debug).toHaveBeenCalledWith('ssr', 'dbg', undefined);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('preferDebug: when isDebugEnabled is absent, preferDebug=false falls back to info (console.log)', () => {
    const { logSpy } = mkSpies();
    const debug = vi.fn();

    const server: Partial<ServerLogs> = { debug };

    const uiNoPrefer = createUILogger(server, { preferDebug: false, enableDebug: true });
    uiNoPrefer.log('fallback');

    expect(debug).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('fallback');
  });

  it('falls back to console.* with raw args when no logger provided', () => {
    const { logSpy, warnSpy, errSpy } = mkSpies();
    const ui = createUILogger(undefined, { enableDebug: true });

    const obj = { n: 5 };
    const err = new Error('oops');

    ui.log('ok', obj);
    ui.warn('hm', obj);
    ui.error('bad', err);

    expect(logSpy).toHaveBeenCalledWith('ok', obj);
    expect(warnSpy).toHaveBeenCalledWith('hm', obj);
    expect(errSpy).toHaveBeenCalledWith('bad', err);
  });
});

describe('createUILogger - toJSONString coverage', () => {
  it('handles Error with stack', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };
    const ui = createUILogger(server, { enableDebug: true });

    const err = new Error('with stack');
    err.stack = 'Error: with stack\n  at ...\n  at ...';

    ui.log(err);

    expect(info).toHaveBeenCalledWith(err.stack, undefined);
  });

  it('handles Error without stack (falls back to message)', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };
    const ui = createUILogger(server, { enableDebug: true });

    const err = new Error('no stack');
    (err as any).stack = undefined;

    ui.log(err);

    expect(info).toHaveBeenCalledWith('no stack', undefined);
  });

  it('handles string input directly', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };
    const ui = createUILogger(server, { enableDebug: true });

    ui.log('plain string');

    expect(info).toHaveBeenCalledWith('plain string', undefined);
  });

  it('handles non-string non-Error with JSON.stringify', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };
    const ui = createUILogger(server, { enableDebug: true });

    ui.log({ obj: 'value' });

    expect(info).toHaveBeenCalledWith(JSON.stringify({ obj: 'value' }), undefined);
  });

  it('handles number, boolean, null', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };
    const ui = createUILogger(server, { enableDebug: true });

    ui.log(42);
    ui.log(true);
    ui.log(null);

    expect(info).toHaveBeenNthCalledWith(1, '42', undefined);
    expect(info).toHaveBeenNthCalledWith(2, 'true', undefined);
    expect(info).toHaveBeenNthCalledWith(3, 'null', undefined);
  });
});

describe('createUILogger - splitMsgAndMeta coverage', () => {
  it('single arg returns meta: undefined', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };
    const ui = createUILogger(server, { enableDebug: true });

    ui.log('only');

    expect(info).toHaveBeenCalledWith('only', undefined);
  });

  it('single non-Error object as second arg becomes meta', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };
    const ui = createUILogger(server, { enableDebug: true });

    const meta = { x: 1 };
    ui.log('msg', meta);

    expect(info).toHaveBeenCalledWith('msg', meta);
  });

  it('single Error as second arg becomes meta.args array', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };
    const ui = createUILogger(server, { enableDebug: true });

    const err = new Error('err');
    (err as any).stack = undefined;
    ui.log('msg', err);

    expect(info).toHaveBeenCalledWith('msg', { args: ['err'] });
  });

  it('multiple args become meta.args array', () => {
    const info = vi.fn();
    const server: ServerLogs = { info, warn: vi.fn(), error: vi.fn() };
    const ui = createUILogger(server, { enableDebug: true });

    ui.log('msg', 1, 'two', { three: 3 });

    expect(info).toHaveBeenCalledWith('msg', {
      args: ['1', 'two', JSON.stringify({ three: 3 })],
    });
  });
});
