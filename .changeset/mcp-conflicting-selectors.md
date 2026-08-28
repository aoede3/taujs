---
'@taujs/mcp': patch
---

`taujs_get_route` and `taujs_explain_route` now refuse with `reason: 'conflicting_selectors'` (plus `routeIdMatches` and `pathMatches`) when a `routeId` and `path` given together identify different routes, instead of silently preferring one. Shipped skill prompts are also checked against the registered tool and skill list, so a `taujs_`-prefixed token drifting out of sync is caught.
