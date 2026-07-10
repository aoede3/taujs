---
'@taujs/server': minor
---

P0A-01: add `createServiceData()` / `serviceData()` — typed sugar over the service-descriptor best practice. The returned handler is an ordinary async `DataHandler` that builds the `ServiceDescriptor` at request time (runtime dispatch through `fetchInitialData` is unchanged) and carries non-enumerable `{ serviceName, serviceMethod }` metadata readable via the internal `getServiceDataMetadata()` accessor, so tooling can see declared route → service edges without executing handlers. Exported from `@taujs/server/config` alongside `defineService`.
