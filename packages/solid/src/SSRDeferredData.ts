import { createResource, sharedConfig } from 'solid-js';

import { useSSRStore } from './SSRDataStore.js';
import { getDeferredData } from './internal.js';

import type { Accessor } from 'solid-js';

/**
 * RFC 0007 - the @taujs/solid deferred-data adapter. The point of this module is how LITTLE it
 * does: Solid already owns every mechanism the RFC asks a renderer for.
 *
 *  - `createResource` maps a promise onto a `<Suspense>` boundary and suspends THAT boundary only;
 *  - `renderToStream` emits its own `<template>` + `$df(...)` patch scripts for the late fragment,
 *    and its own serialised payload for hydration - τjs writes none of those bytes;
 *  - the client `createResource` reads that payload through Solid's own hydration context and never
 *    calls the fetcher, so hydration re-executes no loader by construction;
 *  - a rejected resource reaches the application's `<ErrorBoundary>` on the SERVER (decision 13:
 *    Solid's engine has real server-side error boundaries, so the throwing read is Solid's
 *    server-completing consumed-rejection path and no result accessor is needed) and crosses the
 *    wire through the package's non-disableable error sanitiser, so no server detail travels.
 *
 * So the adapter is a store-carried holder that turns a host promise into a Solid resource, plus
 * the ONE case Solid cannot express on its own: an entry still pending when the response terminated
 * (`aborted`). Solid's serialised slot for such a key is a promise that will never settle, so a
 * hydrating client would sit in its fallback forever; the envelope is what makes that deterministic.
 *
 * NO MEMOISATION, deliberately. A Solid `<Suspense>` re-runs its children when a resource settles,
 * with the hydration id counter reset, so a τjs-side per-key cache would consume a context id on
 * the FIRST pass and none on the second - shifting every id allocated after it and breaking
 * hydration for unrelated application resources. Calling `createResource` on every read keeps id
 * consumption identical in every pass and on the client; Solid itself dedupes by context id and
 * skips the fetcher once data is present, so "start once" is Solid's guarantee, not a cache of ours.
 *
 * EXPORT HYGIENE (renderer contract item 9 / decision 10): only `createDeferredAccessor`,
 * `useDeferredData`, `DeferredDataError` and the `DeferredAccessor` type reach `index.ts`.
 */

/** @internal The host's internal transport (`RenderOptions.deferredData`), structurally re-stated. */
export type DeferredDataRegistry = Readonly<Record<string, Promise<Record<string, unknown>>>>;

/** @internal RFC 0007 (R4): the only three v1 outcomes. `failed` carries NO message, stack or detail. */
export type DeferredOutcome = { status: 'complete'; value: Record<string, unknown> } | { status: 'failed' } | { status: 'aborted' };

/** @internal */
export type DeferredHydrationState = Readonly<Record<string, DeferredOutcome>>;

/** @internal The private, UNDOCUMENTED envelope carrier the host attaches at end of stream. */
export const DEFERRED_STATE_CARRIER = '__TAUJS_DEFERRED_STATE__';

/**
 * The terminal for a `failed` or `aborted` entry. It names the KEY and the OUTCOME and nothing
 * else - the key is route configuration already visible in the application's own source, so no
 * server value, message, stack or cause is constructible from it.
 */
export class DeferredDataError extends Error {
  readonly key: string;
  readonly outcome: 'failed' | 'aborted';

  constructor(key: string, outcome: 'failed' | 'aborted') {
    super(
      outcome === 'aborted' ? `taujs: deferred data "${key}" was abandoned when the response terminated` : `taujs: deferred data "${key}" failed on the server`,
    );
    this.name = 'DeferredDataError';
    this.key = key;
    this.outcome = outcome;
  }
}

/**
 * `T | undefined`, matching Solid's own `Resource<T>` exactly.
 *
 * Solid does NOT skip a suspended boundary's body: it runs once with the accessor returning
 * `undefined` (that is how the resource registers with the enclosing `<Suspense>`) and again when
 * the resource settles. Only the second pass reaches the wire, so the DELIVERED html always carries
 * the value - but the application must still write `reviews()?.count` or `<Show when={reviews()}>`,
 * exactly as for any other Solid resource. Typing this `Accessor<T>` would be a lie about the first
 * pass.
 */
