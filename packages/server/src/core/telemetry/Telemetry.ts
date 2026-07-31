import type { Logs } from '../logging/types';
import type { TraceRecorder } from '../introspection/TraceRecorder';

export type RequestContext<L extends Logs = Logs> = {
  /** Canonical request-correlation identity: always `String(req.id)` (SC-09). */
  requestId: string;
  logger: L;
  headers?: Record<string, string>;
  /** Dev-only trace recorder (already safety-wrapped); absent in production. */
  recorder?: TraceRecorder;
};

// agnostic `performance`
export const now = () => globalThis.performance?.now?.() ?? Date.now();
