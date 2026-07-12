import React from 'react';
import { act } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSSRStore, SSRStoreProvider, useSSRStore } from '..';
import { getStoreReadiness } from '../internal.js';

// R3-08 (S2) — an explicit `setData` supersedes the in-flight initial promise. Reproduced pre-fix
// (probe 07): a LATE loader rejection flipped status to 'error', `getSnapshot` started throwing,
// and React tore the committed tree down (DOM wiped to "", onUncaughtError "SSR data fetch
// failed: loader failed late"); a LATE resolution silently overwrote the explicit value.

const Comp = () => {
  const d = useSSRStore<{ v: string }>();
  return <span>{d.v}</span>;
};

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

describe('R3-08 setData supersedes the in-flight initial promise', () => {
  it('a late loader REJECTION does not tear down a tree committed via setData', async () => {
    let rejectLoader!: (e: Error) => void;
    const store = createSSRStore<{ v: string }>(
      new Promise((_, rej) => {
        rejectLoader = rej;
      }),
    );
    store.setData({ v: 'from-setData' });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const uncaught: unknown[] = [];
    const root = createRoot(container, { onUncaughtError: (e) => uncaught.push(e) });

    await act(async () => {
      root.render(
        <SSRStoreProvider store={store}>
          <Comp />
        </SSRStoreProvider>,
      );
    });
    expect(container.innerHTML).toBe('<span>from-setData</span>');

    await act(async () => {
      rejectLoader(new Error('loader failed late'));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.innerHTML).toBe('<span>from-setData</span>');
    expect(uncaught).toEqual([]);
    expect(store.status).toBe('success');
    expect(store.lastError).toBeUndefined();

    root.unmount();
    container.remove();
  });

  it('a late loader RESOLUTION does not overwrite an explicit setData', async () => {
    let resolveLoader!: (v: { v: string }) => void;
    const store = createSSRStore<{ v: string }>(
      new Promise((res) => {
        resolveLoader = res;
      }),
    );
    store.setData({ v: 'from-setData' });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SSRStoreProvider store={store}>
          <Comp />
        </SSRStoreProvider>,
      );
    });

    await act(async () => {
      resolveLoader({ v: 'from-loader' });
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.innerHTML).toBe('<span>from-setData</span>');
    expect(store.getSnapshot()).toEqual({ v: 'from-setData' });

    root.unmount();
    container.remove();
  });

  it('control: without setData the loader still settles the store normally (success and error)', async () => {
    const success = createSSRStore<{ v: string }>(Promise.resolve({ v: 'from-loader' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(success.getSnapshot()).toEqual({ v: 'from-loader' });

    const failure = createSSRStore<{ v: string }>(Promise.reject(new Error('loader boom')));
    await new Promise((r) => setTimeout(r, 10));
    expect(failure.status).toBe('error');
    expect(() => failure.getSnapshot()).toThrow('SSR data fetch failed: loader boom');
  });

  it('the internal readiness promise still settles when the loader is superseded (both settlement kinds)', async () => {
    let resolveLoader!: (v: { v: string }) => void;
    const resolved = createSSRStore<{ v: string }>(
      new Promise((res) => {
        resolveLoader = res;
      }),
    );
    resolved.setData({ v: 'x' });

    let rejectLoader!: (e: Error) => void;
    const rejected = createSSRStore<{ v: string }>(
      new Promise((_, rej) => {
        rejectLoader = rej;
      }),
    );
    rejected.setData({ v: 'x' });

    const settled: string[] = [];
    void getStoreReadiness(resolved)!.then(() => settled.push('resolved-loader'));
    void getStoreReadiness(rejected)!.then(() => settled.push('rejected-loader'));

    resolveLoader({ v: 'y' });
    rejectLoader(new Error('late boom'));
    await new Promise((r) => setTimeout(r, 10));

    // The streaming end-gate awaits this promise — supersession must never create a hang class.
    expect(settled.sort()).toEqual(['rejected-loader', 'resolved-loader']);
  });
});
