---
'@taujs/server': patch
'@taujs/react': patch
'@taujs/vue': patch
---

R0 gate-review fixes:

- **Server:** the streaming render `onError` is the renderer's FATAL channel and is now trusted —
  benign classification uses ACTUAL request-abort state, not the shape (`code`/`name`/exact
  message) of an application-controlled error. This closes an origin-blind reclassification at the
  renderer/server join: a render/data failure that happens to look like a disconnect (e.g.
  `code: 'EPIPE'`, `name: 'AbortError'`, or the exact message `"aborted"`) now enters the failure
  path and is recorded, instead of being silently treated as a client disconnect.
- **Renderers** (`@taujs/react` upstream, `@taujs/vue` byte-identical drift-copy): the shared UI
  logger is now NON-THROWING — formatting arbitrary `unknown` values (`BigInt`, circular objects,
  symbols, a throwing `toJSON`/`Symbol.toPrimitive`) and calls to a user-provided logger method are
  isolated, so a diagnostic on an error path can never break control flow. The stream controller
  additionally cleans up and settles `done` even if its logger throws. Together these make R0-03's
  always-on `warn`/`error` safe for arbitrary thrown values.
