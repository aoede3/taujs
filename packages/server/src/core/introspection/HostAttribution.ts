// RFC 0018: host-route attribution - an ambient seam for registry calls through routes τjs does
// not own. τjs observes registry-backed work performed through ordinary Fastify route handlers,
// without taking ownership of those routes. It subscribes to Fastify's own documented
// `fastify.request.handler` tracing channel (`fastify/docs/Reference/Hooks.md:887,928-929`) - a
// process-level channel Fastify already publishes for tracers, unmodified, unprivileged. τjs adds
// no hook, no decorator and no route to the caller's instance.
//
// Every seam this module adds is wrapped so a throw anywhere in it degrades to "no attribution"
// and never reaches the response (Contracts relied on): feature detection, acquisition/release,
// the transform callback, the ambient lookup, lifecycle attachment and lazy episode construction.

import { AsyncLocalStorage } from 'node:async_hooks';
import diagnostics_channel from 'node:diagnostics_channel';

import { selectedRouteFrom } from '../routes/FastifyRoutes';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logs } from '../logging/types';
import type { RequestContext } from '../telemetry/Telemetry';
import type { ServiceRegistry } from '../services/DataServices';
import type { DevIntrospection } from './DevIntrospection';
import type { EpisodeRecorder } from './EpisodeRecorder';

const CHANNEL_NAME = 'fastify.request.handler';

type AmbientStore = { request: FastifyRequest; reply: FastifyReply; route: { url: string; method: string } };

// The channel's own `:start` sub-channel is what carries `bindStore`/`unbindStore` (Node's
// `TracingChannel` wrapper itself does not) - resolved once per call rather than cached, since the
// channel registry is Node's own and this is a cheap lookup.
const startChannel = () => diagnostics_channel.tracingChannel(CHANNEL_NAME).start;

const als = new AsyncLocalStorage<AmbientStore>();

// RFC 0018 (Contracts relied on, boundary 3): the transform runs inside Fastify's own request
// path (`handle-request.js:142-152`), so a throw here is a throw inside the framework's own
// dispatch. Guarded so a fault here never reaches the response - it only ever costs attribution.
const transform = (data: object): AmbientStore | undefined => {
  try {
    const payload = data as { request: FastifyRequest; reply: FastifyReply; route: { url: string; method: string } };
    return { request: payload.request, reply: payload.reply, route: payload.route };
  } catch {
    return undefined;
  }
};

// RFC 0018 (Contracts relied on, boundary 1): checked once, lazily, at the point the first
// introspecting server acquires the binding. Node's own diagnostics_channel documentation marks
// `TracingChannel`'s `bindStore`/`unbindStore` experimental, so a Node release that changes or
// removes them must degrade to no attribution, with exactly one warning, rather than a broken boot.
const hasBindStoreFeature = (): boolean => {
  try {
    const channel = startChannel();
    return typeof channel.bindStore === 'function' && typeof channel.unbindStore === 'function';
  } catch {
    return false;
  }
};

// RFC 0018 (Lifecycle; Rulings: Shared registry ambiguity). Which registries are governed by which
// introspecting servers - an empty or absent set means no ambient recorder exists for that
// registry, and `resolveAmbient` is a no-op. `logger`/`ambiguityWarned` are diagnostics only, never
// consulted by the attribution decision itself.
const registrySets = new WeakMap<ServiceRegistry, Set<DevIntrospection>>();
const registryDiagnostics = new WeakMap<ServiceRegistry, { logger?: Logs; ambiguityWarned: boolean }>();

// RFC 0018 (Lifecycle): a module-private counter, global across every registry - `bindStore` runs
// on the 0-to-1 transition, `unbindStore` on the 1-to-0 transition, tracking whether the channel
// binding this process holds actually succeeded (so `release` never calls `unbindStore` for a bind
// that never happened).
let acquisitions = 0;
let channelBound = false;
let warnedFeatureAbsent = false;

/** Test-only: reads the module-private acquisition count, to verify a failed boot releases it. */
export const acquisitionCountForTests = (): number => acquisitions;

/**
 * RFC 0018 (Lifecycle; Contracts relied on). Idempotent per `(registry, introspection)` pair.
 * `logger` is used only for the two warnings this RFC requires (feature absence, shared-registry
 * ambiguity) - `DevIntrospection` itself exposes none, so the caller's own runtime logger is
 * threaded through here rather than inventing a second logging seam.
 */
