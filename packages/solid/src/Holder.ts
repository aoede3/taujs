/**
 * Detachable holders - Decision B mandate M1.
 *
 * ALL τjs-owned request state (route data, route context, store payload) reaches components ONLY
 * through an adapter-owned holder, and every terminal (abort / timeout / force-end) nulls it. This
 * exists because Solid exposes NO dispose seam: `renderToStream`'s root disposal requires
 * `firstFlushed`, which never happens on the stalled paths, so an un-disposed root can outlive the
 * response until the application's promises settle. S0-B2/B2R proved the root itself stays
 * reachable - and proved, causally, that nulling the τjs payload behind it still releases the
 * request state (COLLECTED-with-detach vs RETAINED control, under identical GC pressure).
 *
 * The ownership boundary is exactly the C1 text, accepted verbatim, and is NOT a claim that Solid
 * supports disposal:
 *
 *   τjs guarantees release of references retained by the renderer adapter and its providers; it
 *   cannot release references deliberately copied into application-owned closures.
 *
 * So a component that does `const d = data()` into its own closure keeps that value alive - that
 * is application-owned retention and no adapter can undo it. What the adapter guarantees is that
 * IT holds nothing after a terminal. Never hand the root a raw request-scoped container while
 * claiming detachability: pass a holder-backed accessor instead.
 */

export type Holder<T> = {
  /** Read the payload. Throws once detached - a detached read is a bug, never silent `undefined`. */
  get(): T;
  /** Replace the payload. No-op once detached (a late continuation must not resurrect state). */
  set(value: T): void;
  /** Release the payload. Idempotent; safe on every terminal path. */
  detach(): void;
  readonly detached: boolean;
  readonly filled: boolean;
};

export type HolderOptions = {
  /** Used in diagnostics so a detached/empty read names what was released. */
  label?: string;
};

const EMPTY = Symbol('taujs.solid.holder.empty');

export function createHolder<T>(options: HolderOptions = {}): Holder<T> {
  const label = options.label ?? 'request state';
  // `unknown` + a sentinel rather than `T | undefined`, so a legitimately-`undefined` payload is
  // still distinguishable from "never set".
  let payload: unknown = EMPTY;
  let detached = false;

  return {
    get(): T {
      if (detached) {
        throw new Error(`taujs: ${label} was released when the response terminated and can no longer be read`);
      }
      if (payload === EMPTY) {
        throw new Error(`taujs: ${label} was read before it was available`);
      }

      return payload as T;
    },

    set(value: T): void {
      // A superseded loader, a late continuation, or any post-terminal write must not refill a
      // detached holder - that would re-retain exactly what the terminal just released.
      if (detached) return;
      payload = value;
    },

    detach(): void {
      detached = true;
      payload = EMPTY;
    },

    get detached() {
      return detached;
    },

    get filled() {
      return !detached && payload !== EMPTY;
    },
  };
}
