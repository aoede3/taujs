// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

import { createHolder } from '../Holder.js';
import { createSSRStore, provideSSRStore, useSSRStore } from '../SSRDataStore.js';
import { detachStore, getStoreReadiness, getStoreState, STORE_DETACH, STORE_READINESS, STORE_STATE } from '../internal.js';

type Data = Record<string, unknown>;

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('createHolder (M1 detachable holders)', () => {
  it('holds, replaces and releases a payload', () => {
    const h = createHolder<Data>({ label: 'route data' });

    expect(h.filled).toBe(false);
    expect(() => h.get()).toThrow(/read before it was available/);

    h.set({ a: 1 });
    expect(h.get()).toEqual({ a: 1 });
    expect(h.filled).toBe(true);

    h.set({ a: 2 });
    expect(h.get()).toEqual({ a: 2 });

    h.detach();
    expect(h.detached).toBe(true);
    expect(h.filled).toBe(false);
    expect(() => h.get()).toThrow(/released when the response terminated/);
  });

  it('detach is idempotent and a post-detach set cannot resurrect state', () => {
    const h = createHolder<Data>();
    h.set({ a: 1 });
    h.detach();
    h.detach(); // idempotent

    h.set({ a: 2 }); // a late continuation must not refill a detached holder
    expect(h.filled).toBe(false);
    expect(() => h.get()).toThrow(/released/);
  });

  it('distinguishes a legitimately-undefined payload from "never set"', () => {
    const h = createHolder<undefined>();
    expect(() => h.get()).toThrow(/read before it was available/);

    h.set(undefined);
    expect(h.filled).toBe(true);
    expect(h.get()).toBeUndefined();
  });
});

describe('createSSRStore - public surface', () => {
  it('exposes EXACTLY { data, setData } as own enumerable members (frozen API 1.5)', () => {
    const store = createSSRStore<Data>({ a: 1 });

    expect(Object.keys(store).sort()).toEqual(['data', 'setData']);
    // the internal seams exist but are symbol-keyed and non-enumerable
    expect(Object.getOwnPropertyNames(store).sort()).toEqual(['data', 'setData']);
    expect(typeof (store as never as Record<symbol, unknown>)[STORE_READINESS]).toBe('object');
    expect(typeof (store as never as Record<symbol, unknown>)[STORE_STATE]).toBe('function');
    expect(typeof (store as never as Record<symbol, unknown>)[STORE_DETACH]).toBe('function');
  });

  it('a resolved seed is committed synchronously and readiness is already settled', async () => {
    const store = createSSRStore<Data>({ a: 1 });

    expect(store.data()).toEqual({ a: 1 });
    expect(getStoreState(store)?.status).toBe('success');
    await expect(getStoreReadiness(store)).resolves.toBeUndefined();
  });

  it('a promise seed settles into the store and resolves readiness', async () => {
    const store = createSSRStore<Data>(Promise.resolve({ a: 1 }));

    expect(getStoreState(store)?.status).toBe('pending');
    expect(() => store.data()).toThrow(/read before it was available/);

    await getStoreReadiness(store);

    expect(getStoreState(store)?.status).toBe('success');
    expect(store.data()).toEqual({ a: 1 });
  });

  it('a rejected seed records the error, resolves readiness, and does NOT reject it', async () => {
    const store = createSSRStore<Data>(Promise.reject(new Error('loader boom')));

    // Readiness must ALWAYS settle - a rejecting readiness would need an observer at every await
    // site or become an unhandledRejection.
    await expect(getStoreReadiness(store)).resolves.toBeUndefined();

    const state = getStoreState(store);
    expect(state?.status).toBe('error');
    expect(state?.error?.message).toBe('loader boom');
    expect(() => store.data()).toThrow(/route data failed to load: loader boom/);
  });

  it('normalises a non-Error rejection without throwing a second time', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const store = createSSRStore<Data>(Promise.reject(circular));
    await getStoreReadiness(store);

    expect(getStoreState(store)?.status).toBe('error');
    expect(getStoreState(store)?.error).toBeInstanceOf(Error);
  });
});

