import React, { createContext, use, useContext } from 'react';

/**
 * RFC 0007 - the @taujs/react deferred-data adapter: the smallest projection of a named host
 * promise into React's own `use()` + `<Suspense>` model.
 *
 *  - SERVER: `opts.deferredData` (the host's request-local registry) becomes one tracked thenable
 *    per CONSUMED key. Reading suspends only the reading boundary, and React's OWN streaming and
 *    patch mechanism delivers the late HTML - τjs emits no framework-patch bytes.
 *  - CLIENT: each consumed boundary is seeded from the private end-of-stream envelope, read
 *    synchronously in document order by the bootstrap, so hydration re-executes no loader and
 *    issues no refetch. Every seeded entry is ALREADY SETTLED, so `use()` returns (or throws)
 *    synchronously - no suspension, no second render pass.
 *
 * Host contract this adapter consumes and never re-implements: entries are already started and
 * already pre-observed; a resolved entry is the host's settlement snapshot (parsed JSON, sharing no
 * identity with the loader's object); a value that could not be snapshotted arrives as a
 * detail-free rejection, indistinguishable from any other rejected entry.
 *
 * EXPORT HYGIENE (renderer contract item 9 / decision 10): only `createDeferredAccessor`,
 * `useDeferredData`, `useDeferredDataResult`, `DeferredDataError` and the `DeferredResult` type
 * reach `index.ts`. The carrier constant, both holders, the provider and the hydration reader are
 * private transport - module-exported for `SSRRender`/`SSRHydration` and the package's own tests,
 * never from the package root.
 */

/** @internal The host's internal transport (`RenderOptions.deferredData`), structurally re-stated. */
export type DeferredDataRegistry = Readonly<Record<string, Promise<Record<string, unknown>>>>;

/** @internal RFC 0007 (R4): the only three v1 outcomes. `failed` carries NO message, stack or detail. */
export type DeferredOutcome = { status: 'complete'; value: Record<string, unknown> } | { status: 'failed' } | { status: 'aborted' };

/** @internal */
export type DeferredHydrationState = Readonly<Record<string, DeferredOutcome>>;

/**
 * @internal The private, UNDOCUMENTED envelope carrier the host attaches at its existing
 * end-of-stream write site. Applications must never read it: it is not exported from the package
 * root, and the bootstrap reads it once and deletes it.
 */
export const DEFERRED_STATE_CARRIER = '__TAUJS_DEFERRED_STATE__';

/**
 * The terminal error for a boundary whose value never arrived, thrown by the THROWING accessor.
 *
 * Both non-complete outcomes reject, and the two are distinguishable by `outcome` so an application
 * can render "unavailable" differently from "failed" without ever seeing server detail. Nothing
 * here carries a server message, stack or cause - `key` is route CONFIGURATION, already visible in
 * the application's own source.
 */
export class DeferredDataError extends Error {
  readonly key: string;
  readonly outcome: 'failed' | 'aborted';

  constructor(key: string, outcome: 'failed' | 'aborted') {
    super(`taujs: deferred data "${key}" did not arrive (${outcome})`);
    this.name = 'DeferredDataError';
    this.key = key;
    this.outcome = outcome;
  }
}

/** The typed, per-key result an application branches on - structurally the envelope's own shape. */
export type DeferredResult<T extends Record<string, unknown> = Record<string, unknown>> =
  { status: 'complete'; value: T } | { status: 'failed' } | { status: 'aborted' };

/**
 * React's `use()` thenable protocol: a thenable carrying `status`/`value`/`reason` is consumed
 * SYNCHRONOUSLY when already settled, and suspends only while `status === 'pending'`. This is the
 * shape React itself produces for cached/streamed promises, and it is what makes a hydration read
 * of an already-complete outcome a zero-suspense, zero-mismatch read.
 */
type TrackedThenable = PromiseLike<Record<string, unknown>> & {
  status: 'pending' | 'fulfilled' | 'rejected';
  value?: Record<string, unknown>;
  reason?: unknown;
};

const unknownKeyError = (key: string, keys: readonly string[]): Error =>
  new Error(
    `taujs: unknown deferred data key "${key}". This route declares [${keys.map((k) => `"${k}"`).join(', ')}]. ` +
      "Declared keys come from the route's `attr.deferred` record; the host does not validate reads.",
  );

