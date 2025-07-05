import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { act, render } from '@testing-library/react';
import { screen } from '@testing-library/dom';

import { createSSRStore, SSRStoreProvider, useSSRStore } from '..';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (this.state.error) {
      return <div>Error: {this.state.error.message}</div>;
    }
    return this.props.children;
  }
}

describe('createSSRStore', () => {
  it('should initialise immediately with raw data', () => {
    const store = createSSRStore({ foo: 'bar' });
    expect(store.getSnapshot()).toEqual({ foo: 'bar' });
  });

  it('should initialise with initial data after promise resolves', async () => {
    const initialDataPromise = Promise.resolve({ foo: 'bar' });
    const store = createSSRStore(initialDataPromise);

    try {
      store.getSnapshot();
      throw new Error('Expected getSnapshot to throw');
    } catch (e) {
      expect(e).toStrictEqual(initialDataPromise);
    }

    await act(async () => {
      await initialDataPromise;
    });

    expect(store.getSnapshot()).toEqual({ foo: 'bar' });
  });

  it('should initialise from a lazy promise function', async () => {
    const lazyFn = () => Promise.resolve({ foo: 'baz' });
    const store = createSSRStore(lazyFn);

    try {
      store.getSnapshot();
      throw new Error('Expected to throw promise');
    } catch (e) {
      expect(e).to.be.instanceOf(Promise);
    }

    await act(async () => {
      await lazyFn();
    });

    expect(store.getSnapshot()).toEqual({ foo: 'baz' });
  });

  it('should notify subscribers when data changes', async () => {
    const initialDataPromise = Promise.resolve({ foo: 'bar' });
    const store = createSSRStore(initialDataPromise);

    const subscriber = vi.fn();
    store.subscribe(subscriber);

    await act(async () => {
      await initialDataPromise;
    });

    expect(subscriber).toHaveBeenCalledTimes(1);

    subscriber.mockReset();

    act(() => {
      store.setData({ foo: 'baz' });
    });

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ foo: 'baz' });
  });

  it('should handle errors from initialDataPromise', async () => {
    const errorPromise = Promise.reject(new Error('Failed to load data'));
    const store = createSSRStore(errorPromise);

    const consoleError = console.error;
    console.error = () => {};

    await act(async () => {
      try {
        await errorPromise;
      } catch (e) {}
    });

    expect(() => store.getSnapshot()).toThrow('SSR data fetch failed: Failed to load data');
    console.error = consoleError;
  });

  it('should allow setting data before initialDataPromise resolves', async () => {
    let resolvePromise: (value: Record<string, unknown>) => void;
    const initialDataPromise = new Promise<any>((resolve) => {
      resolvePromise = resolve;
    });

    const store = createSSRStore(initialDataPromise);

    act(() => {
      store.setData({ foo: 'early' });
    });

    expect(store.getSnapshot()).toEqual({ foo: 'early' });

    await act(async () => {
      resolvePromise!({ foo: 'bar' });
      await initialDataPromise;
    });

    expect(store.getSnapshot()).toEqual({ foo: 'bar' });
  });

  it('should remove subscriber after unsubscribe', async () => {
    const store = createSSRStore({ foo: 'bar' });
    const callback = vi.fn();
    const unsubscribe = store.subscribe(callback);

    store.setData({ foo: 'baz' });
    expect(callback).toHaveBeenCalledTimes(1);

    callback.mockReset();
    unsubscribe();

    store.setData({ foo: 'qux' });
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('SSRStoreProvider and useSSRStore', () => {
  it('should provide store data via useSSRStore', async () => {
    const initialDataPromise = Promise.resolve({ foo: 'bar' });
    const store = createSSRStore<Record<string, unknown>>(initialDataPromise);

    const TestComponent: React.FC = () => {
      const data = useSSRStore<Record<string, unknown>>();
      return <div>{data.foo as string}</div>;
      return <div>{data['foo'] as string}</div>;
    };

    const { findByText } = render(
      <SSRStoreProvider store={store}>
        <ErrorBoundary>
          <React.Suspense fallback={<div>Loading...</div>}>
            <TestComponent />
          </React.Suspense>
        </ErrorBoundary>
      </SSRStoreProvider>,
    );

    await act(async () => await initialDataPromise);

    const element = await findByText('bar');
    expect(element).to.exist;
  });

  it('should throw error if useSSRStore is used outside of provider', async () => {
    const TestComponent: React.FC = () => {
      useSSRStore();
      return null;
    };

    const consoleError = console.error;
    console.error = () => {};

    const { findByText } = render(
      <ErrorBoundary>
        <React.Suspense fallback={<div>Loading...</div>}>
          <TestComponent />
        </React.Suspense>
      </ErrorBoundary>,
    );

    const element = await findByText('Error: useSSRStore must be used within a SSRStoreProvider');
    expect(element).to.exist;

    console.error = consoleError;
  });

  it('should update component when store data changes', async () => {
    const initialDataPromise = Promise.resolve({ foo: 'bap' });
    const store = createSSRStore<Record<string, unknown>>(initialDataPromise);

    const TestComponent: React.FC = () => {
      const maybeData = useSSRStore<Record<string, unknown>>();
      const data = typeof maybeData.getSnapshot === 'function' ? maybeData.getSnapshot() : (maybeData as Record<string, unknown>);

      return <div>{data['foo'] as string}</div>;
    };

    render(
      <SSRStoreProvider store={store}>
        <ErrorBoundary>
          <React.Suspense fallback={<div>Loading...</div>}>
            <TestComponent />
          </React.Suspense>
        </ErrorBoundary>
      </SSRStoreProvider>,
    );

    await act(async () => await initialDataPromise);

    const elementBar = await screen.findByText('bap');
    expect(elementBar).to.exist;

    act(() => store.setData({ foo: 'baz' }));

    const elementBaz = await screen.findByText('baz');
    expect(elementBaz).to.exist;
  });

  it('should handle errors in useSSRStore when data fetching fails', async () => {
    const errorPromise = new Promise<Record<string, unknown>>((_, reject) => setTimeout(() => reject(new Error('Failed to load data')), 0));
    const store = createSSRStore<Record<string, unknown>>(errorPromise);

    const TestComponent: React.FC = () => {
      const maybeData = useSSRStore<Record<string, unknown>>();
      const data = typeof maybeData.getSnapshot === 'function' ? maybeData.getSnapshot() : (maybeData as Record<string, unknown>);
      return <div>{data['foo'] as string}</div>;
    };

    const consoleError = console.error;
    console.error = () => {};

    const { findByText } = render(
      <SSRStoreProvider store={store}>
        <ErrorBoundary>
          <React.Suspense fallback={<div>Loading...</div>}>
            <TestComponent />
          </React.Suspense>
        </ErrorBoundary>
      </SSRStoreProvider>,
    );

    const element = await findByText(/failed to load data/i);
    expect(element).to.exist;

    console.error = consoleError;
  });

  it('should handle non-Error thrown values', async () => {
    const errorPromise = Promise.reject('not an error object');
    const store = createSSRStore(errorPromise);

    const consoleError = console.error;
    console.error = () => {};

    try {
      await errorPromise;
    } catch {}

    await new Promise((r) => setImmediate(r));

    expect(() => store.getSnapshot()).toThrow('SSR data fetch failed: "not an error object"');

    console.error = consoleError;
  });

  it('should stringify non-Error thrown objects', async () => {
    const errorObj = { foo: 'bar' };
    const errorPromise = Promise.reject(errorObj);
    const store = createSSRStore(errorPromise);

    const consoleError = console.error;
    console.error = () => {};

    try {
      await errorPromise;
    } catch {}

    await new Promise((r) => setImmediate(r));

    expect(() => store.getSnapshot()).toThrow('SSR data fetch failed: {"foo":"bar"}');

    console.error = consoleError;
  });

  it('should use "Unknown error" if lastError is missing', () => {
    const store = createSSRStore({ foo: 'bar' }) as any;

    store.getSnapshot = () => {
      (store as any).status = 'error';
      (store as any).lastError = {};
      return (store as any).originalGetSnapshot();
    };

    store.originalGetSnapshot = () => {
      if (store.status === 'error') {
        throw new Error(`SSR data fetch failed: ${store.lastError?.message || 'Unknown error'}`);
      }
      return store.currentData;
    };

    expect(() => store.getSnapshot()).toThrow('SSR data fetch failed: Unknown error');
  });

  it('should throw if data is undefined even though status is success (SSR init problem)', () => {
    const store = createSSRStore({ foo: 'bar' }) as any;

    store.getSnapshot = () => {
      store.status = 'success';
      store.currentData = undefined;
      return store.originalGetSnapshot();
    };

    store.originalGetSnapshot = () => {
      if (store.status === 'success' && store.currentData === undefined) {
        throw new Error('SSR data is undefined - store initialisation problem');
      }
      return store.currentData;
    };

    expect(() => store.getSnapshot()).toThrow('SSR data is undefined - store initialisation problem');
  });

  it('should throw if server data is undefined even though status is success', () => {
    const store = createSSRStore({ foo: 'bar' }) as any;

    store.getServerSnapshot = () => {
      store.status = 'success';
      store.currentData = undefined;
      return store.originalGetServerSnapshot();
    };

    store.originalGetServerSnapshot = () => {
      if (store.status === 'success' && store.currentData === undefined) {
        throw new Error('Server data not available - check SSR configuration');
      }
      return store.currentData;
    };

    expect(() => store.getServerSnapshot()).toThrow('Server data not available - check SSR configuration');
  });

  it('should throw the serverDataPromise when data is pending', () => {
    const initialDataPromise = new Promise((_resolve) => {
      // Never resolve to simulate pending state
    });
    const store = createSSRStore(initialDataPromise);

    expect(() => store.getServerSnapshot()).toThrow();
  });

  it('should return currentData when data is loaded', async () => {
    const initialData = { foo: 'bar' };
    const initialDataPromise = Promise.resolve(initialData);
    const store = createSSRStore(initialDataPromise);

    await initialDataPromise;

    expect(store.getServerSnapshot()).toEqual(initialData);
  });

  it('should throw an error when there is an error loading data', async () => {
    const errorPromise = Promise.reject(new Error('Failed to load data'));
    const store = createSSRStore(errorPromise);

    const consoleError = console.error;
    console.error = () => {};

    try {
      await errorPromise;
    } catch {}

    await new Promise((resolve) => setImmediate(resolve));

    expect(() => store.getServerSnapshot()).to.throw('Server-side data fetch failed: Failed to load data');

    console.error = consoleError;
  });
});
