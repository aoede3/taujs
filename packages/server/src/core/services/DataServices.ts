import { fileURLToPath } from 'node:url';

import { AppError } from '../errors/AppError';
import { resolveLogs } from '../logging/resolve';
import { resolveAmbient } from '../introspection/HostAttribution';

import type { Logs } from '../logging/types';
import type { EpisodeRecorder } from '../introspection/EpisodeRecorder';
import { now } from '../telemetry/Telemetry';

// runtime checks instead happens at the boundary
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

type NarrowSchema<T> = { parse: (u: unknown) => T } | ((u: unknown) => T);

const runSchema = <T>(schema: NarrowSchema<T> | undefined, input: unknown): T => {
  if (!schema) return input as T;

  return typeof (schema as any).parse === 'function' ? (schema as any).parse(input) : (schema as (u: unknown) => T)(input);
};

type BaseServiceContext = {
  signal?: AbortSignal; // request/client abort passed in request
  deadlineMs?: number; // available to userland; not enforced here
  requestId?: string;
  logger?: Logs;
  user?: { id: string; roles: string[] } | null;
  recorder?: EpisodeRecorder; // dev-only, safety-wrapped; absent in production
};

type UntypedRegistryCaller = (serviceName: string, methodName: string, args?: JsonObject) => Promise<JsonObject>;
type RuntimeServiceContext = BaseServiceContext & { call?: UntypedRegistryCaller };

/**
 * Base request context passed to service methods. τjs route execution supplies `signal`,
 * `requestId` and `logger`; caller-owned or augmented fields are not populated automatically.
 */
export interface ServiceContext extends BaseServiceContext {}

/**
 * A service handler whose params and result are JSON objects. Use a type alias or inline object
 * for params; an interface without an index signature is not accepted.
 */
export type ServiceMethod<P extends JsonObject = JsonObject, R extends JsonObject = JsonObject, Ctx extends BaseServiceContext = TypedServiceContext> = (
  params: P,
  ctx: Ctx,
) => Promise<R>;
type RuntimeServiceMethod<P extends JsonObject = JsonObject, R extends JsonObject = JsonObject> = (params: P, ctx: RuntimeServiceContext) => Promise<R>;

export type ServiceDefinition = Readonly<Record<string, RuntimeServiceMethod<any, JsonObject>>>;
export type ServiceRegistry = Readonly<Record<string, ServiceDefinition>>;

export type ServiceMethodParams<M> = M extends (params: infer P, ctx: any) => Promise<any> ? P : never;
type ServiceMethodResult<M> = Awaited<M extends (...args: any[]) => Promise<infer R> ? R : never>;
type RegistryCallerArgs<R extends ServiceRegistry, S extends keyof R & string, M extends keyof R[S] & string> =
  undefined extends ServiceMethodParams<R[S][M]>
    ? [serviceName: S, methodName: M, args?: ServiceMethodParams<R[S][M]>]
    : [serviceName: S, methodName: M, args: ServiceMethodParams<R[S][M]>];

export type RegistryCaller<R extends ServiceRegistry = ServiceRegistry> = <S extends keyof R & string, M extends keyof R[S] & string>(
  ...args: RegistryCallerArgs<R, S, M>
) => Promise<ServiceMethodResult<R[S][M]>>;

// Binds ctx.call to a concrete registry without creating a parallel contract type.
export type TypedServiceContext<R extends ServiceRegistry = ServiceRegistry> = ServiceContext & { call?: RegistryCaller<R> };

export function createCaller<R extends ServiceRegistry>(registry: R, ctx: BaseServiceContext): RegistryCaller<R> {
  return ((serviceName: string, methodName: string, args?: JsonObject) =>
    callServiceMethod(registry, serviceName, methodName, (args ?? {}) as JsonObject, ctx)) as unknown as RegistryCaller<R>;
}

// ctx has a bound `call` function (returns the same object reference)?
export function ensureServiceCaller<R extends ServiceRegistry>(
  registry: R,
  ctx: BaseServiceContext & Partial<{ call: RegistryCaller<R> }>,
): asserts ctx is BaseServiceContext & { call: RegistryCaller<R> } {
  if (!ctx.call) (ctx as any).call = createCaller(registry, ctx);
}

/**
 * Returns `signal` unchanged when `ms` is falsy; otherwise returns a child signal that propagates
 * later parent aborts with their reason or aborts after `ms` with `Error('DeadlineExceeded')`. An already-aborted
 * parent is not copied at creation, and consumers must observe the signal to cancel their work.
 */
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

export type ServiceDescriptor = {
  serviceName: string;
  serviceMethod: string;
  args?: JsonObject;
};

type ServiceSpecEntry = ServiceMethod<any, JsonObject> | { handler: ServiceMethod<any, JsonObject>; params?: NarrowSchema<any>; result?: NarrowSchema<any> };
type ServiceSpec = Record<string, ServiceSpecEntry>;
type ExtractServiceMethod<T> = T extends { handler: infer H } ? H : T;
type NormalizeServiceMethod<M> = M extends (params: infer P extends JsonObject, ctx: any) => Promise<infer R extends JsonObject>
  ? RuntimeServiceMethod<P, R>
  : ServiceParamsTypeError;
