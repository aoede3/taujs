---
'@taujs/server': patch
---

`RouteData` now resolves `serviceData()` routes to the selected service method's result instead of the runtime descriptor - the `RouteDataOf` brand arm the `SERVICE_RESULT` comment always promised, mirroring `HeadDataOf`. Hand-built descriptor closures collapse to `Record<string, unknown>` (the dispatch result is untyped), plain closures are unchanged, and a route without `attr.data` resolves to the new exported `EmptyRouteData` (`Record<string, undefined>` - the honest type of the `{}` the server supplies), so a data-less route unions cleanly into an app-wide `RouteData` instead of collapsing it to `unknown`. All arms pinned by the internal and public type gates.
