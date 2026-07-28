// Spec 03 §1 — the TraceRecorder interface, verbatim. Recorder calls are synchronous
// fire-and-forget: never awaited, and a throwing implementation must never affect a
// response (invariant 2) — call sites receive implementations wrapped by
// createSafeRecorder, which swallows exceptions and warns once per boot.

export interface TraceRecorder {
  requestStart(e: { traceId: string; url: string; method: string }): void;
  routeMatched(e: { traceId: string; path: string; appId: string; render: 'ssr' | 'streaming' }): void;
  dataFetch(e: { traceId: string; ms: number; ok: boolean }): void;
  /**
   * RFC 0007 (R5): fired exactly ONCE per declared `attr.deferred` key per request. `ms` measures
   * from registry creation to settlement or `aborted` classification. No payload, params, URL
   * values, error message or stack - the graph supplies the declared key -> service relation.
   */
  deferredData(e: { traceId: string; key: string; ms: number; outcome: 'complete' | 'failed' | 'aborted' }): void;
  serviceCall(e: { traceId: string; service: string; method: string; ms: number; ok: boolean }): void;
  streamPhase(e: { traceId: string; phase: 'head' | 'shellReady' | 'allReady' }): void;
  sent(e: { traceId: string; status: number; mode: 'ssr' | 'streaming' | 'fallthrough' }): void;
  aborted(e: { traceId: string; phase?: string }): void;
  failed(e: { traceId: string; error: { kind: string; message: string } }): void;
  clientHydration(e: { traceId: string; ok: boolean; ms?: number; error?: string }): void;
}

export const noopTraceRecorder: TraceRecorder = {
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

export const createSafeRecorder = (impl: TraceRecorder, onFirstError?: (err: unknown) => void): TraceRecorder => {
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