const releasedError = (key: string): Error => new Error(`taujs: deferred data "${key}" was read after the response terminal; the holder has been released.`);

const ownKey = (source: object, key: string): boolean => Object.prototype.hasOwnProperty.call(source, key);

/**
 * Track a HOST-owned promise without mutating it: the registry is response-owned and frozen by
 * contract, so React's bookkeeping lives on our own wrapper, which only DELEGATES `then`. The
 * status handlers are attached HERE, before React attaches its retry ping, so the status is always
 * current by the time React re-reads it.
 */
const track = (promise: PromiseLike<Record<string, unknown>>): TrackedThenable => {
  const tracked: TrackedThenable = { status: 'pending', then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected) };

  void promise.then(
    (value) => {
      if (tracked.status !== 'pending') return;
      tracked.status = 'fulfilled';
      tracked.value = value;
    },
    (reason) => {
      if (tracked.status !== 'pending') return;
      tracked.status = 'rejected';
      tracked.reason = reason;
    },
  );

  return tracked;
};

/** An ALREADY-SETTLED thenable we own outright: client seeding, and post-deadline server reads. */
const settled = (outcome: DeferredOutcome, key: string): TrackedThenable => {
  if (outcome.status === 'complete') {
    const promise = Promise.resolve(outcome.value);

    return { status: 'fulfilled', value: outcome.value, then: (f, r) => promise.then(f, r) };
  }

  const reason = new DeferredDataError(key, outcome.status);
  const promise = Promise.reject(reason);
  promise.catch(() => {}); // pre-observed: a boundary that is never rendered must stay harmless

  return { status: 'rejected', reason, then: (f, r) => promise.then(f, r) };
};

/**
 * @internal The per-request (server) / per-root (client) holder. `resource()` is a RENDER-PHASE
 * read returning the tracked thenable `use()` consumes, so the suspension is React's, not ours.
 */
export type DeferredHolder = {
  readonly keys: readonly string[];
  // A bare `PromiseLike`: React's `use()` overloads discriminate on a literal `status`, so the
  // tracked shape stays module-internal and is re-narrowed at the one site that reads it.
  resource: (key: string) => PromiseLike<Record<string, unknown>>;
  /**
   * The response-level deferred deadline (decision 18). LATCHES, so a read registering afterwards
   * is born `aborted` rather than starting a fresh unbounded wait, and returns how many CONSUMED
   * entries were still pending - the renderer abandons those through React's own `stream.abort`.
   */
  expire: () => number;
  /** Terminal: drop every retained value, promise and source reference. Idempotent. */
  release: () => void;
};

const createHolder = (keys: readonly string[], make: (key: string) => TrackedThenable, guard: (key: string) => void, onRelease: () => void): DeferredHolder => {
  const entries = new Map<string, TrackedThenable>();
  let released = false;
  let expired = false;

  return {
    keys,

    resource(key: string) {
      const existing = entries.get(key);
      if (existing) return existing;
      if (released) throw releasedError(key);
      guard(key);

      const entry = expired ? settled({ status: 'aborted' }, key) : make(key);
      entries.set(key, entry);

      return entry;
    },

    expire() {
      expired = true;
      let pending = 0;
      for (const entry of entries.values()) if (entry.status === 'pending') pending += 1;

      return pending;
    },

    release() {
      released = true;
      entries.clear();
      onRelease();
    },
  };
};

/**
 * @internal SERVER holder over the host's registry (renderer contract items 1, 7, 8).
 *
 * Entries are tracked LAZILY, on first read, so an unconsumed key is never observed here and never
 * counts towards the deadline - the host has already pre-observed every promise, so an unconsumed
 * rejection stays harmless.
 */
export const createDeferredHolder = (registry: DeferredDataRegistry): DeferredHolder => {
  let source: DeferredDataRegistry | undefined = registry;
  const keys = Object.freeze(Object.keys(registry));

  return createHolder(
    keys,
    (key) => track(source![key]!),
    (key) => {
      if (!source) throw releasedError(key);
      if (!ownKey(source, key)) throw unknownKeyError(key, keys);
    },
    () => {
      source = undefined;
    },
  );
};

