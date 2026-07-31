import type { Logs } from '../logging/types';
import type { EpisodeRecorder } from '../introspection/EpisodeRecorder';

export type RequestContext<L extends Logs = Logs> = {
  /** Canonical request-correlation identity: always `String(req.id)` (SC-09). */
  requestId: string;
  logger: L;
  headers?: Record<string, string>;
  /** Dev-only episode recorder (already safety-wrapped); absent in production. */
  recorder?: EpisodeRecorder;
};

// agnostic `performance`
export const now = () => globalThis.performance?.now?.() ?? Date.now();
