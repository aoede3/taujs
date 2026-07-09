---
'@taujs/server': minor
---

P0B-03: dev introspection files, overlay endpoints, and the `introspection` config surface. Dev boot now writes `node_modules/.taujs/dev.json` (bootId, per-boot token, pid, actual bound socket, artifact paths — removed on graceful close) and mirrors the in-memory rings to `traces.ndjson` / `logs.ndjson` / `observations.json` with atomic non-fatal writes. `/__taujs/graph|observations|traces` (plain + SSE) and `POST /__taujs/beacon` are registered only inside the structural dev gate, each enforcing loopback remote-address → Host validation (DNS-rebinding safe) → per-boot token, in that order. New public config: `introspection.allowNonLoopback` (relaxes only the remote-address check and shouts in the boot summary) and `introspection.redaction.denyKeys`/`replaceDefaultDenyKeys`.
