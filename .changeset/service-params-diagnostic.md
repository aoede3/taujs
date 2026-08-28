---
'@taujs/server': patch
---

Previously a service method whose params were typed with an `interface` (no index signature) normalised to `never`, so the definition compiled clean and every call site reported an opaque error instead. `defineService()` now rejects such a method at the definition, on the offending property, with a message naming the cause. The JSDoc on `ServiceMethod` and `defineService` ships in the types.
