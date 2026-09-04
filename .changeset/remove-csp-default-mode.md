---
'@taujs/server': minor
'@taujs/mcp': minor
---

`security.csp.defaultMode` never had a runtime effect: CSP mode has always been resolved per
route from that route's own `csp.mode`, never from this global option. It is removed, along with
its derived request-graph field `security.cspDefaultMode`.

Removing a required graph field is a breaking change under the frozen request-graph contract, so
the graph's `schemaVersion` moves from 1 to 2. The observations document is unaffected and stays
at schemaVersion 1.

`@taujs/mcp` now reads request graphs at schema v2 and observations documents at schema v1, and
refuses a v1 graph with an explicit upgrade message rather than misreading it. The single exported
`ADAPTER_SCHEMA_VERSION` constant is replaced by two constants, `GRAPH_SCHEMA_VERSION` and
`OBSERVATIONS_SCHEMA_VERSION`, so each document is checked against its own version. The exported
graph type `RequestGraphV1` is renamed `RequestGraphV2` to match the shape it describes.
