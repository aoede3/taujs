// @vitest-environment happy-dom
//
// Hydration-observability parity for @taujs/solid. This is the ONLY happy-dom file in the package;
// the package-wide environment stays `node` (vitest.config.ts). It drives the REAL exported
// `hydrateApp` and mocks ONLY Solid's terminal `hydrate`/`render` primitives, so a deterministic
// throw can be injected and the exact native-call ordering recorded. `hydrateApp` itself is never
// mocked or reproduced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { hydrateMock, renderMock } = vi.hoisted(() => ({ hydrateMock: vi.fn(), renderMock: vi.fn() }));

vi.mock('solid-js/web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('solid-js/web')>();

  return { ...actual, hydrate: hydrateMock, render: renderMock };
});

import { hydrateApp } from '../SSRHydration.js';

import type { JSX } from 'solid-js';

/** Never invoked - `hydrate`/`render` are mocked, so the app factory is only a shape. */
const stubApp = (_props: { location: string }): JSX.Element => null as unknown as JSX.Element;

const setRoot = () => {
  document.body.innerHTML = '<div id="root"></div>';
};
const setData = (d: unknown) => {
  (window as unknown as { __INITIAL_DATA__?: unknown }).__INITIAL_DATA__ = d;
};
const clearData = () => {
  delete (window as unknown as { __INITIAL_DATA__?: unknown }).__INITIAL_DATA__;
};
/** Install a devtools-hook consumer that appends `beacon:<event>` to `events`. */
const setHook = (events: string[]) => {
  (window as unknown as { __TAUJS_DEVTOOLS_HOOK__?: unknown }).__TAUJS_DEVTOOLS_HOOK__ = {
    emit: (e: string) => events.push(`beacon:${e}`),
  };
};
const clearHook = () => {
  delete (window as unknown as { __TAUJS_DEVTOOLS_HOOK__?: unknown }).__TAUJS_DEVTOOLS_HOOK__;
};

let consoleSpies: {
  log: ReturnType<typeof vi.spyOn>;
  debug: ReturnType<typeof vi.spyOn>;
  warn: ReturnType<typeof vi.spyOn>;
  error: ReturnType<typeof vi.spyOn>;
};

