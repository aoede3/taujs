---
'@taujs/react': patch
---

R0 recheck-2 fix: React's `renderToPipeableStream` `onError` no longer coerces the error before
reaching the crash-safe `failFatal` helper. It previously did `String((err)?.message ?? '')` at
the top of the callback, so a hostile framework error (an object with a throwing `message` getter,
or a `message` whose `Symbol.toPrimitive` throws) threw at that line BEFORE `failFatal` — skipping
`controller.fatalAbort` (no cleanup, `done` never settled) and escaping React's asynchronous
renderer callback as an uncaught exception. The raw error is now passed to the non-throwing UI
logger and routed straight to `failFatal`, so settlement/cleanup always run with the original error.
