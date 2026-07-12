import { computed, defineComponent, inject, provide, shallowReadonly, shallowRef, type ComputedRef, type InjectionKey, type PropType, type Ref } from 'vue';

export type SSRStoreStatus = 'pending' | 'success' | 'error';

export type SSRStore<T> = {
  /** Reactive data ref for Vue components */
  data: Ref<T | undefined>;
  status: Ref<SSRStoreStatus>;
  lastError: Ref<Error | undefined>;

  /**
   * Promise that resolves when initial data is available, or REJECTS with the loader error on
   * failure. Safe to leave unobserved: a no-op rejection handler is pre-attached at creation, so
   * an unawaited store whose loader rejects cannot produce an `unhandledRejection`; consumers who
   * `await` it still observe the rejection. NB once rejected it stays rejected — a later
   * `setData` recovers the store's reactive state but does not re-settle `ready`.
   */
  ready: Promise<void>;

  /** Vue-safe: returns data or undefined (never throws) */
  getSnapshot: () => T | undefined;

  setData: (newData: T) => void;

  /** Subscription API (for non-Vue consumers / tests) */
  subscribe: (callback: () => void) => () => void;
};

function normaliseError(error: unknown): Error {
  if (error instanceof Error) return error;
  try {
    return new Error(typeof error === 'string' ? error : JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

export function createSSRStore<T>(initialDataOrPromise: T | Promise<T> | (() => Promise<T>)): SSRStore<T> {
  const data = shallowRef<T | undefined>(undefined);
  const status = shallowRef<SSRStoreStatus>('pending');
  const lastError = shallowRef<Error | undefined>(undefined);

  const subscribers = new Set<() => void>();
  const notify = () => subscribers.forEach((cb) => cb());

  const handleSuccess = (value: T) => {
    data.value = value;
    status.value = 'success';
    lastError.value = undefined;
    notify();
  };

  const handleError = (err: unknown) => {
    const e = normaliseError(err);
    // NOTE: keep this console.error: it's useful in environments without logger wiring.
    console.error('Failed to load initial data:', e);
    lastError.value = e;
    status.value = 'error';
    notify();
  };

  let readyResolve!: () => void;
  let readyReject!: (e: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  // R3-07 (S1): `ready` is public API and may legitimately never be observed (a store that is
  // built but never rendered or awaited). Without a pre-attached observer, a rejecting loader
  // becomes an `unhandledRejection` — a process-terminating crash under Node's default mode (the
  // R0-01 class). This no-op handler observes the rejection WITHOUT consuming it for real
  // consumers: `await store.ready` still rejects with the loader error.
  ready.catch(() => {});

  const settleSuccess = (value: T) => {
    handleSuccess(value);
    readyResolve();
  };

  const settleError = (err: unknown) => {
    handleError(err);
    readyReject(err);
  };

  // Initialise
  if (typeof initialDataOrPromise === 'function') {
    (initialDataOrPromise as () => Promise<T>)().then(settleSuccess).catch(settleError);
  } else if (initialDataOrPromise instanceof Promise) {
    initialDataOrPromise.then(settleSuccess).catch(settleError);
  } else {
    settleSuccess(initialDataOrPromise);
  }

  const setData = (newData: T) => {
    handleSuccess(newData);
    // If initial load previously failed/pending, treat this as ready.
    readyResolve();
  };

  const subscribe = (callback: () => void) => {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  };

  const getSnapshot = (): T | undefined => {
    return data.value;
  };

  // shallowReadonly (not readonly): the refs stay read-only at the top level but `.value`
  // yields the raw payload, so snapshots keep object identity with what was passed to
  // createSSRStore (F7). Deep readonly() proxied `.value`, breaking identity for
  // useSSRData() consumers; getSnapshot() was unaffected as it closes over the raw ref.
  return {
    data: shallowReadonly(data) as Ref<T | undefined>,
    status: shallowReadonly(status) as Ref<SSRStoreStatus>,
    lastError: shallowReadonly(lastError) as Ref<Error | undefined>,
    ready,
    getSnapshot,
    setData,
    subscribe,
  };
}

export const SSR_STORE_KEY: InjectionKey<SSRStore<any>> = Symbol('taujs:ssr-store');

/**
 * Provider component (Composition API) for parity with taujs/react's SSRStoreProvider.
 *
 * Note: Props accept SSRStore<any> for variance compatibility.
 * Type safety is maintained through the injection key when consuming.
 */
export const SSRStoreProvider = defineComponent({
  name: 'SSRStoreProvider',
  props: {
    store: {
      // Use 'any' for prop validation to accept any SSRStore<T>
      // Type safety is preserved through SSR_STORE_KEY injection
      type: Object as PropType<SSRStore<any>>,
      required: true,
    },
  },
  setup(props, { slots }) {
    provide(SSR_STORE_KEY, props.store);
    return () => slots.default?.();
  },
});

/**
 * Returns the full store. **Deliberate divergence from `@taujs/react`**, whose
 * `useSSRStore` returns the resolved *value* via `useSyncExternalStore`. Vue has no
 * equivalent value-hook idiom; returning the store lets components pick the right access
 * pattern (reactive refs, `await store.ready`, `store.getSnapshot()`), so it is intentional
 * — do not "harmonize" it with react.
 *
 * Two consumption idioms, in order of preference:
 *
 * 1. **Suspense (recommended)** — `await` the data in an async `setup` under `<Suspense>`:
 *    ```vue
 *    <script setup lang="ts">
 *    const data = await useSSRDataAsync<MyData>();
 *    </script>
 *    ```
 * 2. **Fallback rendering** — read a non-throwing computed and guard with `v-if`:
 *    ```vue
 *    <script setup lang="ts">
 *    const data = useSSRData<MyData>();
 *    </script>
 *    <template><div v-if="data">{{ data.message }}</div></template>
 *    ```
 */
export function useSSRStore<T>(): SSRStore<T> {
  const store = inject(SSR_STORE_KEY) as SSRStore<T> | undefined;
  if (!store) throw new Error('useSSRStore must be used within a SSRStoreProvider');
  return store;
}

/**
 * Convenience: a computed that yields T once ready.
 *
 * If data is still pending, it returns `undefined` (rather than throwing), so you can
 * render a fallback without forcing Suspense.
 */
export function useSSRData<T>(): ComputedRef<T | undefined> {
  const store = useSSRStore<T>();
  return computed(() => store.data.value);
}

/**
 * Returns the ready promise for awaiting in async setup.
 *
 * This is the recommended pattern for Vue SSR Suspense:
 * @example
 * ```vue
 * <script setup lang="ts">
 * await useSSRReady<MyData>();
 * const store = useSSRStore<MyData>();
 * const data = store.getSnapshot()!;
 * </script>
 * ```
 */
export function useSSRReady(): Promise<void> {
  const store = useSSRStore();
  return store.ready;
}

/**
 * Returns a computed ref of the current store status.
 *
 * @example
 * const status = useSSRStatus();
 * if (status.value === 'pending') { ... }
 */
export function useSSRStatus(): ComputedRef<SSRStoreStatus> {
  const store = useSSRStore();
  return computed(() => store.status.value);
}

/**
 * Convenience: await data and return it in one call.
 *
 * This is the simplest pattern for Vue SSR Suspense:
 * @example
 * ```vue
 * <script setup lang="ts">
 * const data = await useSSRDataAsync<MyData>();
 * </script>
 * <template>
 *   <div>{{ data.message }}</div>
 * </template>
 * ```
 */
export async function useSSRDataAsync<T>(): Promise<T> {
  const store = useSSRStore<T>();
  await store.ready;
  const data = store.getSnapshot();
  if (data === undefined) {
    throw new Error('SSR data is undefined after ready resolved');
  }
  return data;
}
