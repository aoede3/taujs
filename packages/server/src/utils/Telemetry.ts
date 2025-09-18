import type { Logger } from './Logger';

export interface TelemetryClient {
  log?: (message: string, context?: Record<string, unknown>) => void;
  warn?: (message: string, context?: Record<string, unknown>) => void;
  error?: (error: unknown, context?: Record<string, unknown>) => void;
}

export function createTelemetry(client: TelemetryClient): Logger {
  return {
    log: (...args: unknown[]) => {
      client.log?.(args.map(String).join(' '));
    },
    warn: (...args: unknown[]) => {
      client.warn?.(args.map(String).join(' '));
    },
    error: (...args: unknown[]) => {
      client.error?.(args.map(String).join(' '));
    },
    serviceError: (err: unknown, context?: Record<string, unknown>) => {
      client.error?.(err instanceof Error ? err : new Error(String(err)), context);

      throw err; // taujs semantics
    },
  };
}
