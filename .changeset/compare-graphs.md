---
'@taujs/mcp': minor
---

`@taujs/mcp` adds `taujs_compare_graphs`: a read-only tool that diffs a retained baseline request graph (a file the caller copied earlier, given as a project-relative `baselinePath`) against the currently emitted graph. It reports exact declared differences only - apps added/removed/entryPoint-changed, routes added/removed, and per-route facet changes (render, hydrate, middleware.auth, middleware.csp, data, head, deferred) - plus the global security and fallthrough blocks, keyed by `appId`/`route.id` so a reordered baseline produces byte-identical output. Metadata (`emittedAt`, `source`, `taujs.server`), `apps[].routeCount`, `routes[].specificity`, `services`, and `warnings` are never compared, and rows carry no verdicts - only what differs.
