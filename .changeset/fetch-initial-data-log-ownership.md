---
'@taujs/server': patch
---

Logging-ownership correction and resolver simplification for route data failures. `attr.data`
failures are now classified by `fetchInitialData` whichever step failed: a service-dispatch
rejection - previously returned un-awaited, so it bypassed classification entirely - now receives
the same `component: 'fetch-initial-data'` record, severity policy and HTML-received hint as a
handler rejection. The contract is exactly one `fetch-initial-data` classification record per
failure - a single warn for expected domain, validation and auth failures, a single error carrying
a stack otherwise - with no repeated response-terminal record; service-call diagnostics (the
service layer's own 'Service method failed' record) and renderer-owned diagnostics remain
separate, intentional records. The SSR terminal and the streaming fatal line no longer repeat a
failure that was already classified and logged, while response conversion, trace recording, aborts
and teardown remain unconditional. Deduplication is keyed on error-object identity, scoped per
request through an internal marker (a mark left by one request can never suppress another
request's record), and applies where the original rejection reaches the terminal: always on the
SSR strategy, and on streaming when the renderer forwards the original object into its fatal
channel (renderer advisory channels are separate observability and unchanged). `details.logged`
is neither emitted nor honoured any more - it was application-controlled data acting as
control-plane state, letting any handler silence the terminal record. The internal resolver's thunk API (`ResolvedDataStep`,
`resolveDataHandler`) is collapsed into `runDataHandler`, the single
handler-validation-dispatch implementation behind initial, head and deferred data; `attr.head.data`
and deferred-data semantics are unchanged.
