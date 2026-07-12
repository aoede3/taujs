---
'@taujs/react': patch
---

R3-08 (S2): an explicit `setData` now supersedes the store's in-flight initial promise. Previously
a LATE loader rejection flipped the store to `'error'`, made `getSnapshot` throw, and tore down a
tree already committed with the explicitly-set data (uncaught render error, DOM wiped); a late
loader resolution silently overwrote the explicit value. Both settlements are now ignored once
`setData` has run. Unreachable via taujs's own paths (`hydrateApp` builds the store from resolved
data) - this hardens the public `createSSRStore`. The internal readiness promise still settles
when the loader does, so the streaming end-gate is unaffected (pinned by test).