describe('createSSRStore - supersession (setData is authoritative immediately)', () => {
  it('setData commits immediately and satisfies readiness before the loader settles', async () => {
    let release!: (v: Data) => void;
    const store = createSSRStore<Data>(new Promise<Data>((r) => (release = r)));

    const readiness = getStoreReadiness(store)!;
    const observed = vi.fn();
    void readiness.then(observed);

    store.setData({ committed: true });

    expect(store.data()).toEqual({ committed: true });
    await tick();
    expect(observed).toHaveBeenCalledTimes(1); // satisfied NOW, not when the loader settles

    release({ late: true });
    await tick();
    expect(store.data()).toEqual({ committed: true }); // still the committed value
  });

  it('a superseded loader RESOLUTION cannot overwrite the committed value', async () => {
    let release!: (v: Data) => void;
    const store = createSSRStore<Data>(new Promise<Data>((r) => (release = r)));

    store.setData({ committed: true });
    release({ late: true });
    await tick();

    expect(store.data()).toEqual({ committed: true });
    expect(getStoreState(store)?.status).toBe('success');
  });

  it('a superseded loader REJECTION cannot tear down a committed store', async () => {
    let boom!: (e: unknown) => void;
    const store = createSSRStore<Data>(new Promise<Data>((_, rej) => (boom = rej)));

    store.setData({ committed: true });
    boom(new Error('late failure'));
    await tick();

    // The response is already rendering against committed data - a late loader failure must not
    // flip it into an error state.
    expect(getStoreState(store)?.status).toBe('success');
    expect(getStoreState(store)?.error).toBeUndefined();
    expect(store.data()).toEqual({ committed: true });
  });

  it('a never-settling superseded loader cannot hold the response open', async () => {
    const store = createSSRStore<Data>(new Promise<Data>(() => {})); // never settles
    store.setData({ committed: true });

    await expect(getStoreReadiness(store)).resolves.toBeUndefined();
  });
});

