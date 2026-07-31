import { callServiceMethod } from '../services/DataServices';
import { now } from '../telemetry/Telemetry';
import { snapshotInlineData } from '../../utils/InlineData';
import { prepareDataContext, runDataHandler } from './ResolveRouteData';

import type { ServiceRegistry } from '../services/DataServices';
import type { Logs } from '../logging/types';
import type { DataHandler, RouteAttributes, RouteParams } from '../config/types';
import type { RequestContext } from '../telemetry/Telemetry';
import type { TraceRecorder } from '../introspection/TraceRecorder';
import type { CallServiceOn } from './ResolveRouteData';

/**
 * RFC 0007 (decision 14): the accepted INTERNAL host -> renderer transport. A BARE named-promise
 * record - no scheduler, no lifecycle handle, no per-entry policy. Not a public application API.
 */
export type DeferredDataRegistry = Readonly<Record<string, Promise<Record<string, unknown>>>>;

/**
 * The host-internal settlement record - the only three v1 outcomes. `failed` carries NO message,
 * stack or detail.
 *
 * A `complete` entry retains the SNAPSHOT BYTES taken at settlement (`json`), not the loader's
 * object: the terminal splices that value fragment into the envelope unchanged, while the renderer
 * consumed `JSON.parse` of the same bytes (failure semantics item 2).
 */
export type DeferredSettlement = { status: 'complete'; json: string } | { status: 'failed' } | { status: 'aborted' };

export type DeferredSettlements = Record<string, DeferredSettlement>;

/**
 * Assemble the envelope's JSON TEXT from the settlements. Each `complete` entry's retained value
 * fragment is spliced VERBATIM - only the enclosing key/status structure is assembled here, and no
 * value is ever serialised a second time. The single hardened inline escape is applied once by the
 * caller to the assembled text, exactly as for the public `__INITIAL_DATA__` snapshot.
 *
 * Keys are emitted sorted for deterministic bytes; `JSON.stringify(key)` quotes and escapes the key.
 */
export const buildDeferredEnvelopeJson = (settlements: DeferredSettlements): string => {
  const parts: string[] = [];

  for (const key of Object.keys(settlements).sort()) {
    const settlement = settlements[key]!;

    parts.push(
      `${JSON.stringify(key)}:${settlement.status === 'complete' ? `{"status":"complete","value":${settlement.json}}` : `{"status":"${settlement.status}"}`}`,
    );
  }

  return `{${parts.join(',')}}`;
};

export type DeferredDataController = {
  /** Declared keys, in declaration order. */
  readonly keys: readonly string[];
  /**
   * The internal host -> renderer transport (`RenderOptions.deferredData`). Frozen, so a renderer
   * holding it after the terminal keeps a stable object; `release()` drops the HOST's reference
   * rather than mutating the renderer's copy.
   */
  readonly registry: DeferredDataRegistry;
  /**
   * Response terminal: signal outstanding work, classify anything still pending as `aborted`
   * (recording its trace event exactly once) and return the outcome envelope. Idempotent.
   *
   * AFTER `release()` the controller retains nothing, so this returns the EMPTY envelope rather
   * than rebuilding one: the outcomes are gone and a rebuild would report every key `aborted`,
   * contradicting the trace events already recorded.
   */
  settleAll: () => DeferredSettlements;
  /** `settleAll` + drop every retained value and promise reference, for terminals emitting no envelope. */
  release: () => void;
};

const EMPTY_REGISTRY: DeferredDataRegistry = Object.freeze({});
const EMPTY_ENVELOPE: DeferredSettlements = Object.freeze(Object.create(null) as DeferredSettlements);

const isPlainRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The registry promise's rejection when the settlement snapshot fails. DETAIL-FREE by construction:
 * the underlying serialiser error may quote application data and the renderer surfaces this to a
 * boundary, so nothing but the fact of failure crosses.
 */
const snapshotFailure = (key: string): Error => new Error(`taujs: deferred entry "${key}" resolved with a value that cannot be delivered`);

