import { inject, type InjectionKey } from 'vue';

/**
 * RFC 0007 - the @taujs/vue deferred-data adapter: the smallest projection of a named host promise
 * into Vue's own async-`setup()` model.
 *
 *  - SERVER: `opts.deferredData` (the host's request-local registry) becomes one awaitable entry
 *    per CONSUMED key. `@vue/server-renderer` does the suspending and delivers the resolved HTML
 *    through its OWN streaming mechanism - τjs writes no bytes of its own for it.
 *  - CLIENT: each consumed boundary is seeded from the private end-of-stream envelope, read at the
 *    same rendezvous `hydrateApp` already uses for `window.__INITIAL_DATA__`, so hydration
 *    re-executes no loader and issues no refetch.
 *
 * VUE GROUND TRUTH the design rests on:
 *
 *  1. `@vue/server-renderer` streams STRICTLY IN ORDER - an awaiting boundary holds every byte that
 *     follows it in document order, and Vue SSR has no patch or instruction protocol at all. Under
 *     decision 12 that is Vue's ordering class, not a contract shortfall. AUTHORING CONSEQUENCE:
 *     place a deferred boundary AFTER the independent content that should stream immediately.
 *  2. Vue SSR renders each subtree exactly once, so a boundary that catches an error has already
 *     emitted its markup and only an empty node reaches the client. A caught error therefore cannot
 *     substitute fallback UI into the response - which is why the detail-free RESULT read is Vue's
 *     server-completing consumed-rejection path (decision 13) and the throwing read is a
 *     renderer-native secondary.
 *
 * EXPORT HYGIENE (renderer contract item 9 / decision 10): only `createDeferredAccessor`,
 * `useDeferredData`, `useDeferredDataResult`, `DeferredDataError` and the `DeferredResult` type
 * reach `index.ts`. The carrier constant, both holders, the injection key, the provider and the
 * hydration reader are private transport and stay unexported from the package root.
 */

/** @internal The host's internal transport (`RenderOptions.deferredData`), structurally re-stated. */
export type DeferredDataRegistry = Readonly<Record<string, Promise<Record<string, unknown>>>>;

/** @internal RFC 0007 (R4): the only three v1 outcomes. `failed` carries NO message, stack or detail. */
export type DeferredOutcome = { status: 'complete'; value: Record<string, unknown> } | { status: 'failed' } | { status: 'aborted' };

/** @internal */
export type DeferredHydrationState = Readonly<Record<string, DeferredOutcome>>;

/** The typed, per-key result an application branches on - structurally the envelope's own shape. */
export type DeferredResult<T = Record<string, unknown>> = { status: 'complete'; value: T } | { status: 'failed' } | { status: 'aborted' };

/**
 * @internal The private, UNDOCUMENTED envelope carrier the host attaches at its existing
 * end-of-stream write site, and only when the host-resolved hydration policy is on (decision 8).
 */
export const DEFERRED_STATE_CARRIER = '__TAUJS_DEFERRED_STATE__';

/**
 * The terminal error for a boundary whose value never arrived, rejected by the THROWING accessor.
 * `key` is route CONFIGURATION, already visible in the application's own source; nothing here
 * carries a server message, stack or cause.
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

const unknownKeyError = (key: string, keys: readonly string[]): Error =>
  new Error(
    `taujs: unknown deferred data key "${key}". This route declares [${keys.map((k) => `"${k}"`).join(', ')}]. ` +
      "Declared keys come from the route's `attr.deferred` record; the host does not validate reads.",
  );

const releasedError = (key: string): Error => new Error(`taujs: deferred data "${key}" was read after the response terminal; the holder has been released.`);

const ownKey = (source: object, key: string): boolean => Object.prototype.hasOwnProperty.call(source, key);

/**
 * One consumed entry. Its promise NEVER rejects - it always settles with an outcome, which is what
 * lets the deadline and the terminal settle a still-pending read WITHOUT touching the host's
 * response-owned promise, and what makes an unobserved read incapable of raising
 * `unhandledRejection`.
 *
 * `reason` is retained on the SERVER only, for the throwing read: it is whatever the host's
 * registry promise rejected with, so a server-side `onErrorCaptured` / `app.config.errorHandler`
 * observer sees what any other server error would give it. It never crosses to the client - the
 * client holder is built from the detail-free envelope.
 */