describe('createSSRStore - detachment (M1)', () => {
  it('detach releases the payload and makes data() throw', () => {
    const store = createSSRStore<Data>({ a: 1 });
    expect(store.data()).toEqual({ a: 1 });

    detachStore(store);

    expect(getStoreState(store)?.detached).toBe(true);
    expect(() => store.data()).toThrow(/released when the response terminated/);
  });

  it('detach settles readiness even with a loader still in flight (no new hang class)', async () => {
    const store = createSSRStore<Data>(new Promise<Data>(() => {}));

    detachStore(store);

    await expect(getStoreReadiness(store)).resolves.toBeUndefined();
  });

  it('setData after detach cannot resurrect τjs-owned state', () => {
    const store = createSSRStore<Data>({ a: 1 });
    detachStore(store);

    store.setData({ resurrected: true });

    expect(() => store.data()).toThrow(/released/);
    expect(getStoreState(store)?.detached).toBe(true);
  });

  it('a loader settling AFTER detach cannot refill the holder', async () => {
    let release!: (v: Data) => void;
    const store = createSSRStore<Data>(new Promise<Data>((r) => (release = r)));

    detachStore(store);
    release({ late: true });
    await tick();

    expect(() => store.data()).toThrow(/released/);
  });

  // --- Late-settlement boundary. The holder refuses the payload WRITE, but `commit`/`fail` also
  // mutate the store's own closure, so detachment has to be in the settlement guard too. Without
  // that, a terminal does not actually end the store's lifetime.
  it('a late RESOLUTION after detach does not flip status back to success', async () => {
    let release!: (v: Data) => void;
    const store = createSSRStore<Data>(new Promise<Data>((r) => (release = r)));

    detachStore(store);
    release({ late: true });
    await tick();

    expect(getStoreState(store)?.status).not.toBe('success');
    expect(getStoreState(store)?.detached).toBe(true);
  });

  it('a late REJECTION after detach does not park the error in the store', async () => {
    let boom!: (e: unknown) => void;
    const store = createSSRStore<Data>(new Promise<Data>((_, j) => (boom = j)));

    detachStore(store);
    boom(new Error('late failure', { cause: { secret: 'REQUEST-DATA' } }));
    await tick();

    // An Error retains its `.cause` and custom properties - for a route-loader failure that
    // routinely means request data. The terminal must release that too.
    expect(getStoreState(store)?.error).toBeUndefined();
  });

  it('detaching an ALREADY-FAILED store clears the retained error', async () => {
    const store = createSSRStore<Data>(Promise.reject(new Error('boom', { cause: { secret: 'REQUEST-DATA' } })));
    await getStoreReadiness(store);
    expect(getStoreState(store)?.error).toBeDefined();

    detachStore(store);

    expect(getStoreState(store)?.error).toBeUndefined();
    // and the accessor reports the TERMINAL, not a bare "unknown error" left by the cleared state
    expect(() => store.data()).toThrow(/released when the response terminated/);
  });

  it('detach is idempotent', () => {
    const store = createSSRStore<Data>({ a: 1 });
    detachStore(store);
    detachStore(store);

    expect(getStoreState(store)?.detached).toBe(true);
  });

  // M1's core claim, proven CAUSALLY rather than asserted: the signal carries a version counter,
  // not the value, so detaching the holder drops the only adapter-held reference and the payload
  // becomes collectable. Same instrument as the S0-B2R retain-detach probe - WeakRef + forced GC,
  // with the payload built inside an inner scope so no test-local binding keeps it alive.
  // Skipped (never silently passed) when the runner has no --expose-gc.
  const gc = (globalThis as { gc?: () => void }).gc;
  const gcIt = gc ? it : it.skip;

  const collect = async () => {
    for (let i = 0; i < 10; i++) {
      gc!();
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  gcIt('CONTROL: without detach, the payload is still retained by the store', async () => {
    const make = () => {
      const payload: Data = { big: 'x'.repeat(1024) };
      const store = createSSRStore<Data>(payload);
      return { ref: new WeakRef(payload as object), store };
    };
    const { ref, store } = make();

    await collect();

    expect(ref.deref()).toBeDefined(); // the live store legitimately holds it
    expect(store.data()).toBeDefined();
  });

  gcIt("detach releases a LATE REJECTION's error and everything its cause retains", async () => {
    // The reviewer's case: the leak need not be the successful value. A rejected route loader
    // carries an Error whose `.cause` can reference request data, and `fail()` parks that Error in
    // the store closure - where the holder cannot reach it.
    //
    // INNER-SETUP DISCIPLINE (S0-B2R): the reject function, the settled promise and the Error must
    // ALL die with this call. An earlier version of this test returned `boom` on the result object
    // and failed - a retained reject function keeps the promise alive, which keeps its rejection
    // reason alive, which keeps the payload alive. That was the TEST leaking, not the store, and it
    // is exactly why the instrument has to be built this carefully to mean anything.
    const make = () => {
      const payload = { big: 'x'.repeat(1024) };
      let boom!: (e: unknown) => void;
      const store = createSSRStore<Data>(new Promise<Data>((_, reject) => (boom = reject)));

      detachStore(store);
      boom(new Error('late failure', { cause: payload }));

      return { ref: new WeakRef(payload as object), store };
    };
    const { ref, store } = make();

    await tick(); // let the rejection handler run
    await collect();

    expect(store).toBeDefined(); // the store itself is still alive - that is the point
    expect(ref.deref()).toBeUndefined();
  });

  gcIt('detach releases the payload so it becomes collectable', async () => {
    const make = () => {
      const payload: Data = { big: 'x'.repeat(1024) };
      const store = createSSRStore<Data>(payload);
      return { ref: new WeakRef(payload as object), store };
    };
    const { ref, store } = make();

    detachStore(store);
    await collect();

    // The store object itself is still alive here - this is precisely the M1 claim: the ADAPTER
    // holds nothing after a terminal, even while the un-disposed Solid root outlives the response.
    expect(store).toBeDefined();
    expect(ref.deref()).toBeUndefined();
  });
});

describe('createSSRStore - a hostile rejection value cannot strand the adapter (total normaliser)', () => {
  it('resolves readiness, records error, and raises no unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);

    try {
      // Defeats BOTH normalisation attempts: `JSON.stringify` throws via `toJSON`, and `String()`
      // throws via `Symbol.toPrimitive`/`toString`. @taujs/react and @taujs/vue's normalisers stop
      // after the first attempt, so a value like this makes the normaliser itself throw - which
      // would reject the discarded `.then()` result AND skip `resolveReadiness()`, hanging the
      // adapter's gate forever. Verified by construction: before the fix this test TIMED OUT.
      const hostile = {
        toJSON() {
          throw new Error('hostile toJSON');
        },
        toString() {
          throw new Error('hostile toString');
        },
        [Symbol.toPrimitive]() {
          throw new Error('hostile toPrimitive');
        },
      };

      const store = createSSRStore<Data>(Promise.reject(hostile));

      await expect(getStoreReadiness(store)).resolves.toBeUndefined();
      expect(getStoreState(store)?.status).toBe('error');
      expect(getStoreState(store)?.error?.message).toBe('Unknown error');

      await tick();
      await tick();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('detachStore / getStoreReadiness / getStoreState helpers', () => {
  it('are safe on non-store values', () => {
    expect(() => detachStore(undefined)).not.toThrow();
    expect(() => detachStore(null)).not.toThrow();
    expect(() => detachStore({})).not.toThrow();
    expect(getStoreReadiness({})).toBeUndefined();
    expect(getStoreState({})).toBeUndefined();
    expect(getStoreState(null)).toBeUndefined();
  });
});

describe('useSSRStore', () => {
  it('throws a τjs-specific error outside a provider', () => {
    expect(() => useSSRStore()).toThrow(/must be called inside a component rendered by the τjs Solid renderer/);
  });

  it('provideSSRStore makes the store readable from a child component', () => {
    const store = createSSRStore<Data>({ a: 1 });
    let seen: unknown;

    // Solid's createContext defaults outside a root; provision + read is exercised through the
    // real Provider component, invoked the way the adapter invokes it.
    const tree = provideSSRStore(store, () => {
      seen = useSSRStore<Data>().data();
      return null as never;
    });

    // Touch the returned tree so the Provider body actually runs.
    void tree;
    expect(seen).toEqual({ a: 1 });
  });
});

// The synthetic provision test above exercises `createComponent` directly. This one proves
// provision through the REAL Solid SSR path, which is what the adapter will do - a context that
// only works outside a render would be worthless.
describe('provision through a real Solid SSR render', () => {
  it('a component reads committed route data via useSSRStore during renderToStringAsync', async () => {
    const { renderToStringAsync, ssr } = await import('solid-js/web');
    const store = createSSRStore<Data>({ message: 'from-route-data' });

    const html = await renderToStringAsync(() =>
      provideSSRStore(store, () => {
        const value = useSSRStore<Data>().data();
        return ssr(`<p id="msg">${String(value.message)}</p>`) as never;
      }),
    );

    expect(html).toContain('from-route-data');
  });

  it('a detached store makes the render fail loudly rather than emit a silent empty value', async () => {
    const { renderToStringAsync, ssr } = await import('solid-js/web');
    const store = createSSRStore<Data>({ message: 'secret' });
    detachStore(store);

    const render = () =>
      renderToStringAsync(() =>
        provideSSRStore(store, () => {
          const value = useSSRStore<Data>().data();
          return ssr(`<p>${String(value.message)}</p>`) as never;
        }),
      );

    // B1 exp01, pinned here because slice 3's adapter depends on it: a SYNCHRONOUS render throw
    // escapes `renderToStringAsync` BEFORE a promise exists, so it is a plain throw and NOT a
    // rejection. The adapter must therefore wrap the render call in try/catch, not only attach a
    // `.catch` - that is why `renderSSR` has an outer try/catch in slice 3.
    expect(render).toThrow(/released when the response terminated/);

    // and the released payload never reaches the output
    let html = '';
    try {
      html = await render();
    } catch {
      /* expected */
    }
    expect(html).not.toContain('secret');
  });
});