export type DeferredAccessor<T> = Accessor<T | undefined>;

/** @internal */
export type DeferredDataHolder = {
  /** The declared key set for THIS request. Authoritative; an unknown read is a developer error. */
  readonly keys: readonly string[];
  /** Map a declared key onto a Solid accessor. Suspends the reading boundary only. */
  read<T>(key: string): DeferredAccessor<T>;
  /**
   * The response-level deferred deadline (decision 18). A LATCH, not a one-shot sweep:
   *
   *  1. every consumed entry that has not settled is abandoned NOW, by rejecting the ADAPTER'S OWN
   *     wrapper, so Solid errors those boundaries through its native channel and finishes the
   *     document itself;
   *  2. the holder stays expired, so a boundary whose FIRST read happens after the deadline is born
   *     abandoned rather than starting a fresh, unbounded wait.
   *
   * Without (2) the deadline would be a hint: a late-registering consumer is invisible to the timer.
   * The host's response-owned promise is NOT touched in either case - it stays pending, the host
   * classifies it `aborted` at its write site, and the service still observes the request signal.
   * Returns how many were abandoned by (1).
   */
  expire(): number;
  /** Release every reference this holder owns. Idempotent; runs on every terminal. */
  release(): void;
};

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

const unknownKey = (key: string, keys: readonly string[]): Error =>
  new Error(`taujs: unknown deferred data key ${JSON.stringify(key)}. This route declares [${keys.map((k) => JSON.stringify(k)).join(', ')}].`);

const releasedError = (key: string): Error =>
  new Error(`taujs: deferred data ${JSON.stringify(key)} was read after the response terminal; the holder has been released.`);

/**
 * @internal SERVER holder. The registry is RESPONSE-OWNED: the promises are already started and
 * already pre-observed by the host, so nothing here starts, restarts, memoises or decorates them.
 */
export function createDeferredHolder(source: DeferredDataRegistry, onAbandon?: (keys: readonly string[]) => void): DeferredDataHolder {
  const keys = Object.freeze(Object.keys(source));
  const pending = new Set<string>();
  const wrappers = new Map<string, { promise: Promise<Record<string, unknown>>; abandon: (reason: unknown) => void }>();
  // The ONLY reference this adapter keeps to the response-owned registry, dropped at the terminal.
  let registry: DeferredDataRegistry | undefined = source;
  let released = false;
  let expired = false;

  /**
   * The adapter's own promise per key, created lazily on first read. It DELEGATES to the
   * response-owned promise and never mutates or replaces it - but because the adapter owns this
   * one, the deadline can settle it, which is the whole mechanism behind `expire()`. Memoising the
   * WRAPPER is safe (it consumes no hydration context id); memoising the RESOURCE would not be.
   */
  const wrapper = (key: string): Promise<Record<string, unknown>> => {
    const existing = wrappers.get(key);
    if (existing) return existing.promise;

    if (expired) {
      // The deadline already passed: abandon immediately and tell the renderer, rather than
      // starting a fresh unbounded wait on a document it is still holding open.
      const promise = Promise.reject(new DeferredDataError(key, 'aborted')) as Promise<Record<string, unknown>>;
      promise.catch(() => {}); // pre-observed: Solid may never consume this rejection
      wrappers.set(key, { promise, abandon: () => {} });
      onAbandon?.([key]);

      return promise;
    }

    let abandon!: (reason: unknown) => void;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      abandon = reject;
      registry![key]!.then(
        (value) => {
          pending.delete(key);
          resolve(value);
        },
        (reason) => {
          pending.delete(key);
          reject(reason);
        },
      );
    });
    promise.catch(() => {}); // pre-observed: an abandoned wrapper must never be an unhandledRejection

    pending.add(key);
    wrappers.set(key, { promise, abandon });

    return promise;
  };

  return {
    keys,

    read<T>(key: string): DeferredAccessor<T> {
      if (released) throw releasedError(key);
      if (!registry || !hasOwn(registry, key)) throw unknownKey(key, keys);

      const [read] = createResource(() => wrapper(key));

      return read as unknown as DeferredAccessor<T>;
    },

    expire() {
      expired = true;

      const abandoned = [...pending];
      for (const key of abandoned) {
        pending.delete(key);
        wrappers.get(key)?.abandon(new DeferredDataError(key, 'aborted'));
      }
      if (abandoned.length > 0) onAbandon?.(abandoned);

      return abandoned.length;
    },

    release() {
      released = true;
      registry = undefined;
      pending.clear();
      wrappers.clear();
    },
  };
}

