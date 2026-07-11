---
'@taujs/server': patch
---

R1-01: add the additive `onRenderError` render-error contract and propagate the request
`AbortSignal` into route data resolution.

- **`RenderErrorInfo` + `onRenderError`** are added to the exported `RenderCallbacks` contract. This
  is the advisory, NON-FATAL structured render-error channel (notably for post-shell boundary errors
  the renderer recovers client-side). The server wires it to the request logger at `warn` with a
  message keyed on `recoverable` (`phase`/`recoverable`/`clientRoot`/`url` as structured fields), so a
  recoverable render error is surfaced without being escalated to a fatal response and without
  double-logging a pre-shell error at `error` level (the fatal channel owns that). Callback-policy
  JSDoc documents which callbacks are fatal vs advisory.
- **AbortSignal into data context.** The request `AbortController.signal` is now threaded into the
  data-resolution context for both the SSR and streaming branches, so loaders can observe client
  disconnects. Non-throwing error formatting on the logging path is preserved.

`onRenderError` is OPTIONAL and non-breaking in either direction (unlike R0-01's `RenderStream`
return-type change), so existing `RenderCallbacks` users are unaffected — `patch` per the R1-01
changeset plan, keeping `@taujs/server` below 1.0.0.
