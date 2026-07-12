import React, { createContext, useContext, useSyncExternalStore } from 'react';

import { STORE_READINESS } from './internal.js';

export type SSRStore<T> = {
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  setData: (newData: T) => void;
  subscribe: (callback: () => void) => () => void;
  readonly status: 'pending' | 'success' | 'error';
  readonly lastError?: Error;
};

/**
 * Normalise a thrown value into an Error (pattern parity with @taujs/vue's store; these files are not
 * drift-guarded, so the PATTERN matches rather than the bytes). The previous
 * `new Error(String(JSON.stringify(error)))` quoted a thrown string ("boom" -> '"boom"') and THREW on a
 * circular object, turning a data-load failure into an unhandled rejection.
 */
function normaliseError(error: unknown): Error {
  if (error instanceof Error) return error;
  try {
    return new Error(typeof error === 'string' ? error : JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

export function createSSRStore<T>(initialDataOrPromise: T | Promise<T> | (() => Promise<T>)): SSRStore<T> {
  let currentData: T | undefined;
  let status: 'pending' | 'success' | 'error';
  let lastError: Error | undefined;
  let serverDataPromise: Promise<void>;

  const subscribers = new Set<() => void>();

  const notify = () => subscribers.forEach((cb) => cb());

  const handleError = (error: unknown) => {
    const e = normaliseError(error);
    // NOTE: keep this console.error: it's useful in environments without logger wiring.
    console.error('Failed to load initial data:', e);
    lastError = e;
    status = 'error';
    notify();
  };

  if (typeof initialDataOrPromise === 'function') {
    // Lazy promise
    status = 'pending';
    serverDataPromise = (initialDataOrPromise as () => Promise<T>)()
      .then((data) => {
        currentData = data;
        status = 'success';
        notify();
      })
      .catch(handleError);
  } else if (initialDataOrPromise instanceof Promise) {
    // Immediate promise
    status = 'pending';
    serverDataPromise = initialDataOrPromise
      .then((data) => {
        currentData = data;
        status = 'success';
        notify();
      })
      .catch(handleError);
  } else {
    // Raw data
    currentData = initialDataOrPromise;
    status = 'success';
    serverDataPromise = Promise.resolve();
  }

  const setData = (newData: T) => {
    currentData = newData;
    status = 'success';
    notify();
  };

  const subscribe = (callback: () => void) => {
    subscribers.add(callback);

    return () => subscribers.delete(callback);
  };

  const getSnapshot = (): T => {
    if (status === 'pending') throw serverDataPromise;
    if (status === 'error') throw new Error(`SSR data fetch failed: ${lastError?.message || 'Unknown error'}`);
    if (currentData === undefined) throw new Error('SSR data is undefined - store initialisation problem');

    return currentData;
  };

  const getServerSnapshot = (): T => {
    if (status === 'pending') throw serverDataPromise;
    if (status === 'error') throw new Error(`Server-side data fetch failed: ${lastError?.message || 'Unknown error'}`);
    if (currentData === undefined) throw new Error('Server data not available - check SSR configuration');

    return currentData;
  };

  const store: SSRStore<T> = {
    getSnapshot,
    getServerSnapshot,
    setData,
    subscribe,
    get status() {
      return status;
    },
    get lastError() {
      return lastError;
    },
  };

  // R1-01: attach package-internal readiness for the streaming end-gate WITHOUT adding it to the
  // public SSRStore<T> type (design 1 / decisions item 10).
  (store as Record<symbol, unknown>)[STORE_READINESS] = serverDataPromise;

  return store;
}

const SSRStoreContext = createContext<SSRStore<any> | null>(null);

export const SSRStoreProvider = <T,>({ store, children }: React.PropsWithChildren<{ store: SSRStore<T> }>) => (
  <SSRStoreContext.Provider value={store}>{children}</SSRStoreContext.Provider>
);

/**
 * Read the current store value. Suspends while the initial load is pending; throws on load error.
 *
 * Caveat (react.dev, `useSyncExternalStore`): a render triggered by a store MUTATION cannot be a
 * non-blocking Transition. If the render caused by a `setData` suspends through app-level
 * constructs derived from the store value (a `React.lazy` component selected by it, or a `use()`
 * promise built from it), React replaces already-revealed content with the nearest Suspense
 * fallback. After hydration, drive suspension-prone UI from component state inside
 * `startTransition` rather than directly from store values.
 * See https://react.dev/reference/react/useSyncExternalStore#caveats (R3-03 §0 ruling).
 */
export const useSSRStore = <T,>(): T => {
  const store = useContext(SSRStoreContext) as SSRStore<T> | null;

  if (!store) throw new Error('useSSRStore must be used within a SSRStoreProvider');

  // R3-02 (C3): read the store directly. The previous `useMemo(() => deferred, [deferred])` was an
  // identity memo (a no-op by definition), and `useDeferredValue` was introduced with no stated
  // rationale, is depended on by no test, has no @taujs/vue equivalent, and MEASURABLY cost an extra
  // render pass per update while serving one-render-stale data from a store whose consumers want the
  // current value. Both removed; see decisions.md.
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
};
