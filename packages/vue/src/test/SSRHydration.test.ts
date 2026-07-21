// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, inject, nextTick, ref, watch, type App, type InjectionKey } from 'vue';

import { hydrateApp } from '../SSRHydration';

const CleanApp = () => h('div', 'app');

const setRoot = (html: string) => {
  document.body.innerHTML = `<div id="root">${html}</div>`;
};
const setData = (d?: unknown) => {
  if (d === undefined) delete (window as any).__INITIAL_DATA__;
  else (window as any).__INITIAL_DATA__ = d;
};

let spies: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  delete (window as any).__TAUJS_DEVTOOLS_HOOK__;
  spies = [
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
  ];
});
afterEach(() => {
  spies.forEach((s) => s.mockRestore());
});

describe('hydrateApp — mount paths', () => {
  it('hydrates when SSR data is present (reuses markup, renders content)', () => {
    setRoot('<div>app</div>');
    setData({ a: 1 });
    const onSuccess = vi.fn();

    hydrateApp({ appComponent: CleanApp, onSuccess });

    const root = document.getElementById('root')!;
    expect(root.textContent).toBe('app');
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('mounts CSR (fresh) when SSR data is absent - clears stale markup, calls onSuccess once, no onStart or beacon (Slice B)', () => {
    setRoot('<div>stale</div>');
    setData(undefined);
    const events: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => events.push(ev) };
    const onStart = vi.fn();
    const onSuccess = vi.fn();

    hydrateApp({ appComponent: CleanApp, onStart, onSuccess });

    const root = document.getElementById('root')!;
    expect(root.textContent).toBe('app');
    // Slice B: a successful CSR root establishment reports onSuccess (react parity), receiving the App.
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0]![0]).toBeDefined();
    // ...but the CSR path still emits no onStart and no hydration beacon (a CSR mount is not a hydration).
    expect(onStart).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('a throwing CSR onSuccess is isolated and the mounted app remains (Slice B)', () => {
    setRoot('<div>stale</div>');
    setData(undefined);
    const onHydrationError = vi.fn();

    expect(() =>
      hydrateApp({
        appComponent: CleanApp,
        onSuccess: () => {
          throw new Error('csr onSuccess boom');
        },
        onHydrationError,
      }),
    ).not.toThrow();

    const root = document.getElementById('root')!;
    expect(root.textContent).toBe('app'); // the app stayed mounted
    expect(onHydrationError).not.toHaveBeenCalled(); // a callback throw is not a bootstrap failure
  });

  it('logs and does not mount when the root element is missing', () => {
    document.body.innerHTML = '<div id="somewhere-else"></div>';
    setData({ a: 1 });
    const error = vi.fn();
    const onStart = vi.fn();

    hydrateApp({ appComponent: CleanApp, rootElementId: 'root', enableDebug: true, logger: { error }, onStart });

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('Root element with id "root" not found');
    expect(onStart).not.toHaveBeenCalled();
  });

  it('missing root: reports via onHydrationError + hydration:error beacon; hydration never starts (R2-03)', () => {
    document.body.innerHTML = '<div id="somewhere-else"></div>';
    setData({ a: 1 });
    const events: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => events.push(ev) };
    const error = vi.fn();
    const onHydrationError = vi.fn();
    const onStart = vi.fn();

    hydrateApp({ appComponent: CleanApp, rootElementId: 'root', logger: { error }, onHydrationError, onStart });

    expect(onHydrationError).toHaveBeenCalledTimes(1);
    expect((onHydrationError.mock.calls[0]![0] as Error).message).toContain('Root element with id "root" not found');
    // error-without-start (vue precedent — a setupApp failure emits the same way); hydration never began
    expect(events).toEqual(['hydration:error']);
    expect(onStart).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]![0])).toContain('not found');
  });
});

