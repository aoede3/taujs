import React, { createContext, useContext, useSyncExternalStore } from 'react';

type SSRStore<T> = {
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  setData: (newData: T) => void;
  subscribe: (callback: () => void) => () => void;
};

export const createSSRStore = <T,>(initialDataPromise: Promise<T>): SSRStore<T> => {
  let currentData: T;
  let status = 'pending';
  const subscribers = new Set<() => void>();
  let resolvePromise: (() => void) | null = null;
  const serverDataPromise = new Promise<void>((resolve) => (resolvePromise = resolve));

  initialDataPromise
    .then((data) => {
      currentData = data;
      status = 'success';
      subscribers.forEach((callback) => callback());

      if (resolvePromise) resolvePromise();
    })
    .catch((error) => {
      console.error('Failed to load initial data:', error);
      status = 'error';
    });

  const setData = (newData: T): void => {
    currentData = newData;
    status = 'success';
    subscribers.forEach((callback) => callback());

    if (resolvePromise) resolvePromise();
  };

  const subscribe = (callback: () => void): (() => void) => {
    subscribers.add(callback);

    return () => subscribers.delete(callback);
  };

  const getSnapshot = (): T => {
    if (status === 'pending') {
      // trigger client suspense
      throw initialDataPromise;
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

export const useSSRStore = <T,>(): SSRStore<T> => {
  const store = useContext(SSRStoreContext) as SSRStore<T> | null;

  if (!store) throw new Error('useSSRStore must be used within a SSRStoreProvider');

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot) as SSRStore<T>;
};