type Settled = { result: DeferredResult; reason?: unknown };

type Entry = { settled: Promise<Settled>; settle: (s: Settled) => void; pending: () => boolean };

const createEntry = (): Entry => {
  let pending = true;
  let resolve!: (s: Settled) => void;
  const settled = new Promise<Settled>((r) => (resolve = r));

  return {
    settled,
    settle(s: Settled) {
      if (!pending) return;
      pending = false;
      resolve(s);
    },
    pending: () => pending,
  };
};

/**
 * @internal The per-request (server) / per-root (client) holder. `resource()` and `result()` are
 * SETUP-PHASE reads returning promises: an async `setup()` awaits one and Vue's own renderer does
 * the suspending. The holder never renders, never writes bytes and never starts work.
 */
export type DeferredHolder = {
  readonly keys: readonly string[];
  /** Throwing read: rejects with the loader error (server) / `DeferredDataError` (client). */
  resource: (key: string) => Promise<Record<string, unknown>>;
  /** Result read: never rejects for a declared key; yields the detail-free outcome. */
  result: (key: string) => Promise<DeferredResult>;
  /**
   * The response-level deferred deadline (decision 18). Settles every still-pending CONSUMED read
   * as `aborted` so the in-order stream can finish with the application's own `aborted` branch
   * rendered INTO the response, and LATCHES - a read registering afterwards is born `aborted`
   * rather than starting a fresh unbounded wait. Returns how many were abandoned.
   */
  expire: () => number;
  /** Terminal: abandon anything pending, then drop every retained value and source reference. */
  release: () => void;
};

const createHolder = (keys: readonly string[], make: (key: string) => Entry, guard: (key: string) => void, onRelease: () => void): DeferredHolder => {
  const entries = new Map<string, Entry>();
  let released = false;
  let expired = false;

  const entryFor = (key: string): Entry => {
    const existing = entries.get(key);
    if (existing) return existing;
    if (released) throw releasedError(key);
    guard(key);

    const entry = expired ? createEntry() : make(key);
    if (expired) entry.settle({ result: { status: 'aborted' } });
    entries.set(key, entry);

    return entry;
  };

  const abandonPending = (): number => {
    let abandoned = 0;
    for (const entry of entries.values()) {
      if (!entry.pending()) continue;
      entry.settle({ result: { status: 'aborted' } });
      abandoned += 1;
    }

    return abandoned;
  };

  return {
    keys,

    resource(key: string) {
      return entryFor(key).settled.then((s) => {
        if (s.result.status === 'complete') return s.result.value as Record<string, unknown>;
        throw s.reason !== undefined ? s.reason : new DeferredDataError(key, s.result.status);
      });
    },

    result: (key: string) => entryFor(key).settled.then((s) => s.result),

    expire() {
      expired = true;

      return abandonPending();
    },

    release() {
      if (released) return;
      // Settle FIRST: a still-awaiting `unrollBuffer` must be released before references are
      // dropped, or the render pipeline waits on a promise nothing will ever settle.
      abandonPending();
      released = true;
      entries.clear();
      onRelease();
    },
  };
};

/**
 * @internal SERVER holder over the host's registry (renderer contract items 1, 7, 8).
 *
 * Entries are tracked LAZILY, on first read, so an UNCONSUMED key is never observed here and never
 * counts towards the deadline - the host has already pre-observed every promise, so an unconsumed
 * rejection stays harmless. The host's promises are never mutated or decorated.
 */
export const createDeferredHolder = (registry: DeferredDataRegistry): DeferredHolder => {
  let source: DeferredDataRegistry | undefined = registry;
  const keys = Object.freeze(Object.keys(registry));

  return createHolder(
    keys,
    (key) => {
      const entry = createEntry();
      void source![key]!.then(
        (value) => entry.settle({ result: { status: 'complete', value } }),
        (reason) => entry.settle({ result: { status: 'failed' }, reason }),
      );

      return entry;
    },
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
    (key) => {
      const entry = createEntry();
      // No `reason`: server error detail never crosses the envelope.
      entry.settle({ result: state[key] as DeferredResult });

      return entry;
    },
    (key) => {
      if (!ownKey(state, key)) throw unknownKeyError(key, keys);
    },
    () => {},
  );
};

