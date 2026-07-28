import { callServiceMethod } from '../services/DataServices';
import { AppError } from '../errors/AppError';
import { prepareDataContext, resolveDataHandler } from './ResolveRouteData';

import type { ServiceRegistry } from '../services/DataServices';
import type { Logs } from '../logging/types';
import type { RouteAttributes, RouteParams } from '../config/types';
import type { RequestContext } from '../telemetry/Telemetry';
import type { CallServiceOn } from './ResolveRouteData';

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

  const ctxForData = prepareDataContext(serviceRegistry, ctx);

  const step = await resolveDataHandler(
    headHandler,
    params,
    serviceRegistry,
    ctxForData,
    callServiceMethodImpl,
    'attr.head.data must return a plain object or a ServiceDescriptor',
  );

  // Awaited here, exactly as before: this path has no classification block for a dispatch
  // rejection to escape, so the await placement is observably identical.
  return step.kind === 'dispatch' ? step.dispatch() : step.value;
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

  const ctxForData = prepareDataContext(serviceRegistry, ctx);

  try {
    const step = await resolveDataHandler(
      dataHandler,
      params,
      serviceRegistry,
      ctxForData,
      callServiceMethodImpl,
      'attr.data must return a plain object or a ServiceDescriptor',
    );

    // RETURNED, never `return await`ed: a service-call rejection escapes this classification block
    // exactly as it always did (only a handler rejection or an invalid result is classified here).
    return step.kind === 'dispatch' ? step.dispatch() : step.value;
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
