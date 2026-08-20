---
'@taujs/mcp': patch
---

`taujs_who_calls_service` observed edges surface `routeCallCount` - the calls attributed to that specific route - alongside the method-wide `methodCallCount`, when the server emits the per-route counts added in spec 03 §4 (older emissions simply omit the field).
