import { createComponent, createContext, createSignal, useContext } from 'solid-js';

import { createHolder } from './Holder.js';
import { STORE_DETACH, STORE_READINESS, STORE_STATE } from './internal.js';

import type { Accessor, JSX } from 'solid-js';
import type { StoreState } from './internal.js';

/**
 * The snapshot bridge's store (Decision C, normative).
 *
 * The PUBLIC surface is exactly these two members and nothing else - the design freezes it
 * (`solid-renderer-design.md` 1.5). Readiness, settled state and detachment are adapter-internal
 * and symbol-keyed (`internal.ts`), deliberately: @taujs/vue exposed a public `ready`/`status`/
 * `lastError` surface, and every one of those becomes a compatibility obligation. Solid v1 does
 * not repeat that.
 *
 * `data` is a Solid `Accessor<T>`, so components read it the way they read any other signal and it
 * participates in reactivity when `setData` commits.
 */
export type SSRStore<T> = {
  data: Accessor<T>;
  setData(value: T): void;
};

/**
 * Normalise a thrown value into an Error without ever throwing (pattern parity with @taujs/react
 * and @taujs/vue - the pattern is shared, the file is not drift-guarded). A circular object or a
 * hostile `toJSON` must not turn a data-load failure into a second, different failure.
 */
function normaliseError(error: unknown): Error {
  if (error instanceof Error) return error;

  try {
    return new Error(typeof error === 'string' ? error : JSON.stringify(error));
  } catch {
    // `JSON.stringify` threw - a circular structure, or a hostile `toJSON`.
  }

  try {
    return new Error(String(error));
  } catch {
    // `String()` threw too: a hostile `Symbol.toPrimitive`/`toString`. @taujs/react and
    // @taujs/vue's equivalents STOP at the previous step, so a value like this makes their
    // normaliser itself throw. Here that would propagate out of the rejection handler, reject the
    // discarded `.then()` result (an `unhandledRejection`, which Node's default mode turns into a
    // process exit) AND skip `resolveReadiness()` - stranding the adapter's gate forever, which is
    // the exact failure class this store claims to prevent. So this function is TOTAL.
  }

  return new Error('Unknown error');
}

/**
 * Create the route-data store.
 *
 * The seed is a resolved value or a promise. It is deliberately NOT the host's lazy
 * `() => Promise<T>` thunk: the design requires that thunk to be invoked EXACTLY ONCE inside the
 * adapter's guarded completion path and normalised BEFORE store creation, so that a synchronous
 * throw from it is a clean pre-shell fatal rather than a store in a half-built state.
 *
 * Settlement rules (design 1.5):
 *   - `setData` is authoritative IMMEDIATELY and satisfies the adapter's data-ready latch
 *     immediately.
 *   - A superseded loader can neither overwrite the committed value nor keep the response open;
 *     its later settlement is ignored - including a rejection, which must not tear down a tree
 *     that is already rendering against committed data.
 *   - Readiness ALWAYS settles, on success and on failure alike, so the adapter's gate cannot
 *     become a new hang class.
 */
