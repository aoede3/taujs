// Spec 03 §1 - the EpisodeRecorder interface, verbatim. Recorder calls are synchronous
// fire-and-forget: never awaited, and a throwing implementation must never affect a
// response (invariant 2) — call sites receive implementations wrapped by
// createSafeRecorder, which swallows exceptions and warns once per boot.

export interface EpisodeRecorder {
  requestStart(e: { requestId: string; url: string; method: string }): void;
  /**
   * RFC 0018 (Substrate): `kind` is required, with no "absent means page" default - a persisted
   * discriminant must not acquire meaning implicitly. A host route has no appId and no render
   * strategy, so both become optional; `method` is added optional and carries the request's own
   * `request.method`, never a route's declared method (RFC 0018 Limits).
   */
  routeMatched(e: { requestId: string; path: string; method?: string; appId?: string; render?: 'ssr' | 'streaming'; kind: 'page' | 'host' }): void;
  dataFetch(e: { requestId: string; ms: number; ok: boolean }): void;
  /**
   * RFC 0007 (R5): fired exactly ONCE per declared `attr.deferred` key per request. `ms` measures
   * from registry creation to settlement or `aborted` classification. No payload, params, URL
   * values, error message or stack - the graph supplies the declared key -> service relation.
   */
  deferredData(e: { requestId: string; key: string; ms: number; outcome: 'complete' | 'failed' | 'aborted' }): void;
  serviceCall(e: { requestId: string; service: string; method: string; ms: number; ok: boolean }): void;
  streamPhase(e: { requestId: string; phase: 'head' | 'shellReady' | 'allReady' }): void;
  /**
   * RFC 0018 (Host terminal contract): discriminated by `kind`. The page arm is unchanged; the host
   * arm carries no `mode` at all - a route that never renders has no render mode to invent.
   */
  sent(e: { requestId: string; status: number; mode: 'ssr' | 'streaming' | 'fallthrough' } | { requestId: string; status: number; kind: 'host' }): void;
  aborted(e: { requestId: string; phase?: string }): void;
  /**
   * RFC 0018 (Host terminal contract): `status` is the HTTP status the client received, or is
   * about to receive - never a domain classification, which stays `error.kind`. `error` is optional
   * so a host outcome with no error object still records a status; the assembler substitutes a
   * redacted placeholder when it is absent.
   */
  failed(e: { requestId: string; status: number; error?: { kind: string; message: string } }): void;
  clientHydration(e: { requestId: string; ok: boolean; ms?: number; error?: string }): void;
}

export const noopEpisodeRecorder: EpisodeRecorder = {
  requestStart() {},
  routeMatched() {},
  dataFetch() {},
  deferredData() {},
  serviceCall() {},
  streamPhase() {},
  sent() {},
  aborted() {},
  failed() {},
  clientHydration() {},
};

export const createSafeRecorder = (impl: EpisodeRecorder, onFirstError?: (err: unknown) => void): EpisodeRecorder => {
  let warned = false;

  const guard = <E>(fn: (e: E) => void): ((e: E) => void) => {
    return (e: E) => {
      try {
        fn.call(impl, e);
      } catch (err) {
        if (!warned) {
          warned = true;
          onFirstError?.(err);
        }
      }
    };
  };

  return {
    requestStart: guard(impl.requestStart),
    routeMatched: guard(impl.routeMatched),
    dataFetch: guard(impl.dataFetch),
    deferredData: guard(impl.deferredData),
    serviceCall: guard(impl.serviceCall),
    streamPhase: guard(impl.streamPhase),
    sent: guard(impl.sent),
    aborted: guard(impl.aborted),
    failed: guard(impl.failed),
    clientHydration: guard(impl.clientHydration),
  };
};