beforeEach(() => {
  hydrateMock.mockReset();
  renderMock.mockReset();
  document.body.innerHTML = '';
  clearData();
  clearHook();
  consoleSpies = {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hydrateApp - lifecycle ordering and settlement (happy-dom, real hydrateApp)', () => {
  it('successful hydration: start beacon -> onStart -> native hydrate -> success beacon -> onSuccess', () => {
    const events: string[] = [];
    setHook(events);
    setRoot();
    setData({ ok: 1 });
    hydrateMock.mockImplementation(() => events.push('native:hydrate'));
    const onHydrationError = vi.fn();

    hydrateApp({
      app: stubApp,
      onStart: () => events.push('cb:onStart'),
      onSuccess: () => events.push('cb:onSuccess'),
      onHydrationError,
    });

    expect(events).toEqual(['beacon:hydration:start', 'cb:onStart', 'native:hydrate', 'beacon:hydration:success', 'cb:onSuccess']);
    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(renderMock).not.toHaveBeenCalled();
    expect(onHydrationError).not.toHaveBeenCalled();
  });

  it('the same callbacks run with the devtools hook absent', () => {
    clearHook();
    setRoot();
    setData({ ok: 1 });
    const onStart = vi.fn();
    const onSuccess = vi.fn();
    const onHydrationError = vi.fn();

    hydrateApp({ app: stubApp, onStart, onSuccess, onHydrationError });

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onHydrationError).not.toHaveBeenCalled();
  });

  it('a synchronous hydrate throw: start then error, onHydrationError once, never onSuccess', () => {
    const events: string[] = [];
    setHook(events);
    setRoot();
    setData({ ok: 1 });
    const boom = new Error('hydrate boom');
    hydrateMock.mockImplementation(() => {
      throw boom;
    });
    const onSuccess = vi.fn();
    const onHydrationError = vi.fn(() => events.push('cb:onHydrationError'));

    hydrateApp({ app: stubApp, onStart: () => events.push('cb:onStart'), onSuccess, onHydrationError });

    expect(events).toEqual(['beacon:hydration:start', 'cb:onStart', 'beacon:hydration:error', 'cb:onHydrationError']);
    expect(onHydrationError).toHaveBeenCalledTimes(1);
    expect(onHydrationError).toHaveBeenCalledWith(boom);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('a missing root: error beacon only, onHydrationError once, no start/success', () => {
    const events: string[] = [];
    setHook(events);
    document.body.innerHTML = ''; // no #root
    setData({ ok: 1 });
    const onStart = vi.fn();
    const onSuccess = vi.fn();
    const onHydrationError = vi.fn(() => events.push('cb:onHydrationError'));

    hydrateApp({ app: stubApp, rootElementId: 'root', onStart, onSuccess, onHydrationError });

    expect(events).toEqual(['beacon:hydration:error', 'cb:onHydrationError']);
    expect(onHydrationError).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(hydrateMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it('successful CSR fallback (no snapshot): no beacon, no onStart, onSuccess once', () => {
    const events: string[] = [];
    setHook(events);
    setRoot();
    clearData();
    renderMock.mockImplementation(() => events.push('native:render'));
    const onStart = vi.fn();
    const onHydrationError = vi.fn();

    hydrateApp({ app: stubApp, onStart, onSuccess: () => events.push('cb:onSuccess'), onHydrationError });

    expect(events).toEqual(['native:render', 'cb:onSuccess']);
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(hydrateMock).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(onHydrationError).not.toHaveBeenCalled();
  });

  it('a failed CSR fallback: no beacon, onHydrationError once, never onSuccess', () => {
    const events: string[] = [];
    setHook(events);
    setRoot();
    clearData();
    const boom = new Error('csr boom');
    renderMock.mockImplementation(() => {
      throw boom;
    });
    const onSuccess = vi.fn();
    const onHydrationError = vi.fn(() => events.push('cb:onHydrationError'));

    hydrateApp({ app: stubApp, onSuccess, onHydrationError });

    expect(events).toEqual(['cb:onHydrationError']);
    expect(onHydrationError).toHaveBeenCalledTimes(1);
    expect(onHydrationError).toHaveBeenCalledWith(boom);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('hydrateApp - observer isolation', () => {
  it('a throwing onStart is logged and hydration still succeeds', () => {
    setRoot();
    setData({ ok: 1 });
    const onSuccess = vi.fn();
    const onHydrationError = vi.fn();

    hydrateApp({
      app: stubApp,
      onStart: () => {
        throw new Error('onStart boom');
      },
      onSuccess,
      onHydrationError,
    });

    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onHydrationError).not.toHaveBeenCalled(); // a callback throw must not manufacture failure
    expect(consoleSpies.error).toHaveBeenCalled(); // the throw was logged
  });

  it('a throwing onSuccess is logged and does not manufacture failure or remove the root', () => {
    setRoot();
    setData({ ok: 1 });
    const onHydrationError = vi.fn();

    hydrateApp({
      app: stubApp,
      onSuccess: () => {
        throw new Error('onSuccess boom');
      },
      onHydrationError,
    });

    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(onHydrationError).not.toHaveBeenCalled();
    expect(consoleSpies.error).toHaveBeenCalled();
  });

  it('a throwing onHydrationError is swallowed and does not escape', () => {
    setRoot();
    setData({ ok: 1 });
    hydrateMock.mockImplementation(() => {
      throw new Error('hydrate boom');
    });

    expect(() =>
      hydrateApp({
        app: stubApp,
        onHydrationError: () => {
          throw new Error('handler boom');
        },
      }),
    ).not.toThrow();
  });

  it('a throwing logger cannot escape or alter settlement', () => {
    setRoot();
    setData({ ok: 1 });
    const throwingLogger = {
      log: () => {
        throw new Error('log boom');
      },
      warn: () => {
        throw new Error('warn boom');
      },
      error: () => {
        throw new Error('error boom');
      },
    };
    const onSuccess = vi.fn();

    expect(() => hydrateApp({ app: stubApp, logger: throwingLogger, enableDebug: true, onSuccess })).not.toThrow();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe('hydrateApp - logging contract', () => {
  it('enableDebug:false suppresses verbose start/success messages (UI logger)', () => {
    setRoot();
    setData({ ok: 1 });
    const uiLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    hydrateApp({ app: stubApp, logger: uiLogger, enableDebug: false, onSuccess: vi.fn() });

    expect(uiLogger.log).not.toHaveBeenCalled();
  });

  it('enableDebug:true emits start and success via a UI logger', () => {
    setRoot();
    setData({ ok: 1 });
    const uiLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    hydrateApp({ app: stubApp, logger: uiLogger, enableDebug: true, onSuccess: vi.fn() });

    const messages = uiLogger.log.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /started/i.test(m))).toBe(true);
    expect(messages.some((m) => /succeeded/i.test(m))).toBe(true);
  });

  it('a server-shaped (Pino) logger receives the same lifecycle through its debug shape', () => {
    setRoot();
    setData({ ok: 1 });
    const server = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    hydrateApp({ app: stubApp, logger: server, enableDebug: true, onSuccess: vi.fn() });

    expect(server.debug.mock.calls.length).toBeGreaterThan(0);
    const messages = server.debug.mock.calls.map((c) => String(c[2] ?? ''));
    expect(messages.some((m) => /started/i.test(m))).toBe(true);
    expect(messages.some((m) => /succeeded/i.test(m))).toBe(true);
  });

  it('hydration/CSR failures reach error regardless of enableDebug', () => {
    for (const enableDebug of [false, true]) {
      setRoot();
      setData({ ok: 1 });
      hydrateMock.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      const uiLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

      hydrateApp({ app: stubApp, logger: uiLogger, enableDebug, onHydrationError: vi.fn() });

      expect(uiLogger.error, `error should fire with enableDebug=${enableDebug}`).toHaveBeenCalled();
    }
  });

  it('with no logger, errors use console while verbose lifecycle stays off by default', () => {
    // Failure with no logger -> console.error.
    setRoot();
    setData({ ok: 1 });
    hydrateMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    hydrateApp({ app: stubApp, onHydrationError: vi.fn() });
    expect(consoleSpies.error).toHaveBeenCalled();

    // Success with enableDebug default false -> no verbose console output.
    consoleSpies.debug.mockClear();
    consoleSpies.log.mockClear();
    setRoot();
    setData({ ok: 1 });
    hydrateApp({ app: stubApp, onSuccess: vi.fn() });
    expect(consoleSpies.debug).not.toHaveBeenCalled();
    expect(consoleSpies.log).not.toHaveBeenCalled();
  });

  it('the initial-data payload is never logged', () => {
    const SECRET = 'super-secret-token-9f3a';
    setRoot();
    setData({ token: SECRET, nested: { x: SECRET } });
    const uiLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    hydrateApp({ app: stubApp, logger: uiLogger, enableDebug: true, onSuccess: vi.fn() });

    const logged = [...uiLogger.log.mock.calls, ...uiLogger.warn.mock.calls, ...uiLogger.error.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    expect(logged).not.toContain(SECRET);
  });
});
