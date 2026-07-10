// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-dom/client', () => ({
  hydrateRoot: vi.fn(),
  createRoot: vi.fn(() => ({ render: vi.fn() })),
}));

import * as RDC from 'react-dom/client';
import { hydrateApp } from '../SSRHydration';

const App = <div>app</div>;

const setup = (initialData?: unknown) => {
  document.body.innerHTML = '<div id="root">ssr</div>';
  if (initialData === undefined) delete (window as any).__INITIAL_DATA__;
  else (window as any).__INITIAL_DATA__ = initialData;
};

beforeEach(() => {
  vi.mocked(RDC.hydrateRoot).mockReset();
  vi.mocked(RDC.createRoot).mockClear();
  delete (window as any).__TAUJS_DEVTOOLS_HOOK__;
});

describe('hydrateApp dev-hook emission (P0B-04, spec 03 §7)', () => {
  it('emits start/success around user callbacks — internal first, user second', () => {
    const order: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => order.push(`hook:${ev}`) };
    setup({ a: 1 });

    hydrateApp({
      appComponent: App,
      onStart: () => order.push('user:start'),
      onSuccess: () => order.push('user:success'),
    });

    expect(order).toEqual(['hook:hydration:start', 'user:start', 'hook:hydration:success', 'user:success']);
    expect(RDC.hydrateRoot).toHaveBeenCalledTimes(1);
  });

  it('emits hydration:error and still invokes the user error callback', () => {
    const order: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => order.push(`hook:${ev}`) };
    vi.mocked(RDC.hydrateRoot).mockImplementation(() => {
      throw new Error('hydrate boom');
    });
    setup({ a: 1 });
    const onHydrationError = vi.fn();

    hydrateApp({ appComponent: App, onHydrationError });

    expect(order).toEqual(['hook:hydration:start', 'hook:hydration:error']);
    expect(onHydrationError).toHaveBeenCalledTimes(1);
  });

  it('user callbacks fire identically when the hook is absent (regression)', () => {
    setup({ a: 1 });
    const onStart = vi.fn();
    const onSuccess = vi.fn();

    hydrateApp({ appComponent: App, onStart, onSuccess });

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('a throwing hook never affects hydration or user callbacks', () => {
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = {
      emit: () => {
        throw new Error('hostile hook');
      },
    };
    setup({ a: 1 });
    const onSuccess = vi.fn();

    expect(() => hydrateApp({ appComponent: App, onSuccess })).not.toThrow();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(RDC.hydrateRoot).toHaveBeenCalledTimes(1);
  });

  it('CSR-fallback mounts emit nothing (v1: not a hydration, recorded as an honest gap)', () => {
    const emit = vi.fn();
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit };
    setup(undefined);

    hydrateApp({ appComponent: App });

    expect(emit).not.toHaveBeenCalled();
    expect(RDC.createRoot).toHaveBeenCalledTimes(1);
    expect(RDC.hydrateRoot).not.toHaveBeenCalled();
  });
});