export function createSSRStore<T>(seed: T | Promise<T>): SSRStore<T> {
  // M1: the payload lives in an adapter-owned holder so every terminal can release it.
  const holder = createHolder<T>({ label: 'route data' });
  // The signal carries only a version counter: the VALUE lives in the holder, so detaching truly
  // releases it. Storing the payload in the signal too would defeat M1 - Solid's signal graph
  // would keep it alive behind the accessor.
  const [version, bump] = createSignal(0);

  let status: StoreState['status'] = 'pending';
  let lastError: Error | undefined;
  let superseded = false;
  let detached = false;

  let resolveReadiness!: () => void;
  const readiness = new Promise<void>((resolve) => {
    resolveReadiness = resolve;
  });

  const commit = (value: T) => {
    holder.set(value);
    status = 'success';
    lastError = undefined;
    bump((n) => n + 1);
  };

  const fail = (error: unknown) => {
    lastError = normaliseError(error);
    status = 'error';
    bump((n) => n + 1);
  };

  /**
   * A late settlement is ignored when the store has been SUPERSEDED (R3-08: `setData` is
   * authoritative) or DETACHED (M1: the terminal already released τjs-owned state).
   *
   * Detachment must be in this guard, not only in the holder. The holder refuses the payload
   * WRITE, but `commit`/`fail` also mutate the store's own closure - a late resolution would flip
   * `status` back to `success` after a terminal, and a late rejection would park the rejected
   * Error in `lastError`, retaining whatever its `.cause` and custom properties reference. That is
   * request data surviving the terminal that was supposed to release it.
   */
  const settlementIgnored = () => superseded || detached;

  const loaderResolved = (value: T) => {
    try {
      if (!settlementIgnored()) commit(value);
    } finally {
      resolveReadiness();
    }
  };

  const loaderRejected = (error: unknown) => {
    try {
      if (!settlementIgnored()) fail(error);
    } catch {
      // `normaliseError` is total, so this is unreachable today. It exists so a future edit to the
      // failure path cannot strand readiness: settlement is guaranteed by the `finally` below, and
      // swallowing here keeps the discarded `.then()` result from becoming an unhandledRejection.
    } finally {
      resolveReadiness();
    }
  };

  if (seed instanceof Promise) {
    seed.then(loaderResolved, loaderRejected);
  } else {
    commit(seed);
    resolveReadiness();
  }

  const data: Accessor<T> = () => {
    // Subscribe first, so a component that reads before `setData` still re-runs when it commits.
    version();

    // Checked BEFORE the error branch: detachment clears `lastError`, so a store that failed and
    // was then detached must report the terminal, not a bare "unknown error".
    if (detached) {
      throw new Error('taujs: route data was released when the response terminated and can no longer be read');
    }

    if (status === 'error') {
      throw new Error(`taujs: route data failed to load: ${lastError?.message ?? 'unknown error'}`);
    }

    // Throws with a precise message when pending or detached (see Holder). τjs's own streaming
    // path cannot reach the pending case: the snapshot bridge gates the whole render on readiness,
    // so the value is committed before the first render. This guards the PUBLIC entry point.
    return holder.get();
  };

  const setData = (value: T): void => {
    if (detached) return;
    superseded = true;
    commit(value);
    // Authoritative immediately: satisfies the data-ready latch now, not when the loader settles.
    resolveReadiness();
  };

  const store: SSRStore<T> = { data, setData };

  Object.defineProperties(store, {
    [STORE_READINESS]: { value: readiness, enumerable: false },
    [STORE_STATE]: {
      value: (): StoreState => ({ status, ...(lastError ? { error: lastError } : {}), detached }),
      enumerable: false,
    },
    [STORE_DETACH]: {
      value: (): void => {
        detached = true;
        holder.detach();
        // Release the recorded failure as well as the payload. Detaching an ALREADY-FAILED store
        // otherwise leaves the rejected Error parked in this closure, and an Error retains its
        // `.cause` and custom properties - which for a route-loader failure routinely means
        // request data. The terminal must release that too.
        lastError = undefined;
        // Readiness must still be settled: a terminal that fires while the loader is in flight
        // would otherwise leave an adapter awaiting a promise nothing will ever resolve.
        resolveReadiness();
      },
      enumerable: false,
    },
  });

  return store;
}

// ---------------------------------------------------------------------------------------------
// Provision. INTERNAL: the frozen public API lists `createSSRStore` and `useSSRStore` and no
// provider, so the ADAPTER owns provision and wraps the application component itself. That is also
// what M1 requires - τjs-owned state reaches components only through an adapter-owned seam.
// ---------------------------------------------------------------------------------------------

const SSRStoreContext = createContext<SSRStore<unknown> | undefined>(undefined);

/**
 * Wrap `children` in the store context. Uses `createComponent` rather than JSX so this package's
 * source needs no Solid JSX transform of its own (the application's components are compiled by
 * the managed `vite-plugin-solid`, this module is not).
 */
export function provideSSRStore<T>(store: SSRStore<T>, children: () => JSX.Element): JSX.Element {
  return createComponent(SSRStoreContext.Provider, {
    value: store as SSRStore<unknown>,
    get children() {
      return children();
    },
  });
}

/**
 * Read the route-data store from inside a component.
 *
 * Deliberate divergence from @taujs/react's `useSSRStore`, which returns the resolved VALUE via
 * `useSyncExternalStore`: Solid has no equivalent value-hook idiom, and returning the store lets a
 * component use `store.data()` exactly like any other accessor. Do not "harmonise" it with React.
 */
export function useSSRStore<T>(): SSRStore<T> {
  const store = useContext(SSRStoreContext) as SSRStore<T> | undefined;

  if (!store) {
    throw new Error('taujs: useSSRStore must be called inside a component rendered by the τjs Solid renderer');
  }

  return store;
}