/** @internal CLIENT holder over the private envelope. Every entry is already settled at creation. */
export const createHydrationHolder = (state: DeferredHydrationState): DeferredHolder => {
  const keys = Object.freeze(Object.keys(state));

  return createHolder(
    keys,
    (key) => settled(state[key]!, key),
    (key) => {
      if (!ownKey(state, key)) throw unknownKeyError(key, keys);
    },
    () => {},
  );
};

const DeferredDataContext = createContext<DeferredHolder | null>(null);

/** @internal Wiring, never an application surface (decision 10). */
export const DeferredDataProvider = ({ holder, children }: React.PropsWithChildren<{ holder: DeferredHolder }>) => (
  <DeferredDataContext.Provider value={holder}>{children}</DeferredDataContext.Provider>
);

const holderOrThrow = (accessor: string, key: string): DeferredHolder => {
  const holder = useContext(DeferredDataContext);
  if (!holder) {
    throw new Error(
      `taujs: ${accessor}("${key}") was called outside a deferred-data provider. ` +
        "Only a `render: 'streaming'` route that declares `attr.deferred` provides one.",
    );
  }

  return holder;
};

/**
 * THROWING read. Suspends the nearest `<Suspense>` while the entry is pending and throws into the
 * nearest error boundary when it failed or was aborted. An unknown key is a deterministic DEVELOPER
 * error naming the declared set - never a suspended boundary and never `undefined`.
 *
 * `react-dom/server` (Fizz) has NO server-side error boundaries: a rejected read errors the nearest
 * `<Suspense>`, which React hands to the client to render. That is React's native model, and it is
 * why {@link useDeferredDataResult} - not this read - is the path that completes the RESPONSE with
 * a handled fallback (decision 13).
 */
export function useDeferredData<T extends Record<string, unknown> = Record<string, unknown>>(key: string): T {
  return use(holderOrThrow('useDeferredData', key).resource(key)) as T;
}

/**
 * RESULT read - React's server-completing consumed-rejection path (decision 13).
 *
 * It still SUSPENDS natively while the entry is pending, then returns the outcome as a value, so an
 * application renders a handled fallback INTO the streamed document. `failed` and `aborted` carry
 * no value, message, stack or cause.
 */
export function useDeferredDataResult<T extends Record<string, unknown> = Record<string, unknown>>(key: string): DeferredResult<T> {
  // Read the tracked status FIRST rather than try/catching `use()`: React signals a suspension by
  // throwing an unexported internal sentinel, so a catch-based version would have to guess at
  // React's control flow. A still-pending entry falls through to `use()` and suspends natively;
  // React retries once it settles, and this same check then sees the rejection.
  const resource = holderOrThrow('useDeferredDataResult', key).resource(key) as TrackedThenable;

  if (resource.status === 'rejected') return { status: resource.reason instanceof DeferredDataError ? resource.reason.outcome : 'failed' };

  return { status: 'complete', value: use(resource as PromiseLike<T>) as T };
}

/**
 * The typed component-facing façade. `D` comes from the route config
 * (`DeferredDataOf<typeof route>`), so the key is checked and the payload type DERIVED - an
 * application never re-declares a payload shape:
 *
 * ```ts
 * const useDeferred = createDeferredAccessor<DeferredDataOf<typeof productRoute>>();
 * const reviews = useDeferred('reviews'); // typed from the route's serviceData() brand
 * ```
 *
 * A factory rather than a two-type-parameter hook on purpose: TypeScript cannot infer one type
 * argument while another is supplied explicitly, so `useDeferredData<D>('reviews')` would collapse
 * the return to a union over every declared key.
 */
export function createDeferredAccessor<D>() {
  return function useDeferred<K extends keyof D & string>(key: K): D[K] {
    return useDeferredData(key) as D[K];
  };
}

/**
 * @internal Read the private envelope ONCE, synchronously, in document order, and drop the carrier.
 *
 * An ABSENT carrier is the ordinary case - a route that declared nothing, and (decision 8)
 * `hydrate: false` - never an error and never a reason to fetch.
 */
export const takeDeferredHydrationState = (): DeferredHydrationState | undefined => {
  try {
    const w = window as unknown as Record<string, unknown>;
    const raw = w[DEFERRED_STATE_CARRIER];
    delete w[DEFERRED_STATE_CARRIER];

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

    return raw as DeferredHydrationState;
  } catch {
    // A hostile or absent global must never break bootstrap.
    return undefined;
  }
};
