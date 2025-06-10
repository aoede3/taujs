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
  it('should initialize with initial data after promise resolves', async () => {
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
    console.error = () => {}; // suppress error

    await act(async () => {
      try {
        await errorPromise;
      } catch (e) {}
    });

    expect(() => store.getSnapshot()).toThrow('An error occurred while fetching the data.');
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
});

describe('SSRStoreProvider and useSSRStore', () => {
  it('should provide store data via useSSRStore', async () => {
    const initialDataPromise = Promise.resolve({ foo: 'bar' });
    const store = createSSRStore<Record<string, unknown>>(initialDataPromise);

    const TestComponent: React.FC = () => {
      const maybeData = useSSRStore<Record<string, unknown>>();
      const data = typeof maybeData.getSnapshot === 'function' ? maybeData.getSnapshot() : (maybeData as Record<string, unknown>);

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
    console.error = () => {}; // suppress error

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
    const errorPromise = Promise.reject(new Error('Failed to load data'));
    const store = createSSRStore<Record<string, unknown>>(errorPromise);

    const TestComponent: React.FC = () => {
      const maybeData = useSSRStore<Record<string, unknown>>();
      const data = typeof maybeData.getSnapshot === 'function' ? maybeData.getSnapshot() : (maybeData as Record<string, unknown>);

      return <div>{data['foo'] as string}</div>;
    };

    const consoleError = console.error;
    console.error = () => {}; // suppress error

    const { findByText } = render(
      <SSRStoreProvider store={store}>
        <ErrorBoundary>
          <React.Suspense fallback={<div>Loading...</div>}>
            <TestComponent />
          </React.Suspense>
        </ErrorBoundary>
      </SSRStoreProvider>,
    );

    await act(async () => {
      try {
        await errorPromise;
      } catch {}
    });

    const element = await findByText('Error: An error occurred while fetching the data.');
    expect(element).to.exist;

    console.error = consoleError;
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
    console.error = () => {}; // suppress error

    try {
      await errorPromise;
    } catch {}

    await new Promise((resolve) => setImmediate(resolve));

    expect(() => store.getServerSnapshot()).to.throw('Data is not available on the server.');

    console.error = consoleError;
  });
});