describe('hydrateApp — error handler wiring (F11)', () => {
  it('routes a component error during the hydration phase to onHydrationError (not a synchronous throw)', () => {
    const Boom = defineComponent({
      name: 'Boom',
      setup() {
        throw new Error('setup exploded');
      },
      render() {
        return h('div', 'app');
      },
    });
    setRoot('<div>app</div>');
    setData({ a: 1 });
    const onHydrationError = vi.fn();

    expect(() => hydrateApp({ appComponent: Boom, onHydrationError })).not.toThrow();

    expect(onHydrationError).toHaveBeenCalledTimes(1);
    expect((onHydrationError.mock.calls[0]![0] as Error).message).toContain('setup exploded');
  });

  it('a runtime error AFTER the hydration phase is logged only, not re-reported as a hydration failure', async () => {
    const trigger = ref(0);
    const Later = defineComponent({
      name: 'Later',
      setup() {
        watch(trigger, () => {
          throw new Error('post-phase boom');
        });
        return () => h('div', 'app');
      },
    });
    setRoot('<div>app</div>');
    setData({ a: 1 });
    const events: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => events.push(ev) };
    const onHydrationError = vi.fn();

    hydrateApp({ appComponent: Later, onHydrationError });
    expect(events).toEqual(['hydration:start', 'hydration:success']);

    // Close the hydration phase, then provoke a runtime error via the watcher.
    await nextTick();
    trigger.value = 1;
    await nextTick();

    // No second hydration:error, onHydrationError untouched — the phase has closed.
    expect(events).toEqual(['hydration:start', 'hydration:success']);
    expect(onHydrationError).not.toHaveBeenCalled();
  });

  it('forwards Vue warnings to the logger in enableDebug mode (hydration mismatch)', () => {
    // Markup deliberately mismatches the component render → Vue emits a hydration warning.
    setRoot('<span>mismatch</span>');
    setData({ a: 1 });
    const warn = vi.fn();

    hydrateApp({ appComponent: CleanApp, enableDebug: true, logger: { warn } });

    const warned = warn.mock.calls.some(([msg]) => String(msg).includes('Vue warning during hydration'));
    expect(warned).toBe(true);
  });
});

describe('hydrateApp — setupApp (V1-06)', () => {
  const MSG: InjectionKey<string> = Symbol('msg');
  let captured: string | undefined;
  const Capturer = defineComponent({
    setup() {
      captured = inject(MSG, 'no-plugin');
      return () => h('div', { id: 'app' }, 'x');
    },
  });
  beforeEach(() => {
    captured = undefined;
  });

  it('runs setupApp on the hydrate path (a provided value is injectable by the component)', () => {
    setRoot('<div id="app">x</div>');
    setData({});
    hydrateApp({ appComponent: Capturer, setupApp: (app: App) => app.provide(MSG, 'from-plugin') });
    expect(captured).toBe('from-plugin');
  });

  it('runs setupApp on the CSR fallback path too', () => {
    setRoot('<div>stale</div>');
    setData(undefined);
    hydrateApp({ appComponent: Capturer, setupApp: (app: App) => app.provide(MSG, 'from-plugin') });
    expect(captured).toBe('from-plugin');
  });

  it('a throwing setupApp in the hydrate path routes to onHydrationError + hydration:error (no success)', () => {
    setRoot('<div id="app">x</div>');
    setData({});
    const events: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => events.push(ev) };
    const onHydrationError = vi.fn();
    const onSuccess = vi.fn();

    expect(() =>
      hydrateApp({
        appComponent: () => h('div', { id: 'app' }, 'x'),
        setupApp: () => {
          throw new Error('setup boom');
        },
        onHydrationError,
        onSuccess,
      }),
    ).not.toThrow();

    // R4: setupApp runs before emitDevHook('hydration:start'), so a setupApp failure emits
    // hydration:error with no preceding start (hydration never began).
    expect(events).toEqual(['hydration:error']);
    expect(onHydrationError).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('a throwing setupApp in the CSR path routes to onHydrationError only (no beacon, R2)', () => {
    setRoot('<div>stale</div>');
    setData(undefined);
    const events: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => events.push(ev) };
    const onHydrationError = vi.fn();

    hydrateApp({
      appComponent: () => h('div'),
      setupApp: () => {
        throw new Error('csr boom');
      },
      onHydrationError,
    });

    // CSR is not a hydration — no beacon events, but the error still reaches onHydrationError.
    expect(events).toEqual([]);
    expect(onHydrationError).toHaveBeenCalledTimes(1);
  });

  it('R3: a user errorHandler installed in setupApp still fires alongside τjs on a hydration error', () => {
    const Boom = defineComponent({
      name: 'Boom',
      setup() {
        throw new Error('hydrate boom');
      },
      render() {
        return h('div', { id: 'app' }, 'x');
      },
    });
    setRoot('<div id="app">x</div>');
    setData({});
    const events: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => events.push(ev) };
    const userHandler = vi.fn();
    const onHydrationError = vi.fn();

    hydrateApp({
      appComponent: Boom,
      setupApp: (app: App) => {
        app.config.errorHandler = userHandler;
      },
      onHydrationError,
    });

    expect(userHandler).toHaveBeenCalled(); // user's handler still observes
    expect(onHydrationError).toHaveBeenCalledTimes(1); // AND τjs's routing still ran
    expect(events).toContain('hydration:error');
  });

  it('onStart, onSuccess, and setupApp all receive the same App instance', () => {
    setRoot('<div id="app">x</div>');
    setData({});
    const apps: unknown[] = [];

    hydrateApp({
      appComponent: () => h('div', { id: 'app' }, 'x'),
      setupApp: (a: App) => apps.push(a),
      onStart: (a: App) => apps.push(a),
      onSuccess: (a: App) => apps.push(a),
    });

    expect(apps).toHaveLength(3);
    expect(apps[0]).toBe(apps[1]);
    expect(apps[1]).toBe(apps[2]);
  });
});