/** @internal */
export const DEFERRED_DATA_KEY: InjectionKey<DeferredHolder> = Symbol('taujs:deferred-data');

/**
 * @internal APP-LEVEL provide, not a wrapper component, and applied ONLY when a registry (server)
 * or an envelope (client) exists.
 *
 * This is not a style choice: a Vue provider component renders `slots.default?.()` as an ARRAY,
 * which `@vue/server-renderer` renders as a Fragment bracketed by `<!--[-->`/`<!--]-->` anchors, so
 * wrapping the tree would measurably change the bytes of a route that merely DECLARES deferred
 * entries. `app.provide()` adds no node and no markup at all.
 */
export const provideDeferredHolder = (
  app: { provide: (key: InjectionKey<DeferredHolder>, value: DeferredHolder) => unknown },
  holder: DeferredHolder,
): void => {
  app.provide(DEFERRED_DATA_KEY, holder);
};

const holderOrThrow = (accessor: string, key: string): DeferredHolder => {
  const holder = inject(DEFERRED_DATA_KEY, undefined);
  if (!holder) {
    throw new Error(
      `taujs: ${accessor}("${key}") was called outside a deferred-data provider. ` +
        "Only a `render: 'streaming'` route that declares `attr.deferred` provides one.",
    );
  }

  return holder;
};

/**
 * Returns the deferred value, or rejects through Vue's native error channel
 * (`onErrorCaptured`, then `app.config.errorHandler`).
 *
 * Streamed SSR caveat: Vue renders each server subtree once, so a captured rejection cannot
 * replace markup that has already been emitted. If this read reaches its deadline after the
 * response begins, the response ends before `__INITIAL_DATA__`, the deferred envelope, the
 * bootstrap script and the terminal event are written, so the page cannot hydrate.
 *
 * Use {@link useDeferredDataResult} for entries that may fail. It resolves to a complete,
 * failed or aborted result and allows the response to finish normally.
 *
 * Call synchronously in `setup()` before the first `await`, because it uses injection.
 */
export function useDeferredData<T extends Record<string, unknown> = Record<string, unknown>>(key: string): Promise<T> {
  return holderOrThrow('useDeferredData', key).resource(key) as Promise<T>;
}

/**
 * Returns the deferred outcome. This is the read to prefer in Vue: the promise never rejects for
 * a declared key, so the application branches on `complete`, `failed` or `aborted` and renders
 * the branch it chooses.
 *
 * Because a handled failure renders as ordinary markup, the response finishes normally and server
 * and client render the identical branch from the identical outcome. `failed` and `aborted` carry
 * no value, message, stack or cause.
 *
 * Call synchronously in `setup()` before the first `await`, because it uses injection.
 */
export function useDeferredDataResult<T extends Record<string, unknown> = Record<string, unknown>>(key: string): Promise<DeferredResult<T>> {
  return holderOrThrow('useDeferredDataResult', key).result(key) as Promise<DeferredResult<T>>;
}

/**
 * The typed component-facing façade. `D` comes from the route config
 * (`DeferredDataOf<typeof route>`), so the key is checked and the payload type DERIVED:
 *
 * ```ts
 * const deferred = createDeferredAccessor<DeferredDataOf<typeof productRoute>>();
 * const outcome = await deferred.result('reviews'); // DeferredResult<{ count: number }>
 * const value = await deferred.data('reviews'); // { count: number }, rejects on failure
 * ```
 *
 * A factory rather than a two-type-parameter function on purpose: TypeScript cannot infer one type
 * argument while another is supplied explicitly, so a two-parameter read would collapse the return
 * type to a union over every declared key. It returns an OBJECT with two methods because Vue needs
 * both reads to be first-class - the result read for anything that can fail, the throwing read for
 * the native error channel.
 */
export function createDeferredAccessor<D>() {
  return {
    data: <K extends keyof D & string>(key: K): Promise<D[K]> => useDeferredData(key) as unknown as Promise<D[K]>,
    result: <K extends keyof D & string>(key: K): Promise<DeferredResult<D[K]>> => useDeferredDataResult(key) as unknown as Promise<DeferredResult<D[K]>>,
  };
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
