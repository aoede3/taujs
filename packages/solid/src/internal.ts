// Package-internal only. NOT re-exported from any public entry, so nothing here reaches the
// public API surface frozen in the design (`solid-renderer-design.md` 1.5).
//
// Two adapter-internal seams live here, both symbol-keyed so they stay OFF the public
// `SSRStore<T>` type (which is exactly `{ data, setData }` and nothing else):
//
//   STORE_READINESS - the streaming adapter's data-ready latch. @taujs/react carries the same
//                     seam under the same name (`react/src/internal.ts`); the PATTERN is shared,
//                     the file is not drift-guarded.
//   STORE_DETACH    - Decision B mandate M1: every terminal (abort / timeout / force-end) must
//                     release τjs-owned request state. The store's payload lives in an
//                     adapter-owned holder, and this is how the adapter nulls it.

/**
 * A `Promise<void>` that RESOLVES when route data settles - on success AND on failure alike (the
 * store records a loader rejection rather than rejecting this promise). It ALWAYS settles, so the
 * adapter can gate on it without inventing a new hang class; `setData` resolves it immediately.
 *
 * Callers read the store's committed state afterwards to decide deliver-vs-fail. Deliberately not
 * a rejecting promise: a rejecting readiness would need an observer at every await site or it
 * becomes an `unhandledRejection`, which Node's default mode turns into a process exit.
 */
export const STORE_READINESS: unique symbol = Symbol('taujs.solid.storeReadiness');

/** Adapter-owned release of the store's τjs-owned payload (M1). Idempotent. */
export const STORE_DETACH: unique symbol = Symbol('taujs.solid.storeDetach');

/** Internal read of the store's settled state, so the adapter never guesses from `data()`. */
export const STORE_STATE: unique symbol = Symbol('taujs.solid.storeState');

/**
 * RFC 0007: the request's deferred-data holder, carried on the STORE rather than in a provider of
 * its own.
 *
 * This is not a stylistic choice. Solid's `createComponent` opens a NESTED hydration context and
 * consumes a context id, so an extra provider component shifts every `createUniqueId`, resource id
 * and Suspense-fragment key in the whole subtree - a conditional one would make a `deferred`
 * route's bytes differ from a non-deferred route's for reasons unrelated to the deferred content,
 * and would make hydration depend on the client inserting exactly the same conditional wrapper.
 * Riding on the store the adapter ALREADY provides costs zero components and zero ids on both sides.
 */
export const STORE_DEFERRED: unique symbol = Symbol('taujs.solid.storeDeferred');

export type StoreState = {
  /** `pending` until the seed settles or `setData` commits. */
  status: 'pending' | 'success' | 'error';
  /** Set only when `status === 'error'`; normalised, never a raw thrown value. */
  error?: Error;
  /** True once the payload has been detached - reading `data()` afterwards throws. */
  detached: boolean;
};

export const getStoreReadiness = (store: unknown): Promise<void> | undefined =>
  (store as Record<symbol, unknown> | null | undefined)?.[STORE_READINESS] as Promise<void> | undefined;

export const getStoreState = (store: unknown): StoreState | undefined => {
  const read = (store as Record<symbol, unknown> | null | undefined)?.[STORE_STATE] as (() => StoreState) | undefined;

  return typeof read === 'function' ? read() : undefined;
};

/**
 * Attach the request's deferred holder to the store. `configurable` so the terminal can drop it.
 * `unknown` rather than the holder type: `internal.ts` must stay free of module cycles.
 */
export const attachDeferredData = (store: unknown, holder: unknown): void => {
  Object.defineProperty(store as object, STORE_DEFERRED, { value: holder, enumerable: false, configurable: true });
};

export const getDeferredData = (store: unknown): unknown => (store as Record<symbol, unknown> | null | undefined)?.[STORE_DEFERRED];

/**
 * Drop the store -> holder edge at the terminal - which is what `configurable: true` above is for.
 * Releasing the holder empties it; deleting the property also removes the store's reference to it,
 * so a deferred response's retained graph returns to a no-deferred route's. Idempotent, and safe on
 * a non-store value.
 */
export const detachDeferredData = (store: unknown): void => {
  if (store && typeof store === 'object') delete (store as Record<symbol, unknown>)[STORE_DEFERRED];
};

/** Release the store's τjs-owned payload. Safe to call repeatedly and on a non-store value. */
export const detachStore = (store: unknown): void => {
  const detach = (store as Record<symbol, unknown> | null | undefined)?.[STORE_DETACH] as (() => void) | undefined;

  if (typeof detach === 'function') detach();
};
