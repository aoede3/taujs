// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSSRStore } from '../SSRDataStore.js';

// R3-08 (S2, vue twin) — an explicit `setData` supersedes the in-flight initial promise. Pre-fix,
// a LATE loader rejection flipped `status` to 'error' (contradicting the explicitly-set data in
// every reactive consumer, with a misleading "Failed to load initial data" log) and a LATE
// resolution silently overwrote `data.value`. Vue's `getSnapshot` never throws, so unlike react
// there is no tree teardown — state corruption only.

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

describe('R3-08 setData supersedes the in-flight initial promise (vue twin)', () => {
  it('a late loader REJECTION does not flip the store into an error state', async () => {
    let rejectLoader!: (e: Error) => void;
    const store = createSSRStore<{ v: string }>(
      new Promise((_, rej) => {
        rejectLoader = rej;
      }),
    );
    store.setData({ v: 'from-setData' });

    rejectLoader(new Error('loader failed late'));
    await new Promise((r) => setTimeout(r, 10));

    expect(store.status.value).toBe('success');
    expect(store.data.value).toEqual({ v: 'from-setData' });
    expect(store.lastError.value).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
    await expect(store.ready).resolves.toBeUndefined();
  });

  it('a late loader RESOLUTION does not overwrite an explicit setData', async () => {
    let resolveLoader!: (v: { v: string }) => void;
    const store = createSSRStore<{ v: string }>(
      new Promise((res) => {
        resolveLoader = res;
      }),
    );
    store.setData({ v: 'from-setData' });

    resolveLoader({ v: 'from-loader' });
    await new Promise((r) => setTimeout(r, 10));

    expect(store.data.value).toEqual({ v: 'from-setData' });
    expect(store.getSnapshot()).toEqual({ v: 'from-setData' });
  });

  it('control: without setData the loader still settles the store normally (success and error)', async () => {
    const success = createSSRStore<{ v: string }>(Promise.resolve({ v: 'from-loader' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(success.data.value).toEqual({ v: 'from-loader' });
    await expect(success.ready).resolves.toBeUndefined();

    const failure = createSSRStore<{ v: string }>(Promise.reject(new Error('loader boom')));
    await new Promise((r) => setTimeout(r, 10));
    expect(failure.status.value).toBe('error');
    expect(consoleError).toHaveBeenCalled();
    await expect(failure.ready).rejects.toThrow('loader boom');
  });
});
