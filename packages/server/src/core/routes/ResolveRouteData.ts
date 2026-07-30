import { ensureServiceCaller, isServiceDescriptor } from '../services/DataServices';
import { AppError } from '../errors/AppError';

import type { ServiceContext, ServiceRegistry } from '../services/DataServices';
import type { Logs } from '../logging/types';
import type { DataHandler, RouteParams, RequestServiceContext } from '../config/types';
import type { RequestContext } from '../telemetry/Telemetry';

/**
 * RFC 0007: the dispatch core shared by the body (`fetchInitialData`), head (`fetchHeadData`) and
 * deferred (`createDeferredData`) paths - two steps, one implementation:
 *
 *   1. `prepareDataContext` - build the request service context and install the registry caller.
 *      It runs OUTSIDE `fetchInitialData`'s try/catch: an `ensureServiceCaller` throw is route
 *      wiring, not a data failure, and stays unclassified.
 *   2. `runDataHandler` - await the handler, then AWAIT the `ServiceDescriptor` dispatch or validate
 *      a plain object, throwing `AppError.badRequest(<caller-supplied message>)` on an invalid
 *      result. Every step is awaited here, so a handler rejection, an invalid result and a
 *      service-call rejection all surface to the caller through the same channel.
 *
 * This module owns dispatch, never classification - failure POLICY belongs to each caller:
 * `fetchInitialData` classifies, logs and marks the error; `fetchHeadData` propagates it untouched
 * (its caller owns the head taxonomy); the deferred registry settles its entry whichever step
 * failed.
 */
export type CallServiceOn<R extends ServiceRegistry> = (
  registry: R,
  serviceName: string,
  methodName: string,
  params: Record<string, unknown>,
  ctx: ServiceContext,
) => Promise<Record<string, unknown>>;

export const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

export const prepareDataContext = <R extends ServiceRegistry, L extends Logs = Logs>(serviceRegistry: R, ctx: RequestContext<L>): RequestServiceContext<L> => {
  const ctxForData: RequestServiceContext<L> = {
    ...ctx,
    headers: ctx.headers ?? {},
  } as const;

  ensureServiceCaller(serviceRegistry, ctxForData as ServiceContext & Partial<{ call: typeof ctxForData.call }>);

  return ctxForData;
};

export const runDataHandler = async <Params extends RouteParams, R extends ServiceRegistry, L extends Logs = Logs>(
  handler: DataHandler<Params, L>,
  params: Params,
  serviceRegistry: R,
  ctxForData: RequestServiceContext<L>,
  callServiceMethodImpl: CallServiceOn<R>,
  invalidResultMessage: string,
): Promise<Record<string, unknown>> => {
  const result = await handler(
    params,
    ctxForData as unknown as RequestServiceContext<L> & {
      call: NonNullable<RequestServiceContext<L>['call']>;
    } & { [key: string]: unknown },
  );

  // The dispatch settles as part of THIS call, so a service-call rejection reaches the caller
  // through the same channel as a handler rejection or an invalid result.
  if (isServiceDescriptor(result)) {
    const { serviceName, serviceMethod, args } = result;

    return await callServiceMethodImpl(serviceRegistry, serviceName, serviceMethod, args ?? {}, ctxForData);
  }

  if (isPlainObject(result)) return result;

  throw AppError.badRequest(invalidResultMessage);
};
