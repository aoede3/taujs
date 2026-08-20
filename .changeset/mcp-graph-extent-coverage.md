---
'@taujs/mcp': minor
---

State the graph's extent and declared coverage; distinguish empty results from unknown identifiers

`taujs_overview` now states the graph's boundary in a `scope` field (routes registered directly on the Fastify instance, and service calls made outside taujs request handling, are not represented), reports per-service declared-edge coverage (`methodCount` and `withDeclaredEdges`, deferred entries included), exposes `episodesAvailable` with the refusal remedy when episode tools are gated, and renames `warningCounts` to `graphWarningCounts` so the counts read as graph-scoped rather than as application health.

`taujs_who_calls_service` declared edges now include deferred entries (RFC 0007 R5 parity with the graph's own `usedBy`), each labelled `declaredVia: 'serviceData' | 'deferred'`. A known service or method with zero edges now returns `ok: true` with empty `edges` instead of the `no_edges` error - `ok: false` is reserved for identifiers that do not resolve (`unknown_service`, `unknown_method`). When the registry is not present in the graph the response says existence cannot be checked instead of guessing. `taujs_doctor` phrases a clean verdict as "No taujs graph warnings", scoped to the declared graph.
