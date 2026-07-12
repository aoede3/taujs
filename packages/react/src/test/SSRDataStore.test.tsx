import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  // R3-02 (C2): a thrown STRING keeps its message unquoted. This test previously froze the old
  // behaviour, where `new Error(String(JSON.stringify(error)))` quoted it as '"not an error object"'.
  it('should handle non-Error thrown values', async () => {
    const errorPromise = Promise.reject('not an error object');
    const store = createSSRStore(errorPromise);

    const consoleError = console.error;
    console.error = () => {};

    try {
      await errorPromise;
    } catch {}

    await new Promise((r) => setImmediate(r));

    expect(() => store.getSnapshot()).toThrow('SSR data fetch failed: not an error object');

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

  it('exposes a live status of "error" and lastError after a rejected promise settles', async () => {
    const failure = new Error('Failed to load data');
    const rejection = Promise.reject(failure);
    const store = createSSRStore(rejection);

    // Captured before resolution: must reflect the initial pending state.
    expect(store.status).toBe('pending');
    expect(store.lastError).toBeUndefined();

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await rejection.catch(() => {});
    await new Promise((r) => setImmediate(r));

    // Read after resolution: must reflect the settled state, not the stale initial value.
    expect(store.status).toBe('error');
    expect(store.lastError).toBe(failure);

    spy.mockRestore();
  });

  it('exposes a live status of "success" after an immediate promise resolves', async () => {
    const initialDataPromise = Promise.resolve({ foo: 'bar' });
    const store = createSSRStore(initialDataPromise);

    expect(store.status).toBe('pending');
    expect(store.lastError).toBeUndefined();

    await act(async () => {
      await initialDataPromise;
    });

    expect(store.status).toBe('success');
    expect(store.lastError).toBeUndefined();
  });

  it('exposes a live status of "success" after a lazy promise factory resolves', async () => {
    let internalPromise: Promise<{ foo: string }> | undefined;
    const lazyFn = () => {
      internalPromise = Promise.resolve({ foo: 'baz' });
      return internalPromise;
    };
    const store = createSSRStore(lazyFn);

    expect(store.status).toBe('pending');

    await act(async () => {
      await internalPromise!;
    });

    expect(store.status).toBe('success');
    expect(store.lastError).toBeUndefined();
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

  it('getSnapshot uses "Unknown error" when error.message is empty', async () => {
    const err = new Error(''); // empty message → || 'Unknown error'
    const p = Promise.reject(err);
    const store = createSSRStore(p);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await p.catch(() => {}); // let the promise reject
    await new Promise((r) => setImmediate(r)); // allow handleError to run

    expect(() => store.getSnapshot()).toThrow('SSR data fetch failed: Unknown error');

    spy.mockRestore();
  });

  it('getServerSnapshot uses "Unknown error" when error.message is empty', async () => {
    const err = new Error('');
    const p = Promise.reject(err);
    const store = createSSRStore(p);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await p.catch(() => {});
    await new Promise((r) => setImmediate(r));

    expect(() => store.getServerSnapshot()).toThrow('Server-side data fetch failed: Unknown error');

    spy.mockRestore();
  });

  it('getSnapshot throws when status=success but data is undefined (real path)', async () => {
    // resolves to undefined → status = 'success', currentData = undefined
    const p = Promise.resolve(undefined as any);
    const store = createSSRStore(p);

    await p; // wait for success state

    expect(() => store.getSnapshot()).toThrow('SSR data is undefined - store initialisation problem');
  });

  it('getServerSnapshot throws when status=success but data is undefined (real path)', async () => {
    const p = Promise.resolve(undefined as any);
    const store = createSSRStore(p);

    await p;

    expect(() => store.getServerSnapshot()).toThrow('Server data not available - check SSR configuration');
  });
});

describe('R3-02 C2: error normalisation (pattern parity with @taujs/vue)', () => {
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  it('a thrown STRING keeps its message unquoted (was \'"boom"\')', async () => {
    const store = createSSRStore<any>(() => Promise.reject('boom'));
    await settle();
    expect(store.status).toBe('error');
    expect(store.lastError).toBeInstanceOf(Error);
    expect(store.lastError!.message).toBe('boom');
  });

  it('a thrown OBJECT is JSON-stringified', async () => {
    const store = createSSRStore<any>(() => Promise.reject({ code: 500, msg: 'nope' }));
    await settle();
    expect(store.lastError!.message).toBe('{"code":500,"msg":"nope"}');
  });

  it('a thrown ERROR is preserved as the same instance', async () => {
    const original = new Error('original');
    const store = createSSRStore<any>(() => Promise.reject(original));
    await settle();
    expect(store.lastError).toBe(original);
  });

  it('a CIRCULAR object falls back to String(error) and does NOT throw (previously an unhandled rejection)', async () => {
    const circular: any = { a: 1 };
    circular.self = circular; // JSON.stringify throws on this
    const store = createSSRStore<any>(() => Promise.reject(circular));
    await settle();
    expect(store.status).toBe('error');
    expect(store.lastError).toBeInstanceOf(Error);
    expect(store.lastError!.message).toBe('[object Object]');
  });
});

describe('R3-02 C3: useSSRStore reads the store directly (no deferred value, no identity memo)', () => {
  it('setData is observed by the consumer without an extra deferred render pass', async () => {
    const store = createSSRStore<{ n: number }>({ n: 1 });
    const seen: number[] = [];
    const Consumer = () => {
      const d = useSSRStore<{ n: number }>();
      seen.push(d.n);
      return <span data-testid="v">{d.n}</span>;
    };

    render(
      <SSRStoreProvider store={store}>
        <Consumer />
      </SSRStoreProvider>,
    );
    expect(screen.getByTestId('v').textContent).toBe('1');

    await act(async () => {
      store.setData({ n: 2 });
    });

    expect(screen.getByTestId('v').textContent).toBe('2');
    // Previously useDeferredValue produced [1, 1, 2] - an extra render serving one-render-stale data.
    expect(seen).toEqual([1, 2]);
  });
});
