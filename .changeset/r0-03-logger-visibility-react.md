---
'@taujs/react': patch
---

R0-03: `enableDebug` now gates only log VERBOSITY, not error visibility. In `createUILogger`,
`warn` and `error` always route — to the provided logger if any, else `console.warn`/
`console.error`; only `log` is silenced when `enableDebug` is false.

**Behaviour change:** production consumers that did not enable debug will now see renderer
warnings and errors (data-promise rejections, stream/`onHead`/`onShellReady` callback errors,
missing root element, recoverable hydration errors) on their logger/console. This is the intended
observability fix (RFC S2), not a regression. Call sites explicitly wrapped in `if (enableDebug)`
(e.g. the CSR-fallback "no initial data" notice) remain debug-only. Note: `benignAbort`'s warning
on a client disconnect is now visible too and may be frequent under load — filter by level if
undesired.
