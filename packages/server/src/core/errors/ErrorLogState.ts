/**
 * Which error objects have already produced a log record WITHIN A GIVEN REQUEST, so a response
 * terminal can skip a DUPLICATE log line - and only the log line. Response conversion, trace
 * recording, aborts and teardown stay unconditional on every terminal that consults this.
 *
 * Marks are scoped per request, keyed on the request-context object that the classification site
 * and the terminals share, because an application may legally throw ONE long-lived error object
 * from many places: a mark left by an earlier request must never suppress a later request's only
 * terminal record. The outer `WeakMap` entry expires with its request context and the inner
 * `WeakSet` holds the error weakly, so nothing here extends any object's lifetime.
 *
 * The mark is unreachable from application data (`AppError.details` is application-controlled and
 * must never act as control-plane state), mutates nothing on the error - frozen errors work and
 * no serialised or logged metadata changes - and a missing request key fails SAFE: nothing is
 * marked, nothing is suppressed, the terminal logs.
 *
 * Deduplication applies only where the ORIGINAL error object reaches the terminal: always on the
 * SSR strategy, and on streaming when the renderer forwards the rejection it was given into its
 * fatal channel unchanged (pinned for solid; react wraps the rejection in its store read - see
 * docs/followups/renderer-store-rejection-identity.md - and vue is unclaimed until it has an
 * identity test).
 *
 * INTERNAL: importable by source modules, never exported from a package entry point.
 */
const loggedByRequest = new WeakMap<object, WeakSet<object>>();

/**
 * Record that `error` has produced its log record within the request identified by `requestKey`.
 * A missing or primitive key, or a non-object throwable, carries no usable identity and is
 * ignored - the error simply stays unmarked.
 */
export function markErrorLogged(requestKey: unknown, error: unknown): void {
  if (typeof requestKey !== 'object' || requestKey === null) return;
  if (typeof error !== 'object' || error === null) return;

  let marked = loggedByRequest.get(requestKey);
  if (!marked) {
    marked = new WeakSet<object>();
    loggedByRequest.set(requestKey, marked);
  }
  marked.add(error);
}

/** True only for an error object previously marked under the SAME request key. */
export function wasErrorLogged(requestKey: unknown, error: unknown): boolean {
  if (typeof requestKey !== 'object' || requestKey === null) return false;
  if (typeof error !== 'object' || error === null) return false;

  return loggedByRequest.get(requestKey)?.has(error) ?? false;
}
