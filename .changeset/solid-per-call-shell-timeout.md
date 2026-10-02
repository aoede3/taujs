---
'@taujs/solid': minor
---

`renderStream` accepts a per-call `shellTimeoutMs` in its final `opts` argument, overriding the factory value for that call. It accepts the same values as the factory option and rejects anything else with the same message, named for the `renderStream` site, before any timer is armed. The option is stream-only: `renderSSR` is unaffected, and `completionTimeoutMs` and `deferredTimeoutMs` remain factory-only.
