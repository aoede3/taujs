---
'@taujs/react': patch
---

R0-01: make `renderStream().done` crash-safe by default. `createStreamController` now
pre-attaches a no-op rejection handler to its settled promise, so an unobserved `done` can
never raise `unhandledRejection` - which Node's default mode escalates to a
process-terminating `uncaughtException` - when a stream aborts fatally. Consumers who
`await done` still receive the fatal error. A child-process regression test (run under
Node's default rejection mode) proves the process no longer exits on an unobserved rejection.
