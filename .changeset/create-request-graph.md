---
'@taujs/server': minor
---

P0A-03: add `createRequestGraph(config, { source, emittedAt, serviceRegistry? })` — a pure, deterministic, no-I/O serialisation of the resolved config into request-graph schema v1: apps, routes (effective render/hydrate values with `defaulted` flags, specificity, conservative auth/CSP blocks, declared `data.kind`), services with declared param/result schema kinds and `usedBy` edges when a registry is supplied (`null` otherwise), security summary, fallthrough model, and a structured warnings registry. Declared route → service edges are read via the P0A-01/P0A-02 metadata accessors — no data handler is ever executed. Exported from the package root.
