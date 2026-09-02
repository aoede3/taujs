import { now as telemetryNow } from '../telemetry/Telemetry';

/**
 * A single monotonic time budget spanning every phase of a request - head, critical, deferred,
 * and any nested service call reached via `ctx.call()`. Translated ONCE, at creation, to an
 * absolute deadline on the injected clock (default: the same monotonic `now` telemetry timing
 * already uses), so a later wall-clock change can never add or remove time, and a nested call
 * receives what is actually left rather than a fresh full allowance.
 */
export type RequestBudget = {
  /** Absolute deadline, monotonic ms - the same clock `remaining()` reads. */
  readonly deadline: number;
  /** Aborts when the deadline is reached or when the parent signal aborts (reason preserved). */
  readonly signal: AbortSignal;
  /** Milliseconds left until the deadline, floored at 0. */
  remaining(): number;
  /**
   * A budget for a later phase, sharing this budget's terminal but reserving `reserveMs` off the
   * END of it for the phases that come after the child. Constructing a child whose remaining
   * time is already exhausted is not an error - its signal simply aborts immediately, so callers
   * get one uniform refusal path regardless of how the exhaustion happened.
   */
  child(reserveMs: number): RequestBudget;
};

/**
 * INTERNAL lifecycle shape - never exported from the public entry, never on `ctx.budget`'s
 * public type: application code must not be able to disable deadline signalling. `dispose()`
 * releases the deadline timer and detaches from the parent signal, idempotently. It does NOT
 * abort `signal` and does NOT change what `remaining()` reports - refusal is pure clock math
 * against `deadline`, so a call made after disposal still refuses once genuinely past the
 * deadline; what is lost is only the late `signal` firing. Disposal covers THIS budget only,
 * never a `child()` tree: children are userland-created, each owns one unref'd timer, and that
 * timer self-releases no later than the child's own deadline - the root's terminal disposal
 * deliberately does not cascade into budgets it did not create.
 */
export type ManagedRequestBudget = RequestBudget & { dispose(): void };

export type CreateRequestBudgetOptions = {
  /** Chained in addition to the deadline - either cause aborts the returned signal. */
  parentSignal?: AbortSignal;
  /** Monotonic clock; defaults to the telemetry `now` (performance.now, falling back to Date.now). */
  now?: () => number;
} & (
  | {
      /** The allowance, in ms, translated once (at construction) to a deadline against `now`. */
      budgetMs: number;
      deadlineAt?: never;
    }
  | {
      /**
       * An already-resolved absolute deadline (monotonic ms, same clock as `now`) - the
       * alternative to `budgetMs` for a caller that captured the deadline earlier and must bind
       * this budget to that SAME absolute line rather than deriving a fresh allowance from "now"
       * at this later construction site.
       */
      deadlineAt: number;
      budgetMs?: never;
    }
);

const DEADLINE_REASON = () => new Error('Request budget deadline exceeded');

// Shared by createRequestBudget and child(): builds one budget around an already-resolved
// deadline, so a child's deadline math never re-reads the clock relative to "now" - only the
// parent's deadline, which keeps every terminal on the same absolute line.
const budgetFromDeadline = (deadline: number, parentSignal: AbortSignal | undefined, nowFn: () => number): ManagedRequestBudget => {
  const remaining = (): number => Math.max(0, deadline - nowFn());

  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Runs exactly once, however the signal came to abort (deadline timer, parent propagation, or
  // the immediate-abort constructions below) - the ctrl.signal listener below is the one place
  // that guarantees this regardless of path.
  const cleanup = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    parentSignal?.removeEventListener('abort', onParentAbort);
  };

  const onParentAbort = (): void => ctrl.abort(parentSignal?.reason);

  ctrl.signal.addEventListener('abort', cleanup, { once: true });

  if (parentSignal?.aborted) {
    // Already gone before this budget existed - abort synchronously with the parent's reason;
    // no timer is ever created.
    ctrl.abort(parentSignal.reason);
  } else {
    if (parentSignal) parentSignal.addEventListener('abort', onParentAbort, { once: true });

    const msLeft = deadline - nowFn();
    if (msLeft <= 0) {
      // Already past its own deadline at construction - abort synchronously so callers get the
      // same uniform refusal path as a timer firing, without waiting an event-loop tick.
      ctrl.abort(DEADLINE_REASON());
    } else {
      timer = setTimeout(() => ctrl.abort(DEADLINE_REASON()), msLeft);
      // Never holds the process open on its own.
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  return {
    deadline,
    signal: ctrl.signal,
    remaining,
    // Chained to THIS budget's own signal (not the original parentSignal): that one listener
    // carries both terminal causes (this budget's deadline and whatever it inherited), so the
    // child can never outlive it.
    child: (reserveMs: number): RequestBudget => budgetFromDeadline(deadline - Math.max(0, reserveMs), ctrl.signal, nowFn),
    // Deliberately the SAME function that already runs on every abort path - it only ever clears
    // the timer and detaches the parent listener, never calls `ctrl.abort()`, so calling it here
    // (a non-abort path) leaves `signal` unaborted and `remaining()` untouched. Safe to call more
    // than once, and safe to call after the signal already aborted (cleanup already ran then, so
    // this is a no-op).
    dispose: cleanup,
  };
};

export function createRequestBudget(opts: CreateRequestBudgetOptions): ManagedRequestBudget {
  const nowFn = opts.now ?? telemetryNow;
  const deadline = opts.deadlineAt !== undefined ? opts.deadlineAt : nowFn() + opts.budgetMs;

  return budgetFromDeadline(deadline, opts.parentSignal, nowFn);
}
