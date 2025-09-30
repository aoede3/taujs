import { ServiceError } from './ServiceError';

import type { Logs } from './Logger';

type Schema<T> = (input: unknown) => T;

type LooseSpec = Readonly<
  Record<
    string,
    | ServiceMethod<any, Record<string, unknown>>
    | {
        handler: ServiceMethod<any, Record<string, unknown>>;
        params?: Schema<any>;
        result?: Schema<any>;
        parsers?: { params?: Schema<any>; result?: Schema<any> };
      }
  >
>;

export type ServiceContext = {
  signal?: AbortSignal;
  deadlineMs?: number;
  traceId?: string;
  logger?: Logs;
  user?: { id: string; roles: string[] } | null;
};

export type ServiceMethod<P, R extends Record<string, unknown>> = (params: P, ctx: ServiceContext) => Promise<R>;

export type ServiceMethodDescriptor<P, R extends Record<string, unknown>> = {
  handler: ServiceMethod<P, R>;
  parsers?: { params?: Schema<P>; result?: Schema<R> };
};

export type ServiceRegistry = Readonly<Record<string, Readonly<Record<string, ServiceMethodDescriptor<any, Record<string, unknown>>>>>>;

export type ServiceDescriptor = {
  serviceName: string;
  serviceMethod: string;
  args?: Record<string, unknown>;
};

export const defineService = <T extends LooseSpec>(spec: T) => {
  const out: Record<string, ServiceMethodDescriptor<any, Record<string, unknown>>> = {};

  for (const [k, v] of Object.entries(spec)) {
    if (typeof v === 'function') {
      out[k] = { handler: v };
    } else {
      out[k] = {
        handler: v.handler,
        parsers: v.parsers ?? (v.params || v.result ? { params: v.params, result: v.result } : undefined),
      };
    }
  }

  return out as {
    [K in keyof T]: T[K] extends ServiceMethod<infer P, infer R>
      ? ServiceMethodDescriptor<P, R>
      : T[K] extends { handler: ServiceMethod<infer P, infer R> }
        ? ServiceMethodDescriptor<P, R>
        : never;
  };
};

export const defineServiceRegistry = <R extends ServiceRegistry>(registry: R): R => registry;

// Internal `Command Descriptor with Dynamic Dispatch over a Service Registry`
// Resolves a command descriptor by dispatching it against the service registry
// Supports dynamic data fetching based on route-level declarations
// Performs optional runtime validation via schema.parse(...) when attached (e.g., Zod).
export async function callServiceMethod(
  registry: ServiceRegistry,
  serviceName: string,
  methodName: string,
  params: Record<string, unknown>,
  ctx: ServiceContext,
): Promise<Record<string, unknown>> {
  if (ctx.signal?.aborted) throw ServiceError.timeout('Request canceled');

  const service = registry[serviceName];
  if (!service) throw ServiceError.notFound(`Unknown service: ${serviceName}`);

  const desc = service[methodName];
  if (!desc) throw ServiceError.notFound(`Unknown method: ${serviceName}.${methodName}`);

  const log = ctx.logger?.child({
    component: 'service-call',
    service: serviceName,
    method: methodName,
    traceId: ctx.traceId,
  });

  try {
    const p = desc.parsers?.params ? desc.parsers.params(params) : params;
    const data = await desc.handler(p, ctx);
    const out = desc.parsers?.result ? desc.parsers.result(data) : data;

    if (typeof out !== 'object' || out === null) throw ServiceError.infra(`Non-object result from ${serviceName}.${methodName}`);

    return out;
  } catch (err) {
    log?.error('Service method failed', {
      params,
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    });
    throw err;
  }
}

export const isServiceDescriptor = (obj: unknown): obj is ServiceDescriptor => {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  const maybe = obj as Record<string, unknown>;

  return typeof maybe.serviceName === 'string' && typeof maybe.serviceMethod === 'string';
};
