---
"@taujs/react": patch
---

Mark the `onFinish` render callback as `@deprecated` in its JSDoc (it is a legacy alias of
`onAllReady`); use `onAllReady` instead. Documentation-only; no behaviour change.
