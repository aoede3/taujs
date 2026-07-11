---
'@taujs/vue': patch
---

R0-03: `enableDebug` now gates only log VERBOSITY, not error visibility (byte-identical
drift-copy of the `@taujs/react` `Logger.ts` change). `createUILogger`'s `warn` and `error`
always route — to the provided logger if any, else `console`; only `log` is silenced when
`enableDebug` is false. `createVueErrorHandler` therefore now reports Vue errors to the logger
even without debug enabled.

**Behaviour change:** production consumers that did not enable debug will now see renderer
warnings and errors (Vue errors, data-promise rejections, callback errors, missing root element,
hydration warnings) on their logger/console. This is the intended observability fix (RFC S2), not
a regression. Call sites explicitly wrapped in `if (enableDebug)` remain debug-only.
