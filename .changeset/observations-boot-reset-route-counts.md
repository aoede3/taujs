---
'@taujs/server': minor
---

Reset the mutable introspection files at boot and attribute observed counts per route

The dev-file emitter now resets `episodes.ndjson`, `logs.ndjson` and `observations.json` when the server starts listening. Previously the poller only rewrote them on the first current-boot change, so until then the files on disk were the previous boot's - an early reader could be served old observed edges as if they were seen this boot. Previous-boot content stays legitimately readable while no boot is running (stale-mode answers cite their freshness); it is not legitimately consumed once a new boot is active (episode reads are bootId-filtered, and runtime tools refuse without an active boot), which is exactly when the reset happens - so nothing applicable is lost.

Observed edges also gain a per-route `count` (spec 03 §4 additive field, schema version unchanged): each entry in an edge's `routes` array now carries the calls attributed to that route, alongside the existing method-wide edge `count`. Route counts need not sum to the method total - a call recorded before route match increments the method total only.
