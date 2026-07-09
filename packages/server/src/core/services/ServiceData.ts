import type { DataHandler, PathToRegExpParams } from '../config/types';
import type { JsonObject, ServiceMethodParams, ServiceRegistry } from './DataServices';

// Module-private: graph code reads via getServiceDataMetadata, never the symbol itself.
const SERVICE_DATA_METADATA = Symbol('taujs.serviceData');

export type ServiceDataMetadata = Readonly<{ serviceName: string; serviceMethod: string }>;

type ServiceDataMapper<P> = (params: PathToRegExpParams) => P;

// Mirrors RegistryCallerArgs: the mapper may be omitted only when passing the broad
// route-params object to the method is sound. Route params are
// Partial<Record<string, string | string[]>> — any key may be undefined — so specific
// param shapes must narrow through a mapper.
type ServiceDataArgs<R extends ServiceRegistry, S extends keyof R & string, M extends keyof R[S] & string> =
  PathToRegExpParams extends ServiceMethodParams<R[S][M]>
    ? [serviceName: S, serviceMethod: M, mapper?: ServiceDataMapper<ServiceMethodParams<R[S][M]>>]
    : [serviceName: S, serviceMethod: M, mapper: ServiceDataMapper<ServiceMethodParams<R[S][M]>>];

// Sugar over the service-descriptor best practice: returns an ordinary DataHandler that
// builds the descriptor at request time — dispatch stays in fetchInitialData — and stamps
// non-enumerable metadata so createRequestGraph can read the declared route → service edge
// without executing the handler.
export function createServiceData<R extends ServiceRegistry>() {
  return function serviceData<S extends keyof R & string, M extends keyof R[S] & string>(
    ...[serviceName, serviceMethod, mapper]: ServiceDataArgs<R, S, M>
  ): DataHandler<PathToRegExpParams> {
    const handler: DataHandler<PathToRegExpParams> = async (params) => ({
      serviceName,
      serviceMethod,
      args: (mapper ? mapper(params) : params) as JsonObject,
    });

    Object.defineProperty(handler, SERVICE_DATA_METADATA, {
      value: Object.freeze({ serviceName, serviceMethod }),
      enumerable: false,
    });

    return handler;
  };
}

export const getServiceDataMetadata = (handler: unknown): ServiceDataMetadata | undefined =>
  typeof handler === 'function' ? (handler as { [SERVICE_DATA_METADATA]?: ServiceDataMetadata })[SERVICE_DATA_METADATA] : undefined;
