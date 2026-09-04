import type { DataHandler, RouteParams, ServiceDataHandler } from '../config/types';
import type { JsonObject, ServiceMethodParams, ServiceRegistry } from './DataServices';

// Module-private: graph code reads via getServiceDataMetadata, never the symbol itself.
const SERVICE_DATA_METADATA = Symbol('taujs.serviceData');

export type ServiceDataMetadata = Readonly<{ serviceName: string; serviceMethod: string }>;

/**
 * The smallest read-only view of the request a mapper needs to translate path params (plus query
 * state and header values) into explicit service params, without exposing the capability-rich
 * loader context. The facts view does not grant the mapper τjs's request-scoped registry caller;
 * mappers should remain synchronous, side-effect-free argument translations. Both `headers` and
 * the facts object itself are fresh frozen copies, never the loader context's own objects, so
 * mutating them has no effect on the request.
 */
export type ServiceDataRequestFacts = Readonly<{ url: string; headers: Readonly<Record<string, string>> }>;

type ServiceDataMapper<P> = (params: RouteParams, facts: ServiceDataRequestFacts) => P;

// Mirrors RegistryCallerArgs: the mapper may be omitted only when passing the broad
// route-params object to the method is sound. Route params are
// Partial<Record<string, string | string[]>> — any key may be undefined — so specific
// param shapes must narrow through a mapper.
type ServiceDataArgs<R extends ServiceRegistry, S extends keyof R & string, M extends keyof R[S] & string> =
  RouteParams extends ServiceMethodParams<R[S][M]>
    ? [serviceName: S, serviceMethod: M, mapper?: ServiceDataMapper<ServiceMethodParams<R[S][M]>>]
    : [serviceName: S, serviceMethod: M, mapper: ServiceDataMapper<ServiceMethodParams<R[S][M]>>];

// Sugar over the service-descriptor best practice: returns an ordinary DataHandler that
// builds the descriptor at request time — dispatch stays in fetchInitialData — and stamps
// non-enumerable metadata so createRequestGraph can read the declared route → service edge
// without executing the handler.
// RFC 0004 (H1): the eventual result of dispatching the selected method's descriptor.
type ServiceMethodResult<F> = F extends (...args: any[]) => infer P ? Awaited<P> : never;

export function createServiceData<R extends ServiceRegistry>() {
  return function serviceData<S extends keyof R & string, M extends keyof R[S] & string>(
    ...[serviceName, serviceMethod, mapper]: ServiceDataArgs<R, S, M>
  ): ServiceDataHandler<ServiceMethodResult<R[S][M]>> {
    const handler: DataHandler<RouteParams> = async (params, ctx) => ({
      serviceName,
      serviceMethod,
      // A fresh frozen projection per call - never the loader context's own `headers` object -
      // so the mapper cannot mutate the request and the honest descriptor stays synchronous:
      // the mapper is never awaited, so a thenable return is passed through unchanged to the
      // existing descriptor validation, exactly as before.
      args: (mapper ? mapper(params, Object.freeze({ url: ctx.url, headers: Object.freeze({ ...ctx.headers }) })) : params) as JsonObject,
    });

    Object.defineProperty(handler, SERVICE_DATA_METADATA, {
      value: Object.freeze({ serviceName, serviceMethod }),
      enumerable: false,
    });

    // RFC 0004 (H1): the ONLY brand seam. The cast is type-level - no property is added; the
    // handler still returns the honest descriptor at runtime (see ServiceDataHandler's JSDoc).
    return handler as ServiceDataHandler<ServiceMethodResult<R[S][M]>>;
  };
}

export const getServiceDataMetadata = (handler: unknown): ServiceDataMetadata | undefined =>
  typeof handler === 'function' ? (handler as { [SERVICE_DATA_METADATA]?: ServiceDataMetadata })[SERVICE_DATA_METADATA] : undefined;
