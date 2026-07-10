---
'@taujs/react': minor
---

P0B-04: `hydrateApp` emits internal dev-only lifecycle events (`hydration:start` / `hydration:success` / `hydration:error`) through `window.__TAUJS_DEVTOOLS_HOOK__` when the server-injected dev script has set it. User callbacks are unchanged and always run (internal emission first, user callback second); a missing or throwing hook can never affect hydration. CSR-fallback mounts deliberately emit nothing — mounting fresh is not a hydration, and the trace's `client` field stays an honest null.
