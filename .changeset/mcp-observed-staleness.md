---
'@taujs/mcp': patch
---

`taujs_who_calls_service` now cites `observedStaleness` (the observing boot's id and `updatedAt`) alongside the graph's own `staleness` line when observations were read outside an active boot. Observations and the graph are emitted by different events, so a T1 observation was previously being attributed to a T2 build's freshness.
