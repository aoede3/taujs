---
'@taujs/create-taujs': minor
---

Generated projects now demonstrate the derived type chain from `taujs.config.ts` through the renderer to the store. A type-only `src/client/app-types.ts` exports `AppRouteContext = RouteContext<typeof config>` and `AppData = RouteData<typeof config>`; the generated config declares registry-typed `serviceData()` edges instead of a hand-built descriptor; `createRenderer` receives `<AppData, AppRouteContext>` in all three frameworks; and every hand-written payload type is replaced by the derived `AppData`. The lifecycle gate typechecks a generated project end to end against packed tarballs.
