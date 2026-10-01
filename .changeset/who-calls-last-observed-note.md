---
'@taujs/mcp': patch
---

`taujs_who_calls_service` says in its note that `lastObservedAt` on an observed row is method-wide, like `methodCallCount`: the last time any route called the method, not the last time that route did.
