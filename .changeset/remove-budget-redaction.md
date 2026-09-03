---
'@taujs/server': minor
---

Remove `server.requestBudgetMs`, `ctx.budget`, the `RequestBudget` type, and the logger's runtime metadata redaction - these exceeded what τjs should own and are retracted with no deprecation period.

What remains true: service failure logs never include the parameter object; development introspection redacts what it persists (its own denylist, unchanged); applications configure their own production logger/sink redaction; `ctx.signal` and `withDeadline()` are the cancellation/deadline surface.

A route policy requiring the removed `taujs.request-budget-configured` evidence name now fails configuration validation as an unknown name. `server.requestBudgetMs` is no longer declared or read by τjs; if supplied through an extended or untyped configuration, it is ignored.
