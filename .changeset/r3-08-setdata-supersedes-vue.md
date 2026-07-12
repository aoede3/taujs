---
'@taujs/vue': patch
---

R3-08 (S2, twin of the react fix): an explicit `setData` now supersedes the store's in-flight
initial promise. Previously a LATE loader rejection flipped `status` to `'error'` (contradicting
the explicitly-set data in every reactive consumer, with a misleading "Failed to load initial
data" log) and a late loader resolution silently overwrote `data.value`. Both settlements are now
ignored once `setData` has run. `ready` semantics are unchanged (`setData` already resolved it).
