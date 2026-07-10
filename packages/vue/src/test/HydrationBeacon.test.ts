// @vitest-environment jsdom
// Vue twin of @taujs/react's HydrationBeacon.test.tsx (P0B-04). Same event names, same
// internal-first/user-second order, same never-throw guard — exercised against REAL Vue
// hydration (no mock), since Vue surfaces failures via app.config.errorHandler, not throws.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { hydrateApp } from '../SSRHydration';

const CleanApp = () => h('div', 'app');
const ThrowingApp = defineComponent({
  name: 'ThrowingApp',
  setup() {
    throw new Error('hydrate boom');
  },
  render() {
    return h('div', 'app');
  },
});

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

describe('hydrateApp dev-hook emission (P0B-04 twin)', () => {
  it('emits start/success around user callbacks — internal first, user second', () => {
    const order: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => order.push(`hook:${ev}`) };
    setRoot('<div>app</div>');
    setData({ a: 1 });

    hydrateApp({
      appComponent: CleanApp,
      onStart: () => order.push('user:start'),
      onSuccess: () => order.push('user:success'),
    });

    expect(order).toEqual(['hook:hydration:start', 'user:start', 'hook:hydration:success', 'user:success']);
  });

  it('emits hydration:error (and no success) and still invokes the user error callback', () => {
    const order: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => order.push(`hook:${ev}`) };
    setRoot('<div>app</div>');
    setData({ a: 1 });
    const onHydrationError = vi.fn();
    const onSuccess = vi.fn();

    hydrateApp({ appComponent: ThrowingApp, onHydrationError, onSuccess });

    expect(order).toEqual(['hook:hydration:start', 'hook:hydration:error']);
    expect(onHydrationError).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('user callbacks fire identically when the hook is absent (regression)', () => {
    setRoot('<div>app</div>');
    setData({ a: 1 });
    const onStart = vi.fn();
    const onSuccess = vi.fn();

    hydrateApp({ appComponent: CleanApp, onStart, onSuccess });

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('a throwing hook never affects hydration or user callbacks', () => {
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = {
      emit: () => {
        throw new Error('hostile hook');
      },
    };
    setRoot('<div>app</div>');
    setData({ a: 1 });
    const onSuccess = vi.fn();

    expect(() => hydrateApp({ appComponent: CleanApp, onSuccess })).not.toThrow();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('CSR-fallback mounts emit nothing (not a hydration)', () => {
    const emit = vi.fn();
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit };
    setRoot('<div>stale</div>');
    setData(undefined);

    hydrateApp({ appComponent: CleanApp });

    expect(emit).not.toHaveBeenCalled();
  });
});
