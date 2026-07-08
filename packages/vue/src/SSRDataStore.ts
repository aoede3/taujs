import { computed, defineComponent, inject, provide, readonly, shallowRef, type ComputedRef, type InjectionKey, type PropType, type Ref } from 'vue';

export type SSRStoreStatus = 'pending' | 'success' | 'error';

export type SSRStore<T> = {
  /** Reactive data ref for Vue components */
  data: Ref<T | undefined>;
  status: Ref<SSRStoreStatus>;
  lastError: Ref<Error | undefined>;

  /** Promise that resolves when initial data is available (or rejects on error). */
  ready: Promise<void>;

  /** Vue-safe: returns data or undefined (never throws) */
  getSnapshot: () => T | undefined;

  /** Test/imperative API: throws if pending or errored (React parity) */
  getSnapshotOrThrow: () => T;

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

  const getSnapshotOrThrow = (): T => {
    if (status.value === 'pending') throw ready;
    if (status.value === 'error') throw new Error(`SSR data fetch failed: ${lastError.value?.message || 'Unknown error'}`);
    if (data.value === undefined) throw new Error('SSR data is undefined - store initialisation problem');
    return data.value;
  };

  return {
    data: readonly(data) as Ref<T | undefined>,
    status: readonly(status) as Ref<SSRStoreStatus>,
    lastError: readonly(lastError) as Ref<Error | undefined>,
    ready,
    getSnapshot,
    getSnapshotOrThrow,
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
 * Returns the full store (recommended for Vue).
 * Components can `await store.ready` in async setup, or watch store.status/data.
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
export function useSSRReady<T = any>(): Promise<void> {
  const store = useSSRStore<T>();
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

/**
 * CLIENT-SIDE ONLY: Returns data or throws promise (for client Suspense).
 *
 * ⚠️ WARNING: This does NOT work reliably with Vue SSR Suspense.
 * Vue's SSR Suspense requires async setup with await, not thrown promises.
 * Use `useSSRDataAsync()` or `await useSSRReady()` for SSR-compatible Suspense.
 *
 * This is kept for React parity and client-side only Suspense use cases.
 */
export function useSSRDataOrSuspend<T>(): T {
  const store = useSSRStore<T>();
  return store.getSnapshotOrThrow(); // throws promise => client Suspense only
}
