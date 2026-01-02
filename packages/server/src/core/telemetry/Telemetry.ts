import type { Logs } from '../logging/types';

export type RequestContext<L extends Logs = Logs> = {
  traceId: string;
  logger: L;
  headers?: Record<string, string>;
};

// agnostic `performance`
export const now = () => globalThis.performance?.now?.() ?? Date.now();
