/**
 * Which error objects have already produced a log record, so a response terminal can skip a
 * DUPLICATE log line - and only the log line. Response conversion, trace recording, aborts and
 * teardown stay unconditional on every terminal that consults this.
 *
 * A module-private `WeakSet` keyed on the error object itself is the ruled mechanism:
 * - the mark is unreachable from application data, so an application error can never claim to have
 *   been logged (`AppError.details` is application-controlled and must never act as control-plane
 *   state);
 * - marking mutates nothing on the error, so it works on frozen errors and adds nothing to
 *   serialised or logged metadata;
 * - membership is weak, so a marked error is retained no longer than the request that threw it.
 *
 * Marking and checking both happen inside ONE `@taujs/server` request path, so a second installed
 * copy of the package is irrelevant. Renderers forward the original error object untouched and
 * never inspect the marker.
 *
 * INTERNAL: importable by source modules, never exported from a package entry point.
 */
const loggedErrors = new WeakSet<object>();

/**
 * Record that `error` has produced its log record. A non-object throwable carries no stable
 * identity to key on and is ignored - it simply stays unmarked.
 */
export function markErrorLogged(error: unknown): void {
  if (typeof error === 'object' && error !== null) loggedErrors.add(error);
}

/** True only for an error object previously passed to {@link markErrorLogged}. */
export function wasErrorLogged(error: unknown): boolean {
  return typeof error === 'object' && error !== null && loggedErrors.has(error);
}