type ServiceParamsMessage =
  'params must be a JSON object type; an interface without an index signature is not accepted, so use a type alias or an inline object type';
type ServiceParamsTypeError = { readonly __taujsServiceTypeError: ServiceParamsMessage };
type NormalizedServiceSpec<T extends ServiceSpec> = {
  [K in keyof T]: NormalizeServiceMethod<ExtractServiceMethod<T[K]>>;
};

// --- Introspection metadata (P0A-02) ------------------------------------------------
// Retains the schema shape declared for each normalised method so createRequestGraph can
// read it without executing handlers. Module-private symbol; graph code reads via
// getServiceMethodMetadata, never the symbol. Mirrors the serviceData() stamping pattern
// (core/services/ServiceData.ts).
const SERVICE_METHOD_METADATA = Symbol('taujs.serviceMethod');
const SERVICE_DEFINITION_LOCATION = Symbol('taujs.serviceDefinitionLocation');

export type ServiceSchemaKind = 'parse' | 'function';
// `kind` is only what NarrowSchema honestly reveals — an object with `.parse` vs a bare
// function. We never claim "zod" (spec 02 §Services; decisions.md #1).
export type ServiceSchemaMetadata = Readonly<{ declared: boolean; kind?: ServiceSchemaKind }>;
export type ServiceMethodMetadata = Readonly<{ params: ServiceSchemaMetadata; result: ServiceSchemaMetadata }>;
export type ServiceDefinitionLocation = Readonly<{ file: string }>;

// Same detection runSchema uses at runtime (line 17), so recorded metadata can never
// disagree with how the schema is actually applied.
const describeSchema = (schema: NarrowSchema<unknown> | undefined): ServiceSchemaMetadata =>
  !schema
    ? Object.freeze({ declared: false })
    : Object.freeze({ declared: true, kind: typeof (schema as { parse?: unknown }).parse === 'function' ? 'parse' : 'function' });

const methodMetadata = (paramsSchema: NarrowSchema<unknown> | undefined, resultSchema: NarrowSchema<unknown> | undefined): ServiceMethodMetadata =>
  Object.freeze({ params: describeSchema(paramsSchema), result: describeSchema(resultSchema) });

const stampServiceMethodMetadata = (fn: object, metadata: ServiceMethodMetadata): void => {
  // Skip when already stamped (a bare-function entry keeps its identity, so the same
  // function reused across defineService calls would otherwise hit a non-configurable
  // redefine) or non-extensible (a frozen/sealed user handler — an honest gap beats a
  // throw). Both keep runtime behaviour byte-for-byte unchanged.
  if (!Object.isExtensible(fn) || Object.prototype.hasOwnProperty.call(fn, SERVICE_METHOD_METADATA)) return;
  Object.defineProperty(fn, SERVICE_METHOD_METADATA, { value: metadata, enumerable: false });
};

const stackFrameFile = (line: string): string | undefined => {
  const trimmed = line.trim();
  const location = trimmed.endsWith(')') && trimmed.includes('(') ? trimmed.slice(trimmed.lastIndexOf('(') + 1, -1) : trimmed.replace(/^at\s+/, '');
  const match = location.match(/^(.*):\d+:\d+$/);
  if (!match) return undefined;

  const file = match[1];
  if (!file) return undefined;
  try {
    if (file.startsWith('file:')) return fileURLToPath(file);
  } catch {
    return undefined;
  }

  return file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) ? file : undefined;
};

// This captures one stack per defineService call, typically during module initialisation and
// including in production; normal service dispatch does not capture stacks. The absolute file
// remains private unless graph creation receives a project root and emits a bounded relative path.
const captureServiceDefinitionLocation = (): ServiceDefinitionLocation | undefined => {
  if (typeof Error.captureStackTrace !== 'function') return undefined;

  try {
    const holder: { stack?: unknown } = {};
    Error.captureStackTrace(holder, defineService);
    if (typeof holder.stack !== 'string') return undefined;

    const file = holder.stack
      .split('\n')
      .slice(1)
      .map(stackFrameFile)
      .find((candidate): candidate is string => candidate !== undefined);

    return file ? Object.freeze({ file }) : undefined;
  } catch {
    // Definition provenance is advisory. A host-customised stack formatter or an unsupported
    // runtime must degrade to unknown, never make service definition fail.
    return undefined;
  }
};

type ServiceParamsOf<M> = M extends (...args: infer A) => any ? (A extends [] ? JsonObject : A[0]) : JsonObject;
type ValidateServiceSpec<T extends ServiceSpec> = {
  [K in keyof T]: ServiceParamsOf<ExtractServiceMethod<T[K]>> extends JsonObject ? T[K] : { readonly __taujsServiceTypeError: ServiceParamsMessage };
};

/**
 * Defines and freezes a service method map. Object entries validate params before the handler and
 * results after it; validation and handler failures propagate to the caller. See {@link ServiceMethod}.
 */
