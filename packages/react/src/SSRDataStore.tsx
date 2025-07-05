import React, { createContext, useContext, useSyncExternalStore } from 'react';

export type SSRStore<T> = {
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  setData: (newData: T) => void;
  subscribe: (callback: () => void) => () => void;
};

export const createSSRStore = <T,>(initialDataOrPromise: T | Promise<T> | (() => Promise<T>)): SSRStore<T> => {
  let currentData: T | undefined;
  let status: 'pending' | 'success' | 'error';
  let lastError: Error | undefined;

  const subscribers = new Set<() => void>();
  let serverDataPromise: Promise<void>;

  const handleError = (error: unknown) => {
    console.error('Failed to load initial data:', error);
    lastError = error instanceof Error ? error : new Error(String(JSON.stringify(error)));
    status = 'error';
  };

  if (typeof initialDataOrPromise === 'function') {
    // Lazy promise
    status = 'pending';
    const promiseFromFunction = (initialDataOrPromise as () => Promise<T>)();
    serverDataPromise = promiseFromFunction
      .then((data) => {
        currentData = data;
        status = 'success';
        subscribers.forEach((callback) => callback());
      })
      .catch(handleError);
  } else if (initialDataOrPromise instanceof Promise) {
    // Immediate promise
    status = 'pending';
    serverDataPromise = initialDataOrPromise
      .then((data) => {
        currentData = data;
        status = 'success';
        subscribers.forEach((callback) => callback());
      })
      .catch(handleError);
  } else {
    // Raw data
    currentData = initialDataOrPromise;
    status = 'success';
    serverDataPromise = Promise.resolve();
  }

  const setData = (newData: T): void => {
    currentData = newData;
    status = 'success';
    subscribers.forEach((callback) => callback());
  };

  const subscribe = (callback: () => void): (() => void) => {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  };

  const getSnapshot = (): T => {
    if (status === 'pending') {
      // trigger client suspense
      throw serverDataPromise;
    } else if (status === 'error') {
      throw new Error(`SSR data fetch failed: ${lastError?.message || 'Unknown error'}`);
    }
    if (currentData === undefined) throw new Error('SSR data is undefined - store initialisation problem');

    return currentData;
  };

  const getServerSnapshot = (): T => {
    if (status === 'pending') {
      throw serverDataPromise;
    } else if (status === 'error') {
      throw new Error(`Server-side data fetch failed: ${lastError?.message || 'Unknown error'}`);
    }
    if (currentData === undefined) throw new Error('Server data not available - check SSR configuration');

    return currentData;
  };

  return { getSnapshot, getServerSnapshot, setData, subscribe };
};

const SSRStoreContext = createContext<SSRStore<Record<string, unknown>> | null>(null);

export const SSRStoreProvider: React.FC<React.PropsWithChildren<{ store: SSRStore<Record<string, unknown>> }>> = ({ store, children }) => (
  <SSRStoreContext.Provider value={store}>{children}</SSRStoreContext.Provider>
);

export const useSSRStore = <T,>(): T => {
  const store = useContext(SSRStoreContext) as SSRStore<T> | null;

  if (!store) throw new Error('useSSRStore must be used within a SSRStoreProvider');

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
};
