import { ensureServiceCaller, isServiceDescriptor } from '../services/DataServices';
import { AppError } from '../errors/AppError';

import type { ServiceContext, ServiceRegistry } from '../services/DataServices';
import type { Logs } from '../logging/types';
import type { DataHandler, RouteParams, RequestServiceContext } from '../config/types';
import type { RequestContext } from '../telemetry/Telemetry';

/**
 * RFC 0007: the dispatch core shared by the body (`fetchInitialData`), head (`fetchHeadData`) and
 * deferred (`createDeferredData`) paths.
 *
 * The extraction is DELIBERATELY narrow. `fetchInitialData` owns error classification + logging and
 * `fetchHeadData` deliberately owns none (its caller owns the head taxonomy), so only the steps both
 * already performed identically move here:
 *
 *   1. `prepareDataContext` - build the request service context and install the registry caller.
 *      This ran OUTSIDE `fetchInitialData`'s try/catch and must keep running outside it: an
 *      `ensureServiceCaller` throw was never classified/logged and must stay unclassified.
 *   2. `resolveDataHandler` - handler -> `ServiceDescriptor` ? service call : plain-object
 *      validation, throwing `AppError.badRequest(<caller-supplied message>)` on an invalid result.
 *
 * `resolveDataHandler` returns the service dispatch as an UNINVOKED thunk rather than awaiting it,
 * because `fetchInitialData` deliberately `return`ed (never `return await`ed) the dispatch promise
 * from inside its try/catch: a service-call rejection therefore ESCAPED its classification/logging
 * block, while a handler rejection or an invalid-result throw did not. Awaiting inside the shared
 * helper would silently start classifying service-call failures under
 * `component: 'fetch-initial-data'`. The thunk keeps that split exactly where it was, so both
 * existing call sites keep byte-identical observable behaviour.
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

export type ResolvedDataStep = { kind: 'value'; value: Record<string, unknown> } | { kind: 'dispatch'; dispatch: () => Promise<Record<string, unknown>> };

export const resolveDataHandler = async <Params extends RouteParams, R extends ServiceRegistry, L extends Logs = Logs>(
  handler: DataHandler<Params, L>,
  params: Params,
  serviceRegistry: R,
  ctxForData: RequestServiceContext<L>,
  callServiceMethodImpl: CallServiceOn<R>,
  invalidResultMessage: string,
): Promise<ResolvedDataStep> => {
  const result = await handler(
    params,
    ctxForData as unknown as RequestServiceContext<L> & {
      call: NonNullable<RequestServiceContext<L>['call']>;
    } & { [key: string]: unknown },
  );

  if (isServiceDescriptor(result)) {
    const { serviceName, serviceMethod, args } = result;

    return { kind: 'dispatch', dispatch: () => callServiceMethodImpl(serviceRegistry, serviceName, serviceMethod, args ?? {}, ctxForData) };
  }

  if (isPlainObject(result)) return { kind: 'value', value: result };

  throw AppError.badRequest(invalidResultMessage);
};

/**
 * Await-everything convenience over {@link resolveDataHandler}, for callers with no
 * classification-boundary subtlety to preserve: RFC 0007's deferred registry settles its entry the
 * same way whichever step failed.
 */
export const runDataHandler = async <Params extends RouteParams, R extends ServiceRegistry, L extends Logs = Logs>(
  handler: DataHandler<Params, L>,
  params: Params,
  serviceRegistry: R,
  ctxForData: RequestServiceContext<L>,
  callServiceMethodImpl: CallServiceOn<R>,
  invalidResultMessage: string,
): Promise<Record<string, unknown>> => {
  const step = await resolveDataHandler(handler, params, serviceRegistry, ctxForData, callServiceMethodImpl, invalidResultMessage);

  return step.kind === 'dispatch' ? step.dispatch() : step.value;
};
