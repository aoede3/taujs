import { callServiceMethod } from '../services/DataServices';
import { AppError } from '../errors/AppError';
import { markErrorLogged } from '../errors/ErrorLogState';
import { prepareDataContext, runDataHandler } from './ResolveRouteData';

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

  return runDataHandler(
    headHandler,
    params,
    serviceRegistry,
    ctxForData,
    callServiceMethodImpl,
    'attr.head.data must return a plain object or a ServiceDescriptor',
  );
};

/**
 * Resolve `attr.data` and OWN its failure taxonomy: a handler rejection, an invalid result and a
 * service-dispatch rejection are classified alike, each producing ONE record under
 * `component: 'fetch-initial-data'`. The classified error is marked as logged UNDER `requestKey` -
 * the caller's request-context object, shared with the response terminals - so those terminals
 * convert, record and tear down without emitting a second record for the same failure in the same
 * request. Without a key the error stays unmarked and the terminal logs (fail safe).
 *
 * `prepareDataContext` sits outside the classified block: an `ensureServiceCaller` throw is route
 * wiring rather than a data failure and stays unclassified.
 */
export const fetchInitialData = async <Params extends RouteParams, R extends ServiceRegistry, L extends Logs = Logs>(
  attr: RouteAttributes<Params> | undefined,
  params: Params,
  serviceRegistry: R,
  ctx: RequestContext<L>,
  callServiceMethodImpl: CallServiceOn<R> = callServiceMethod as CallServiceOn<R>,
  requestKey?: object,
): Promise<Record<string, unknown>> => {
  const dataHandler = attr?.data;
  if (!dataHandler || typeof dataHandler !== 'function') return {};

  const ctxForData = prepareDataContext(serviceRegistry, ctx);

  try {
    return await runDataHandler(
      dataHandler,
      params,
      serviceRegistry,
      ctxForData,
      callServiceMethodImpl,
      'attr.data must return a plain object or a ServiceDescriptor',
    );
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
      // The stack belongs to the unexpected failures only - an expected 4xx stays a single terse
      // warn line.
      ...(level === 'error' ? { stack: e.stack } : {}),
    };

    // Belted: a logger that throws (or is absent) forfeits its record but must never change the
    // error the caller receives, and an error that produced no record must stay unmarked so a
    // terminal can still report it.
    try {
      if (ctx.logger) {
        ctx.logger[level](meta, e.message);
        markErrorLogged(requestKey, e);
      }
    } catch {
      // the classified error below is the response outcome, with or without a record
    }

    throw e;
  }
};
