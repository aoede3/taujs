import React, { createContext, useContext, useSyncExternalStore } from 'react';

export type SSRStore<T> = {
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  setData: (newData: T) => void;
  subscribe: (callback: () => void) => () => void;
};

export const createSSRStore = <T,>(initialDataOrPromise: T | Promise<T>): SSRStore<T> => {
  let currentData: T;
  let status: 'pending' | 'success' | 'error';

  const subscribers = new Set<() => void>();
  let serverDataPromise: Promise<void>;

  if (initialDataOrPromise instanceof Promise) {
    status = 'pending';
    serverDataPromise = initialDataOrPromise
      .then((data) => {
        currentData = data;
        status = 'success';
        subscribers.forEach((callback) => callback());
      })
      .catch((error) => {
        console.error('Failed to load initial data:', error);
        status = 'error';
      })
      .then(() => {});
  } else {
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
      throw new Error('An error occurred while fetching the data.');
    }
    return currentData;
  };

  const getServerSnapshot = (): T => {
    if (status === 'pending') {
      throw serverDataPromise;
    } else if (status === 'error') {
      throw new Error('Data is not available on the server.');
    }
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
