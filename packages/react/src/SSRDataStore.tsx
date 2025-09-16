import React, { createContext, useContext, useSyncExternalStore } from 'react';

export type SSRStore<T> = {
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  setData: (newData: T) => void;
  subscribe: (callback: () => void) => () => void;
  status: 'pending' | 'success' | 'error';
  lastError?: Error;
};

export function createSSRStore<T>(initialDataOrPromise: T | Promise<T> | (() => Promise<T>)): SSRStore<T> {
  let currentData: T | undefined;
  let status: 'pending' | 'success' | 'error';
  let lastError: Error | undefined;

  const subscribers = new Set<() => void>();
  let serverDataPromise: Promise<void>;

  const notify = () => subscribers.forEach((cb) => cb());

  const handleError = (error: unknown) => {
    const normalised = error instanceof Error ? error : new Error(String(JSON.stringify(error)));
    console.error('Failed to load initial data:', normalised);
    lastError = normalised;
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

  return { getSnapshot, getServerSnapshot, setData, subscribe, status, lastError };
}

// Generic context avoids type errors in Provider
const SSRStoreContext = createContext<SSRStore<any> | null>(null);

export const SSRStoreProvider = <T,>({ store, children }: React.PropsWithChildren<{ store: SSRStore<T> }>) => (
  <SSRStoreContext.Provider value={store}>{children}</SSRStoreContext.Provider>
);

export const useSSRStore = <T,>(): T => {
  const store = useContext(SSRStoreContext) as SSRStore<T> | null;
  if (!store) throw new Error('useSSRStore must be used within a SSRStoreProvider');
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
};