export type CreateDeferredDataOptions<Params extends RouteParams, R extends ServiceRegistry, L extends Logs = Logs> = {
  attr: RouteAttributes<Params> | undefined;
  params: Params;
  serviceRegistry: R;
  /** The SAME request context `attr.data` uses, read AFTER `ctx.signal` was assigned. */
  ctx: RequestContext<L> & { signal?: AbortSignal };
  requestId: string;
  recorder?: TraceRecorder;
  callServiceMethodImpl?: CallServiceOn<R>;
};

/**
 * RFC 0007 (R2): start every declared deferred handler exactly once, eagerly and independently,
 * with the matched params and the same request service context as `attr.data`.
 *
 * Returns `undefined` when the route declares no entries - the caller then behaves byte-identically
 * to today (no registry, no envelope, no trace events, nothing in the renderer opts bag).
 *
 * The deliberate choices:
 * - every entry promise is PRE-OBSERVED at creation (the R0-01 idiom) so an unconsumed rejection can
 *   never raise `unhandledRejection`;
 * - the entries share ONE child `AbortController` derived from the request signal (the head
 *   resolution's shape), so caller abort AND the response terminal both signal services that honour
 *   `ctx.signal`;
 * - CALLER ABORT WINS over application-error classification: once the controller has aborted,
 *   still-unsettled entries are `aborted`, never `failed`;
 * - `ms` is measured from REGISTRY CREATION to settlement or `aborted` classification (R5).
 */
