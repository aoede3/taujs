import { callServiceMethod, ensureServiceCaller, isServiceDescriptor } from '../services/DataServices';
import { AppError } from '../errors/AppError';

import type { ServiceContext, ServiceRegistry } from '../services/DataServices';
import type { Logs } from '../logging/types';
import type { RouteAttributes, RouteParams, RequestServiceContext } from '../config/types';
import type { RequestContext } from '../telemetry/Telemetry';

type CallServiceOn<R extends ServiceRegistry> = (
  registry: R,
  serviceName: string,
  methodName: string,
  params: Record<string, unknown>,
  ctx: ServiceContext,
) => Promise<Record<string, unknown>>;

export const calculateSpecificity = (path: string): number => {
  let score = 0;
  const segments = path.split('/').filter(Boolean);

  for (const segment of segments) {
    if (segment.startsWith(':')) {
      score += 1;
      if (/[?+*]$/.test(segment)) score -= 0.5;
    } else if (segment === '*') {
      score += 0.1;
    } else {
      score += 10;
    }
  }

  score += segments.length * 0.1;

  return score;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

/**
 * RFC 0004 (H1): resolve `attr.head.data` - the same dispatch shape as `fetchInitialData`
 * (handler -> `ServiceDescriptor` ? service call : plain object), returning `undefined` when the
 * route declares no head. Deliberately NO logging or error classification here: the caller
 * (`HandleRender`'s head resolution) owns the signed abort/deadline/rejection taxonomy, so raw
 * rejections propagate untouched.
 */
export const fetchHeadData = async <Params extends RouteParams, R extends ServiceRegistry, L extends Logs = Logs>(
  attr: RouteAttributes<Params> | undefined,
  params: Params,
  serviceRegistry: R,
  ctx: RequestContext<L>,
  callServiceMethodImpl: CallServiceOn<R> = callServiceMethod as CallServiceOn<R>,
): Promise<Record<string, unknown> | undefined> => {
  const headHandler = attr?.head?.data;
  if (!headHandler || typeof headHandler !== 'function') return undefined;

  const ctxForData: RequestServiceContext<L> = {
    ...ctx,
    headers: ctx.headers ?? {},
  } as const;

  ensureServiceCaller(serviceRegistry, ctxForData as ServiceContext & Partial<{ call: typeof ctxForData.call }>);

  const result = await headHandler(
    params,
    ctxForData as unknown as RequestServiceContext<L> & {
      call: NonNullable<RequestServiceContext<L>['call']>;
    } & { [key: string]: unknown },
  );

  if (isServiceDescriptor(result)) {
    const { serviceName, serviceMethod, args } = result;

    return callServiceMethodImpl(serviceRegistry, serviceName, serviceMethod, args ?? {}, ctxForData);
  }

  if (isPlainObject(result)) return result;

  throw AppError.badRequest('attr.head.data must return a plain object or a ServiceDescriptor');
};

export const fetchInitialData = async <Params extends RouteParams, R extends ServiceRegistry, L extends Logs = Logs>(
  attr: RouteAttributes<Params> | undefined,
  params: Params,
  serviceRegistry: R,
  ctx: RequestContext<L>,
  callServiceMethodImpl: CallServiceOn<R> = callServiceMethod as CallServiceOn<R>,
): Promise<Record<string, unknown>> => {
  const dataHandler = attr?.data;
  if (!dataHandler || typeof dataHandler !== 'function') return {};

  const ctxForData: RequestServiceContext<L> = {
    ...ctx,
    headers: ctx.headers ?? {},
  } as const;

  ensureServiceCaller(serviceRegistry, ctxForData as ServiceContext & Partial<{ call: typeof ctxForData.call }>);

  try {
    const result = await dataHandler(
      params,
      ctxForData as unknown as RequestServiceContext<L> & {
        call: NonNullable<RequestServiceContext<L>['call']>;
      } & { [key: string]: unknown },
    );

    if (isServiceDescriptor(result)) {
      const { serviceName, serviceMethod, args } = result;

      return callServiceMethodImpl(serviceRegistry, serviceName, serviceMethod, args ?? {}, ctxForData);
    }

    if (isPlainObject(result)) return result;

    throw AppError.badRequest('attr.data must return a plain object or a ServiceDescriptor');
  } catch (err: unknown) {
    let e = AppError.from(err);

    const msg = String((err as any)?.message ?? '');
    const looksLikeHtml = /<!DOCTYPE/i.test(msg) || /<html/i.test(msg) || /Unexpected token <.*JSON/i.test(msg);

    if (looksLikeHtml) {
      const prevDetails = (e as any).details && typeof (e as any).details === 'object' ? (e as any).details : {};
      e = AppError.internal('attr.data expected JSON but received HTML. Likely cause: API route missing or returning HTML.', err, {
        ...prevDetails,
        hint: 'api-missing-or-content-type',
        suggestion: 'Register api route so it returns JSON, or return a ServiceDescriptor from attr.data and use the ServiceRegistry.',
        logged: true,
      });
    }
    const level: 'warn' | 'error' = e.kind === 'domain' || e.kind === 'validation' || e.kind === 'auth' ? 'warn' : 'error';

    const meta: Record<string, unknown> = {
      component: 'fetch-initial-data',
      kind: e.kind,
      httpStatus: e.httpStatus,
      ...(e.code ? { code: e.code } : {}),
      ...(e.details ? { details: e.details } : {}),
      ...(params ? { params } : {}),
      traceId: ctx.traceId,
    };

    ctx.logger?.[level](meta, e.message);

    throw e;
  }
};