export function defineService<T extends ServiceSpec>(spec: T & ValidateServiceSpec<T>) {
  const out: Record<string, RuntimeServiceMethod<any, JsonObject>> = {};
  const definitionLocation = captureServiceDefinitionLocation();

  for (const [name, v] of Object.entries(spec)) {
    if (typeof v === 'function') {
      out[name] = v as RuntimeServiceMethod<any, JsonObject>;
      stampServiceMethodMetadata(out[name], methodMetadata(undefined, undefined));
    } else {
      const { handler, params: paramsSchema, result: resultSchema } = v;
      const method: RuntimeServiceMethod<any, JsonObject> = async (params, ctx) => {
        const p = runSchema(paramsSchema, params);
        const r = await handler(p, ctx as ServiceContext);

        return runSchema(resultSchema, r);
      };
      stampServiceMethodMetadata(method, methodMetadata(paramsSchema, resultSchema));
      out[name] = method;
    }
  }

  if (definitionLocation) Object.defineProperty(out, SERVICE_DEFINITION_LOCATION, { value: definitionLocation, enumerable: false });

  return Object.freeze(out) as NormalizedServiceSpec<T>;
}

// Internal accessor for introspection (P0A-03). Returns undefined for non-functions and
// unstamped functions — the caller's honest `kind: 'dynamic'` / gap case.
export const getServiceMethodMetadata = (fn: unknown): ServiceMethodMetadata | undefined =>
  typeof fn === 'function' ? (fn as { [SERVICE_METHOD_METADATA]?: ServiceMethodMetadata })[SERVICE_METHOD_METADATA] : undefined;

// Internal accessor for introspection. The captured absolute file never crosses the graph
// boundary directly: createRequestGraph emits it only after lexical project-root containment and
// relative-path normalisation, otherwise it emits an explicit unknown.
export const getServiceDefinitionLocation = (definition: unknown): ServiceDefinitionLocation | undefined =>
  definition && typeof definition === 'object'
    ? (definition as { [SERVICE_DEFINITION_LOCATION]?: ServiceDefinitionLocation })[SERVICE_DEFINITION_LOCATION]
    : undefined;

/**
 * Returns a new frozen registry whose service objects are shallow-frozen. Handlers and values
 * reachable through those objects are not recursively frozen.
 */
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
  ctx: BaseServiceContext,
): Promise<JsonObject> {
  if (ctx.signal?.aborted) throw AppError.timeout('Request canceled');

  const service = registry[serviceName];
  if (!service) throw AppError.notFound(`Unknown service: ${serviceName}`);

  const method = service[methodName];
  if (!method) throw AppError.notFound(`Unknown method: ${serviceName}.${methodName}`);

  const baseLogger = resolveLogs(ctx.logger);

  // SC-09: `reqId` means the CURRENT Fastify request, in its native type, and arrives through the
  // request-logger lineage - rebinding it here would stringify a numeric host identity and fork
  // the meaning. A logger without that lineage simply carries no request identity; the episode
  // relationship is the recorder's (`serviceCall({ requestId })` below), not this child's.
  const logger = baseLogger.child({
    component: 'service-call',
    service: serviceName,
    method: methodName,
  });

  const t0 = now();

  // RFC 0018 (Design step 2): consulted once, only when the explicit context supplied no
  // recorder - explicit precedence is unconditional. `recorder`/`requestId` below feed the exact
  // same two-value guard the explicit path already used; the ambient branch only ever fills a ctx
  // that guard would otherwise have found empty, as a matched pair, never mixed with a caller's
  // own partial requestId.
  const ambient = ctx.recorder ? undefined : resolveAmbient(registry);
  const recorder = ctx.recorder ?? ambient?.recorder;
  const requestId = ctx.recorder ? ctx.requestId : ambient?.requestId;

  try {
    // No automatic deadlines here; handlers can use ctx.signal or withDeadline(ctx.signal, ms)
    const result = await method(params ?? {}, ctx as RuntimeServiceContext);

    if (typeof result !== 'object' || result === null) {
      throw AppError.internal(`Non-object result from ${serviceName}.${methodName}`);
    }

    const ms = +(now() - t0).toFixed(1);
    logger.debug({ ms }, 'Service method ok');
    if (recorder && requestId) recorder.serviceCall({ requestId, service: serviceName, method: methodName, ms, ok: true });

    return result;
  } catch (err) {
    const ms = +(now() - t0).toFixed(1);
    logger.error(
      {
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
        ms,
      },
      'Service method failed',
    );
    if (recorder && requestId) recorder.serviceCall({ requestId, service: serviceName, method: methodName, ms, ok: false });

    // Brand check, not instanceof: the thrown error may come from another copy
    // of AppError (e.g. the @taujs/server/config entry) and must keep its
    // domain status instead of being re-wrapped as a 500.
    throw AppError.isAppError(err) ? err : err instanceof Error ? AppError.internal(err.message, err) : AppError.internal('Unknown error', undefined, { err });
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