/**
 * @internal CLIENT holder, built from the envelope read synchronously at bootstrap.
 *
 * `complete` and `failed` are deliberately routed back through `createResource` rather than
 * short-circuited: during hydration Solid finds its own serialised slot and uses it WITHOUT calling
 * the fetcher, which is the native zero-refetch path. The fetcher below is the fallback for a
 * boundary Solid never serialised, and it too is refetch-free - it resolves from the envelope value
 * already in memory.
 *
 * `aborted` is the one case that must NOT reach Solid's slot: the server terminated with that
 * promise still pending, so the slot holds a promise nothing will ever settle and the boundary
 * would stay in its fallback forever. The context id is consumed anyway (so every later hydration
 * id still lines up with the server's walk) and the read throws into the app's `<ErrorBoundary>`.
 */
export function createHydrationHolder(source: DeferredHydrationState): DeferredDataHolder {
  const keys = Object.freeze(Object.keys(source));
  let envelope: DeferredHydrationState | undefined = source;
  let released = false;

  return {
    keys,

    read<T>(key: string): DeferredAccessor<T> {
      // The released check comes FIRST: `keys` is frozen at construction while `envelope` is
      // dropped by `release()`, so falling through to `unknownKey` would contradict itself.
      if (released) throw releasedError(key);
      if (!envelope || !hasOwn(envelope, key)) throw unknownKey(key, keys);

      const outcome = envelope[key]!;

      if (outcome.status === 'aborted') {
        // Burn the context id the SERVER's `createResource` consumed at this position; skipping it
        // would shift every subsequent id and break hydration for unrelated application resources.
        if (sharedConfig.context) sharedConfig.getNextContextId();

        return (() => {
          throw new DeferredDataError(key, 'aborted');
        }) as DeferredAccessor<T>;
      }

      const [read] = createResource<Record<string, unknown>>(() =>
        outcome.status === 'complete' ? Promise.resolve(outcome.value) : Promise.reject(new DeferredDataError(key, 'failed')),
      );

      return read as unknown as DeferredAccessor<T>;
    },

    // No request lifecycle to bound on the client: the outcomes are already terminal.
    expire: () => 0,

    release() {
      released = true;
      envelope = undefined;
    },
  };
}

/**
 * Read a declared deferred entry. ONE component, both sides - it never learns which side it is on.
 *
 * Reading a pending entry suspends the nearest `<Suspense>` and nothing else; a rejected entry
 * throws into the nearest `<ErrorBoundary>`, on the SERVER and on the client alike. PLACEMENT
 * MATTERS: the `<ErrorBoundary>` must sit INSIDE the `<Suspense>`; outside it the response still
 * completes and the rejection is still redacted, but the fallback renders on the client.
 */
export function useDeferredData<T>(key: string): DeferredAccessor<T> {
  const holder = getDeferredData(useSSRStore()) as DeferredDataHolder | undefined;

  if (!holder) {
    throw new Error(`taujs: useDeferredData(${JSON.stringify(key)}) requires a route declaring \`attr.deferred\`, rendered by the τjs Solid renderer`);
  }

  return holder.read<T>(key);
}

/**
 * The TYPED façade: `createDeferredAccessor<DeferredDataOf<typeof route>>()`.
 *
 * A factory rather than `useDeferredData<D>('reviews')` because TypeScript cannot infer one type
 * argument while another is supplied explicitly - a two-parameter hook collapses the return type to
 * a union over every declared key. The factory fixes `D` once and infers `K` from the argument.
 */
export function createDeferredAccessor<D>() {
  return <K extends keyof D & string>(key: K): DeferredAccessor<D[K]> => useDeferredData<D[K]>(key);
}

/**
 * @internal Read the private envelope ONCE and drop the carrier.
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
