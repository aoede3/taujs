import type { Logs } from '../logging/types';
import type { EpisodeRecorder } from '../introspection/EpisodeRecorder';

export type RequestContext<L extends Logs = Logs> = {
  /** Canonical request-correlation identity: always `String(req.id)` (SC-09). */
  requestId: string;
  logger: L;
  headers?: Record<string, string>;
  /**
   * Fastify's request target as received: the path plus any query string (`/products?sort=price`),
   * never an origin and never a parsed `URL`. Loaders read query state from here and parse what
   * they need themselves.
   */
  url: string;
  /** Dev-only episode recorder (already safety-wrapped); absent in production. */
  recorder?: EpisodeRecorder;
};

// agnostic `performance`
export const now = () => globalThis.performance?.now?.() ?? Date.now();
