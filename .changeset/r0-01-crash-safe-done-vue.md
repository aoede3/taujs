---
'@taujs/vue': patch
---

R0-01: make `renderStream().done` crash-safe by default - a byte-identical drift-copy of the
`@taujs/react` fix (`utils/Streaming.ts` is kept in sync by the drift guard).
`createStreamController` pre-attaches a no-op rejection handler so an unobserved `done` can
never crash the process (via `unhandledRejection` → `uncaughtException`) when a stream aborts
fatally; consumers who `await done` still receive the error. Mirrored child-process regression
test included.