export const acquire = (registry: ServiceRegistry, introspection: DevIntrospection, logger?: Logs): void => {
  try {
    let set = registrySets.get(registry);
    if (!set) {
      set = new Set();
      registrySets.set(registry, set);
    }
    if (set.has(introspection)) return;
    set.add(introspection);

    let diag = registryDiagnostics.get(registry);
    if (!diag) {
      diag = { ambiguityWarned: false };
      registryDiagnostics.set(registry, diag);
    }
    if (logger) diag.logger = logger;

    acquisitions += 1;
    if (acquisitions === 1) {
      if (!hasBindStoreFeature()) {
        if (!warnedFeatureAbsent) {
          warnedFeatureAbsent = true;
          logger?.warn(
            { component: 'introspection' },
            "Host-route attribution unavailable: this Node build's diagnostics_channel tracing channel does not expose bindStore/unbindStore.",
          );
        }
      } else {
        try {
          startChannel().bindStore(als, transform);
          channelBound = true;
        } catch {
          // RFC 0018 (Contracts relied on, boundary 2): a bind fault degrades to no attribution.
        }
      }
    }
  } catch {
    // no-throw boundary: acquisition must never affect boot.
  }
};

/** RFC 0018 (Lifecycle). Idempotent - releasing a pair not currently held is a no-op. */
export const release = (registry: ServiceRegistry, introspection: DevIntrospection): void => {
  try {
    const set = registrySets.get(registry);
    if (!set?.delete(introspection)) return;

    if (set.size <= 1) {
      // RFC 0018 (Rulings: Shared registry ambiguity): re-armed once the registry returns to an
      // unambiguous size, so the next time it becomes ambiguous warns again.
      const diag = registryDiagnostics.get(registry);
      if (diag) diag.ambiguityWarned = false;
    }

    acquisitions = Math.max(0, acquisitions - 1);
    if (acquisitions === 0 && channelBound) {
      channelBound = false;
      try {
        startChannel().unbindStore(als);
      } catch {
        // boundary 2
      }
    }
  } catch {
    // no-throw boundary
  }
};

// RFC 0018 (Rulings: One episode per request). Idempotency is keyed on the request object itself,
// never on requestId, so two different requests are never conflated and the same request is never
// double-opened across two ambient calls.
const openedForRequest = new WeakMap<FastifyRequest, { requestId: string; recorder: EpisodeRecorder }>();

/**
 * RFC 0018 (Host terminal contract). Attaches the finish/close terminal, opens or reuses the
 * request's host episode, and returns the ambient recorder - or `undefined` on any fault before
 * `requestStart`, which correctly means no episode at all (Opening order and cleanup).
 */
const openHostEpisode = (
  introspection: DevIntrospection,
  request: FastifyRequest,
  reply: FastifyReply,
  route: { url: string; method: string },
  requestContext: RequestContext | null | undefined,
): { requestId: string; recorder: EpisodeRecorder } | undefined => {
  // RFC 0018 (Rulings: One episode per request, case "non-τjs route matched but the context is
  // set"): the scope's own hook already claimed and started this requestId. If that claim failed,
  // `requestContext.recorder` is unset - there is nothing valid to attach to, and re-claiming here
  // would not help, since the earlier failure was already a considered refusal.
  const reusingPageHookContext = !!requestContext;
  if (reusingPageHookContext && !requestContext.recorder) return undefined;

  const recorder = introspection.recorder;
  const requestId = String(request.id);

  try {
    let finished = false;

    const terminal = (outcome: 'finish' | 'close'): void => {
      if (finished) return;
      finished = true;
      try {
        if (outcome === 'close') {
          recorder.aborted({ requestId });
          return;
        }
        const status = reply.raw.statusCode;
        if (status >= 400) recorder.failed({ requestId, status });
        else recorder.sent({ requestId, status, kind: 'host' });
      } catch {
        // createSafeRecorder already swallows recorder faults; this guard is belt-and-braces.
      }
    };

    const onFinish = () => terminal('finish');
    const onClose = () => terminal('close');

    // RFC 0018 (Opening order and cleanup): lifecycle attachment happens under one guard, BEFORE
    // any lazy episode construction - if the second listener throws, the first is removed rather
    // than left half-paired, and the coordinator ends up fully inactive.
    reply.raw.on('finish', onFinish);
    try {
      reply.raw.on('close', onClose);
    } catch {
      reply.raw.removeListener('finish', onFinish);
      return undefined;
    }

    if (!reusingPageHookContext) {
      if (!introspection.claimRequest(requestId, request)) {
        reply.raw.removeListener('finish', onFinish);
        reply.raw.removeListener('close', onClose);
        return undefined;
      }
      recorder.requestStart({ requestId, url: request.url, method: request.method });
    }

    recorder.routeMatched({ requestId, path: route.url, method: request.method, kind: 'host' });

    return { requestId, recorder };
  } catch {
    return undefined;
  }
};

