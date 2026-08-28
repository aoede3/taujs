---
'@taujs/server': patch
---

`AppError.internal` call sites in the request-handling path now pass `cause` and `details` positionally instead of bundling them in an object, matching the method's real signature. These errors now carry their context on `details` and their cause on `cause`. The missing-renderSSR error's message was previously the string `'ssr'` (with the real message misrouted into the details slot) and is now `'renderSSR function not found in module'`.
