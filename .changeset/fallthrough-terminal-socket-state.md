---
'@taujs/server': patch
---

The fallthrough (SPA shell) arm recorded `sent` when `reply.send()` returned, before the response
lifecycle had said anything, so an abandoned fallthrough page was recorded as delivered.

It now classifies at `finish` from the captured socket's state, as the SSR arm already does, and
records `aborted` on a client disconnect. Introspection consumers (`taujs_get_recent_episodes`,
`taujs_doctor`) no longer see an abandoned fallthrough as a 200.
