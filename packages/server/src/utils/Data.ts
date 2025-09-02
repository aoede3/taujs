import { match } from 'path-to-regexp';

import type { MatchFunction } from 'path-to-regexp';
import type { Route, RouteAttributes, RouteParams, ServiceContext, ServiceMethod, ServiceRegistry } from '../SSRServer';

type Schema<T> = { parse(input: unknown): T };

type ServiceDescriptor = {
  serviceName: string;
  serviceMethod: string;
  args?: Record<string, unknown>;
};

type RequestCtx = ServiceContext & { headers: Record<string, string> };

type CallServiceOn<R extends ServiceRegistry> = (
  registry: R,
  serviceName: string,
  methodName: string,
  params: Record<string, unknown>,
  ctx: ServiceContext,
) => Promise<Record<string, unknown>>;

type MethodDefinition<P = unknown, R extends Record<string, unknown> = Record<string, unknown>> =
  | ServiceMethod<P, R>
  | {
      handler: ServiceMethod<P, R>;
      params?: Schema<P>;
      result?: Schema<R>;
    };

// Accept readonly method maps too (so callers can use `as const`)
export function defineService<T extends { readonly [K in string]: MethodDefinition<any, any> }>(spec: T) {
  const methods: Record<string, ServiceMethod<any, Record<string, unknown>>> = {};

  for (const [key, value] of Object.entries(spec)) {
    if (typeof value === 'function') {
      methods[key] = value;
    } else {
      const method = value.handler as ServiceMethod<unknown, Record<string, unknown>> & {
        paramsSchema?: Schema<unknown>;
        resultSchema?: Schema<Record<string, unknown>>;
      };
      if (value.params) (method as any).paramsSchema = value.params;
      if (value.result) (method as any).resultSchema = value.result;
      methods[key] = method;
    }
  }

  // Map object specs back to their handler fn type; pass through plain fns unchanged
  return methods as {
    [K in keyof T]: T[K] extends { handler: infer H } ? H : T[K];
  };
}

export const defineServiceRegistry = <R extends ServiceRegistry>(registry: R): R => registry;

// Internal `Command Descriptor with Dynamic Dispatch over a Service Registry`
// Resolves a command descriptor by dispatching it against the service registry
// Supports dynamic data fetching based on route-level declarations
// Performs optional runtime validation via schema.parse(...) when attached (e.g., Zod).
export const callServiceMethod = async <R extends ServiceRegistry, S extends Extract<keyof R, string>, M extends Extract<keyof R[S], string>>(
  registry: R,
  serviceName: S,
  methodName: M,
  params: Parameters<R[S][M]>[0],
  ctx: ServiceContext,
): Promise<Awaited<ReturnType<R[S][M]>>> => {
  const service = registry[serviceName];
  if (!service) throw new Error(`Service ${String(serviceName)} does not exist in the registry`);

  const method = service[methodName];
  if (typeof method !== 'function') throw new Error(`Service method ${String(methodName)} does not exist on ${String(serviceName)}`);

  const m = method as typeof method & {
    paramsSchema?: { parse: (u: unknown) => Parameters<R[S][M]>[0] };
    resultSchema?: { parse: (u: unknown) => Awaited<ReturnType<R[S][M]>> };
  };

  const safeParams = m.paramsSchema ? m.paramsSchema.parse(params) : params;
  const data = await m(safeParams, ctx);
  const safeData = m.resultSchema ? m.resultSchema.parse(data) : data;

  if (typeof safeData !== 'object' || safeData === null)
    throw new Error(`Expected object response from ${String(serviceName)}.${String(methodName)}, but got ${typeof safeData}`);

  return safeData as Awaited<ReturnType<R[S][M]>>;
};

export const isServiceDescriptor = (obj: unknown): obj is ServiceDescriptor => {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  const maybe = obj as Record<string, unknown>;

  return typeof maybe.serviceName === 'string' && typeof maybe.serviceMethod === 'string';
};

export const fetchInitialData = async <R extends ServiceRegistry>(
  attr: RouteAttributes<RouteParams> | undefined,
  params: Partial<Record<string, string | string[]>>,
  serviceRegistry: R,
  ctx: RequestCtx = { headers: {} },
  callServiceMethodImpl: CallServiceOn<R> = callServiceMethod as CallServiceOn<R>,
): Promise<Record<string, unknown>> => {
  const dataHandler = attr?.data;
  if (!dataHandler || typeof dataHandler !== 'function') return {};

  const result = await dataHandler(params, ctx);

  if (isServiceDescriptor(result)) {
    const { serviceName, serviceMethod, args } = result;

    return callServiceMethodImpl(serviceRegistry, serviceName, serviceMethod, args ?? {}, ctx);
  }

  if (typeof result === 'object' && result !== null) return result as Record<string, unknown>;

  throw new Error('Invalid result from attr.data');
};

export const matchRoute = <Params extends Partial<Record<string, string | string[]>>>(url: string, renderRoutes: Route<RouteParams>[]) => {
  for (const route of renderRoutes) {
    const matcher: MatchFunction<Params> = match(route.path, {
      decode: decodeURIComponent,
    });
    const matched = matcher(url);

    if (matched) return { route, params: matched.params };
  }

  return null;
};
