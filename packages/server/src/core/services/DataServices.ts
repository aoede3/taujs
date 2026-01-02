import { AppError } from '../errors/AppError';
import { resolveLogs } from '../logging/resolve';

import type { Logs } from '../logging/types';
import { now } from '../telemetry/Telemetry';

export type RegistryCaller<R extends ServiceRegistry = ServiceRegistry> = (
  serviceName: keyof R & string,
  methodName: string,
  args?: JsonObject,
) => Promise<JsonObject>;

export function createCaller<R extends ServiceRegistry>(registry: R, ctx: ServiceContext): RegistryCaller<R> {
  return (serviceName, methodName, args) => callServiceMethod(registry, serviceName, methodName, (args ?? {}) as JsonObject, ctx);
}

// ctx has a bound `call` function (returns the same object reference)?
export function ensureServiceCaller<R extends ServiceRegistry>(
  registry: R,
  ctx: ServiceContext & Partial<{ call: RegistryCaller<R> }>,
): asserts ctx is ServiceContext & { call: RegistryCaller<R> } {
  if (!ctx.call) (ctx as any).call = createCaller(registry, ctx);
}

// runtime checks instead happens at the boundary
type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

type NarrowSchema<T> = { parse: (u: unknown) => T } | ((u: unknown) => T);

const runSchema = <T>(schema: NarrowSchema<T> | undefined, input: unknown): T => {
  if (!schema) return input as T;

  return typeof (schema as any).parse === 'function' ? (schema as any).parse(input) : (schema as (u: unknown) => T)(input);
};

export type ServiceContext = {
  signal?: AbortSignal; // request/client abort passed in request
  deadlineMs?: number; // available to userland; not enforced here
  traceId?: string;
  logger?: Logs;
  user?: { id: string; roles: string[] } | null;
  call?: (service: string, method: string, args?: JsonObject) => Promise<JsonObject>;
};

// Helper for userland: combine a parent AbortSignal with a per-call timeout
export function withDeadline(signal: AbortSignal | undefined, ms?: number): AbortSignal | undefined {
  if (!ms) return signal;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason ?? new Error('Aborted'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(new Error('DeadlineExceeded')), ms);
  ctrl.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    },
    { once: true },
  );

  return ctrl.signal;
}

export type ServiceMethod<P, R extends JsonObject = JsonObject> = (params: P, ctx: ServiceContext) => Promise<R>;
export type ServiceDefinition = Readonly<Record<string, ServiceMethod<any, JsonObject>>>;
export type ServiceRegistry = Readonly<Record<string, ServiceDefinition>>;

export type ServiceDescriptor = {
  serviceName: string;
  serviceMethod: string;
  args?: JsonObject;
};

export function defineService<
  T extends Record<
    string,
    ServiceMethod<any, JsonObject> | { handler: ServiceMethod<any, JsonObject>; params?: NarrowSchema<any>; result?: NarrowSchema<any> }
  >,
>(spec: T) {
  const out: Record<string, ServiceMethod<any, JsonObject>> = {};

  for (const [name, v] of Object.entries(spec)) {
    if (typeof v === 'function') {
      out[name] = v; // already a handler
    } else {
      const { handler, params: paramsSchema, result: resultSchema } = v;
      out[name] = async (params, ctx) => {
        const p = runSchema(paramsSchema, params);
        const r = await handler(p, ctx);

        return runSchema(resultSchema, r);
      };
    }
  }

  return Object.freeze(out) as {
    [K in keyof T]: T[K] extends ServiceMethod<infer P, infer R>
      ? ServiceMethod<P, R>
      : T[K] extends { handler: ServiceMethod<infer P, infer R> }
        ? ServiceMethod<P, R>
        : never;
  };
}

export const defineServiceRegistry = <R extends ServiceRegistry>(registry: R): R =>
  Object.freeze(Object.fromEntries(Object.entries(registry).map(([k, v]) => [k, Object.freeze(v)]))) as R;

// Internal `Command Descriptor with Dynamic Dispatch over a Service Registry`
// Resolves a command descriptor by dispatching it against the service registry
// Supports dynamic data fetching based on route-level declarations
export async function callServiceMethod(
  registry: ServiceRegistry,
  serviceName: string,
  methodName: string,
  params: JsonObject | undefined,
  ctx: ServiceContext,
): Promise<JsonObject> {
  if (ctx.signal?.aborted) throw AppError.timeout('Request canceled');

  const service = registry[serviceName];
  if (!service) throw AppError.notFound(`Unknown service: ${serviceName}`);

  const method = service[methodName];
  if (!method) throw AppError.notFound(`Unknown method: ${serviceName}.${methodName}`);

  const baseLogger = resolveLogs(ctx.logger);

  const logger = baseLogger.child({
    component: 'service-call',
    service: serviceName,
    method: methodName,
    traceId: ctx.traceId,
  });

  const t0 = now();

  try {
    // No automatic deadlines here; handlers can use ctx.signal or withDeadline(ctx.signal, ms)
    const result = await method(params ?? {}, ctx);

    if (typeof result !== 'object' || result === null) {
      throw AppError.internal(`Non-object result from ${serviceName}.${methodName}`);
    }

    logger.debug({ ms: +(now() - t0).toFixed(1) }, 'Service method ok');

    return result;
  } catch (err) {
    logger.error(
      {
        params,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
        ms: +(now() - t0).toFixed(1),
      },
      'Service method failed',
    );

    throw err instanceof AppError
      ? err
      : err instanceof Error
        ? AppError.internal(err.message, { cause: err })
        : AppError.internal('Unknown error', { details: { err } });
  }
}

export const isServiceDescriptor = (obj: unknown): obj is ServiceDescriptor => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const o = obj as any;
  if (typeof o.serviceName !== 'string' || typeof o.serviceMethod !== 'string') return false;
  if ('args' in o) {
    if (o.args === null || typeof o.args !== 'object' || Array.isArray(o.args)) return false;
  }

  return true;
};
