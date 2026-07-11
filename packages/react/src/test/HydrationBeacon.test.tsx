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
  it('emits hydration:start internal-first (beacon before user callback); success is DEFERRED to first commit', () => {
    const order: string[] = [];
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit: (ev: string) => order.push(`hook:${ev}`) };
    setup({ a: 1 });

    const onSuccess = vi.fn(() => order.push('user:success'));
    hydrateApp({
      appComponent: App,
      onStart: () => order.push('user:start'),
      onSuccess,
    });

    // start is internal-first; success is a first-COMMIT signal, so with a no-op mock it has NOT
    // fired synchronously (the success internal-first ordering is proven in the integration suite).
    expect(order).toEqual(['hook:hydration:start', 'user:start']);
    expect(onSuccess).not.toHaveBeenCalled();
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

  it('onStart fires when the hook is absent (regression); onSuccess is deferred to commit', () => {
    setup({ a: 1 });
    const onStart = vi.fn();
    const onSuccess = vi.fn();

    hydrateApp({ appComponent: App, onStart, onSuccess });

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled(); // first-commit signal; no-op mock never commits
  });

  it('a throwing hook never affects hydration or the start callback', () => {
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = {
      emit: () => {
        throw new Error('hostile hook');
      },
    };
    setup({ a: 1 });
    const onStart = vi.fn();

    expect(() => hydrateApp({ appComponent: App, onStart })).not.toThrow();
    expect(onStart).toHaveBeenCalledTimes(1);
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
