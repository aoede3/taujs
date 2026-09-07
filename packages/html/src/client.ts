/**
 * `@taujs/html/client` - the ONE client export: `onDataReady`.
 *
 * The deferred envelope is delivered on a PRIVATE carrier
 * (`packages/server/src/utils/HandleRender.ts:36-43`, "undocumented and unsupported for
 * applications"), and the framework packages are tested to never export its name
 * (`packages/react/src/test/SSRDeferredData.exports.test.ts`). `taujs:data-ready` is not a safe
 * rendezvous either: it can dispatch before this module executes
 * (`packages/vue/src/SSRHydration.ts:252-262`). `onDataReady` is the public boundary the three
 * framework renderers already provide inside their own `hydrateApp` - `@taujs/html` has no
 * hydration, so it ships the same read on its own.
 */

/**
 * The PRIVATE, UNDOCUMENTED deferred-outcome carrier the host attaches at its existing
 * end-of-stream write site (`packages/server/src/utils/HandleRender.ts:43`), only when the
 * host-resolved hydration policy is on. Reproduced BY VALUE; NEVER exported - `Exports.test.ts`
 * asserts this module's runtime export names are exactly `onDataReady`.
 */
const DEFERRED_STATE_CARRIER = '__TAUJS_DEFERRED_STATE__';

const INITIAL_DATA_KEY = '__INITIAL_DATA__';

export type DeferredOutcome<V = unknown> = { status: 'complete'; value: V } | { status: 'failed' } | { status: 'aborted' };

export type DeferredEnvelope<D extends Record<string, unknown> = Record<string, unknown>> = Readonly<{ [K in keyof D]: DeferredOutcome<D[K]> }>;

/** Read the private envelope ONCE and drop the carrier, in the same synchronous access. */
const takeDeferredEnvelope = (): DeferredEnvelope | undefined => {
  const w = window as unknown as Record<string, unknown>;
  const raw = w[DEFERRED_STATE_CARRIER];
  delete w[DEFERRED_STATE_CARRIER];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  return raw as DeferredEnvelope;
};

/**
 * Run `callback` once the document is ready, with the initial-data snapshot
 * (`window.__INITIAL_DATA__`, read once and left in place) and the typed deferred outcome envelope
 * (`undefined` for a route with no `attr.deferred`, or `hydrate: false`).
 *
 * Runs immediately when `document.readyState !== 'loading'`, otherwise once on `DOMContentLoaded` -
 * by then both the bootstrap module and the host's end-of-stream data script have executed.
 * `callback` runs exactly once per call; a throw inside it propagates (this helper does not swallow
 * application errors).
 *
 * No hydration, no DOM mutation, no fetching, no retries: the application enhances its own HTML in
 * `callback`.
 */
export function onDataReady<T = Record<string, unknown>, D extends Record<string, unknown> = Record<string, unknown>>(
  callback: (ready: { data: T | undefined; deferred: DeferredEnvelope<D> | undefined }) => void,
): void {
  if (typeof document === 'undefined') {
    throw new Error('onDataReady: no document; this function runs in the browser only');
  }

  const run = () => {
    const data = (window as unknown as Record<string, unknown>)[INITIAL_DATA_KEY] as T | undefined;
    const deferred = takeDeferredEnvelope() as DeferredEnvelope<D> | undefined;

    callback({ data, deferred });
  };

  if (document.readyState !== 'loading') {
    run();
  } else {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  }
}