describe('hydrateApp — observer isolation (gate review R2-03/R2-04, hardening-lessons §1)', () => {
  it('a throwing onStart is isolated: the app still mounts and success is still emitted (no manufactured error)', () => {
    setRoot('<div>app</div>');
    setData({ a: 1 });
    const events: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => events.push(ev) };
    const onHydrationError = vi.fn();
    const onSuccess = vi.fn();
    const onStart = vi.fn(() => {
      throw new Error('onStart boom');
    });

    expect(() => hydrateApp({ appComponent: CleanApp, logger: { error: vi.fn() }, onStart, onSuccess, onHydrationError })).not.toThrow();

    // An advisory observer must never stop the app hydrating.
    expect(document.getElementById('root')!.textContent).toBe('app');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['hydration:start', 'hydration:success']);
    expect(onHydrationError).not.toHaveBeenCalled();
  });

  it('a throwing onSuccess is isolated: one success, and NO hydration:error is manufactured after it', () => {
    setRoot('<div>app</div>');
    setData({ a: 1 });
    const events: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => events.push(ev) };
    const onHydrationError = vi.fn();
    const onSuccess = vi.fn(() => {
      throw new Error('onSuccess boom');
    });

    expect(() => hydrateApp({ appComponent: CleanApp, logger: { error: vi.fn() }, onSuccess, onHydrationError })).not.toThrow();

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['hydration:start', 'hydration:success']);
    expect(events).not.toContain('hydration:error');
    expect(onHydrationError).not.toHaveBeenCalled();
  });

  it('a throwing onHydrationError cannot escape a setupApp/mount failure', () => {
    setRoot('<div>app</div>');
    setData({ a: 1 });
    const onHydrationError = vi.fn(() => {
      throw new Error('onHydrationError boom');
    });

    expect(() =>
      hydrateApp({
        appComponent: CleanApp,
        logger: { error: vi.fn() },
        onHydrationError,
        setupApp: () => {
          throw new Error('setup exploded');
        },
      }),
    ).not.toThrow();

    expect(onHydrationError).toHaveBeenCalledTimes(1);
  });

  it('a throwing onHydrationError cannot escape the CSR mount failure path', () => {
    setRoot('<div>stale</div>');
    setData(undefined); // no SSR data -> CSR
    const onHydrationError = vi.fn(() => {
      throw new Error('onHydrationError boom');
    });

    expect(() =>
      hydrateApp({
        appComponent: CleanApp,
        logger: { error: vi.fn() },
        onHydrationError,
        setupApp: () => {
          throw new Error('csr setup exploded');
        },
      }),
    ).not.toThrow();

    expect(onHydrationError).toHaveBeenCalledTimes(1);
  });

  it('a throwing onHydrationError cannot escape the missing-root path', () => {
    document.body.innerHTML = '<div id="somewhere-else"></div>';
    setData({ a: 1 });
    const onHydrationError = vi.fn(() => {
      throw new Error('onHydrationError boom');
    });

    expect(() => hydrateApp({ appComponent: CleanApp, rootElementId: 'root', logger: { error: vi.fn() }, onHydrationError })).not.toThrow();

    expect(onHydrationError).toHaveBeenCalledTimes(1);
  });
});
