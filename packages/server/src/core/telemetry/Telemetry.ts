import type { Logs } from '../logging/types';
import type { TraceRecorder } from '../introspection/TraceRecorder';

export type RequestContext<L extends Logs = Logs> = {
  traceId: string;
  logger: L;
  headers?: Record<string, string>;
  /** Dev-only trace recorder (already safety-wrapped); absent in production. */
  recorder?: TraceRecorder;
};

// agnostic `performance`
export const now = () => globalThis.performance?.now?.() ?? Date.now();
