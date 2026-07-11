// Package-internal only. NOT re-exported from `index.ts`, so nothing here reaches the public API.
//
// R1-01 (design 1 / decisions item 10): the streaming end-gate needs to know when route data has
// settled, WITHOUT adding a public `ready` surface to `SSRStore` (that decision belongs to R3-03).
// `createSSRStore` attaches its internal `serverDataPromise` under this symbol; the renderer reads
// it via `getStoreReadiness`. The symbol is not part of the `SSRStore<T>` type, so consumers never
// see it.
export const STORE_READINESS: unique symbol = Symbol('taujs.storeReadiness');

/**
 * The store's readiness: a `Promise<void>` that RESOLVES when the route data settles — on success
 * AND on error alike (the store swallows the fetch error into `status: 'error'`). Callers race this
 * against a data-timeout watchdog and then read `store.status` to decide deliver-vs-fail.
 */
export const getStoreReadiness = (store: unknown): Promise<void> | undefined =>
  (store as Record<symbol, unknown>)?.[STORE_READINESS] as Promise<void> | undefined;
