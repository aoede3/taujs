---
'@taujs/server': patch
---

P0A-02: `defineService` now retains the declared schema shape of each normalised method as non-enumerable metadata — `{ params, result }`, each `{ declared, kind? }` where `kind` is `'parse' | 'function'` (the only distinction `NarrowSchema` honestly reveals; never claimed as "zod"). Bare-function and schemaless entries record `{ declared: false }`. Runtime behaviour is unchanged: `runSchema` dispatch, container freezing, and method identity are all as before; the metadata is readable only via the internal `getServiceMethodMetadata()` accessor (exported from `@taujs/server/config`), so tooling can see declared param/result schemas without executing handlers.