export const createDeferredData = <Params extends RouteParams, R extends ServiceRegistry, L extends Logs = Logs>(
  options: CreateDeferredDataOptions<Params, R, L>,
): DeferredDataController | undefined => {
  const { attr, params, serviceRegistry, ctx, requestId, recorder } = options;
  const callServiceMethodImpl = options.callServiceMethodImpl ?? (callServiceMethod as CallServiceOn<R>);

  // Streaming arm only (R1). Untyped input reaching here despite the boot check is ignored rather
  // than re-validated: `extractRoutes` owns the hard error.
  const declared = attr?.render === 'streaming' ? (attr as { deferred?: Record<string, unknown> }).deferred : undefined;
  if (!declared || typeof declared !== 'object') return undefined;

  // OWN enumerable keys only - inherited properties are never trusted (R1 rule 1).
  const keys = Object.keys(declared).filter((key) => typeof declared[key] === 'function');
  if (keys.length === 0) return undefined;

  const t0 = now();
  const outcomes = new Map<string, DeferredSettlement | undefined>();

  // Declared BEFORE any abort wiring: a handler that aborts the request signal synchronously would
  // otherwise re-enter `releaseAll` while these bindings were still in their temporal dead zone.
  let frozenRegistry: DeferredDataRegistry | undefined;
  let envelope: DeferredSettlements | undefined;
  let released = false;
  let releasing = false;
  let terminated = false;

  const deferredAbort = new AbortController();
  const requestSignal = ctx.signal;
  // A caller abort is a response terminal: classify, signal AND drop retained state immediately.
  const onRequestAbort = () => releaseAll();

  const record = (key: string, outcome: DeferredSettlement): void => {
    if (!outcomes.has(key) || outcomes.get(key) !== undefined) return;
    outcomes.set(key, outcome);
    try {
      recorder?.deferredData({ requestId, key, ms: +(now() - t0).toFixed(1), outcome: outcome.status });
    } catch {
      // fire-and-forget telemetry must never affect the response (introspection invariant 2)
    }
  };

  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    try {
      requestSignal?.removeEventListener('abort', onRequestAbort);
    } catch {}
    try {
      deferredAbort.abort(new Error('taujs: deferred data released at the response terminal'));
    } catch {}
    for (const key of keys) record(key, { status: 'aborted' });
  };

  if (requestSignal?.aborted) {
    // Already-dead request: the child signal is aborted BEFORE any handler runs, so a loader that
    // honours `ctx.signal` never starts real work. Entries are still created (stable registry
    // shape) and classified `aborted` immediately after the start loop.
    try {
      deferredAbort.abort(new Error('taujs: request already aborted'));
    } catch {}
  } else requestSignal?.addEventListener('abort', onRequestAbort, { once: true });

  // Mirrors `attr.data`'s context exactly, except that `signal` is the child controller's.
  const ctxForData = prepareDataContext(serviceRegistry, { ...ctx, signal: deferredAbort.signal } as RequestContext<L>);

  // The accumulator is BLOCK-SCOPED and prototype-free, so afterwards the host's only reference to
  // the started promises is `frozenRegistry`, which `release()` drops outright.
  {
    const collected: Record<string, Promise<Record<string, unknown>>> = Object.create(null);

    for (const key of keys) {
      outcomes.set(key, undefined);

      // Exactly once, here, outside the component tree: the handler is invoked synchronously
      // inside this loop iteration.
      const source = runDataHandler(
        declared[key] as DataHandler<Params, L>,
        params,
        serviceRegistry,
        ctxForData,
        callServiceMethodImpl,
        `attr.deferred."${key}" must return a plain object or a ServiceDescriptor`,
      );
      source.catch(() => {}); // R0-01: pre-observed at creation

      // ONE handler takes the ONE snapshot, records the trace outcome AND produces the renderer's
      // value, so trace, envelope and renderer cannot disagree by construction. The registry
      // promise is this DERIVED promise, never the loader's.
      const entry = source.then(
        (value): Record<string, unknown> => {
          const snapshot = snapshotInlineData(value);
          // Decision 16: the parsed ROOT must be a plain record. A root `toJSON` yielding a number,
          // null or an array classifies the entry `failed` exactly as a non-serialisable value
          // does - the registry promises a record and so does the envelope schema.
          if (!snapshot.ok || !isPlainRecord(snapshot.value)) {
            // Operator visibility: payload-free, key only. The trace explains the outcome; this
            // explains why a RESOLVED loader became `failed`.
            try {
              ctx.logger?.warn({ key, requestId }, 'Deferred data could not cross the hydration boundary');
            } catch {}
            record(key, terminated ? { status: 'aborted' } : { status: 'failed' });

            throw snapshotFailure(key);
          }

          record(key, terminated ? { status: 'aborted' } : { status: 'complete', json: snapshot.json });

          // The parsed form of the retained bytes - plain data sharing NO identity with the
          // loader's object (the envelope splices the very bytes it was parsed from).
          return snapshot.value as Record<string, unknown>;
        },
        (err): never => {
          // A rejection stays a rejection (failure semantics 3).
          record(key, terminated ? { status: 'aborted' } : { status: 'failed' });

          throw err;
        },
      );
      entry.catch(() => {}); // R0-01: the derived promise is the one a renderer may leave unconsumed

      collected[key] = entry;
    }

    // Object spread DEFINES own properties, so even a `__proto__` own key copies across as data -
    // while the record handed to the renderer keeps the ordinary prototype its contract assumes. If
    // a handler aborted the request WHILE the loop ran, the terminal has already passed: publishing
    // now would resurrect a reference `release()` just dropped.
    frozenRegistry = released ? undefined : Object.freeze({ ...collected });
  }

  // An already-aborted request settles every entry now (caller abort wins).
  if (deferredAbort.signal.aborted) terminate();

  // Hoisted declarations: an abort arriving while this scope is still being evaluated must never
  // hit a temporal dead zone inside the abort listener.
  function settleAll(): DeferredSettlements {
    if (released) return EMPTY_ENVELOPE;

    terminate();

    if (!envelope) {
      const built: DeferredSettlements = Object.create(null);
      for (const key of [...keys].sort()) built[key] = outcomes.get(key) ?? { status: 'aborted' };
      envelope = built;
    }

    return envelope;
  }

  function releaseAll(): void {
    if (released || releasing) return;
    releasing = true;
    // Settle BEFORE flagging released: terminal classification and its one-per-key trace events
    // must still fire, and `settleAll` short-circuits once `released` is set.
    settleAll();
    released = true;
    envelope = undefined;
    outcomes.clear();
    frozenRegistry = undefined;
  }

  return {
    keys,
    get registry(): DeferredDataRegistry {
      return frozenRegistry ?? EMPTY_REGISTRY;
    },
    settleAll,
    release: releaseAll,
  };
};