/**
 * RFC 0018 (Rulings: Late lazy opening). The recorder handed back to an ambient call is not
 * `introspection.recorder` directly: `serviceCall` re-checks the response's own state again at the
 * moment it would actually fire, after the awaited method call resolves - a call whose result
 * settles after the response has since finished or closed forwards nowhere.
 */
const wrapForLateCheck = (recorder: EpisodeRecorder, reply: FastifyReply): EpisodeRecorder => ({
  ...recorder,
  serviceCall: (e) => {
    try {
      if (reply.raw.writableFinished || reply.raw.destroyed) return;
    } catch {
      return;
    }
    recorder.serviceCall(e);
  },
});

/**
 * RFC 0018 (Design step 3; Rulings). Consulted by `callServiceMethod` only when the explicit
 * `ctx.recorder` is absent. Returns `undefined` whenever attribution does not apply: the registry
 * is ungoverned, shared ambiguously, the store is absent, or the response is already done.
 */
export const resolveAmbient = (registry: ServiceRegistry): { requestId: string; recorder: EpisodeRecorder } | undefined => {
  try {
    const set = registrySets.get(registry);
    if (!set || set.size === 0) return undefined;

    if (set.size !== 1) {
      // RFC 0018 (Rulings: Shared registry ambiguity): declined while ambiguous, one warning per
      // ambiguity interval, re-armed on `release` once the registry returns to size <= 1.
      const diag = registryDiagnostics.get(registry);
      if (diag && !diag.ambiguityWarned) {
        diag.ambiguityWarned = true;
        diag.logger?.warn(
          { component: 'introspection' },
          'Host-route attribution declined: this service registry is shared by more than one introspecting server.',
        );
      }
      return undefined;
    }

    const store = als.getStore();
    if (!store?.request || !store.reply || !store.route) return undefined;

    const { request, reply, route } = store;

    // RFC 0018 (Rulings: Late lazy opening, "Before the call"): checked before any recorder is
    // selected, every ambient call, not only the one that would open the first episode.
    if (reply.raw.writableFinished || reply.raw.destroyed) return undefined;

    const [introspection] = set;
    // Read via an explicit cast rather than relying on the ambient `fastify.d.ts` module
    // augmentation being in scope: this module is reachable from files that type-check without
    // that augmentation loaded (mcp's tests import server sources directly), so the property read
    // must not depend on it.
    const requestContext = (request as { taujsRequestContext?: RequestContext | null }).taujsRequestContext;

    // RFC 0018 (Rulings: One episode per request, case "a τjs route matched"): the page owns its
    // episode and its terminal; the ambient path only ever supplies a recorder for a call this
    // context would otherwise have found empty, never a second episode or a second terminal.
    if (selectedRouteFrom(request) !== null) {
      if (!requestContext?.recorder || !requestContext.requestId) return undefined;
      return { requestId: requestContext.requestId, recorder: wrapForLateCheck(requestContext.recorder, reply) };
    }

    if (!introspection) return undefined;

    let opened = openedForRequest.get(request);
    if (!opened) {
      const result = openHostEpisode(introspection, request, reply, route, requestContext);
      if (!result) return undefined;
      opened = result;
      openedForRequest.set(request, opened);
    }

    return { requestId: opened.requestId, recorder: wrapForLateCheck(opened.recorder, reply) };
  } catch {
    return undefined;
  }
};
