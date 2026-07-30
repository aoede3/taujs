---
'@taujs/server': minor
---

Align the public RouteContext type with the runtime value - the context is `{ appId, path, attr, params }`, exactly what renderers receive. The `data` field is removed from the type (it was never supplied at runtime; route data reaches the renderer store) and the runtime-supplied `params` is typed as `RouteParams`.

This also repairs the public aliases: `RouteContext` and `RouteData` from `@taujs/server/config` previously collapsed to `never` (optional `routes` on the broad config failed an internal array test), so neither was usable; there were no in-repository consumers of the collapsed aliases. `RouteContext` is now generic with a broad default - bare for the runtime shape, `RouteContext<typeof config>` for per-route precision - and a route without `attr` types its context `attr` as `undefined` rather than `never`. `RoutesData` and `RouteData` derive the same data unions as before from route declarations; path-specific `RouteData` lookup requires the concrete config type. Minor rather than patch because removing the declared `data` field can break downstream code typed against it, even though that field was always `undefined` at runtime.
