---
'@taujs/server': minor
---

P0B-02: `TraceRecorder` interface (no-op default) with a dev-only ring-buffer assembler behind the structural gate. Rendered, fallthrough, failed, and aborted requests each assemble a trace record (200-trace ring) with URL hygiene — pathname + surviving query key names only, denylisted keys dropped entirely, values never stored. The request child logger is teed into a logs annex (2000-record ring, debug excluded, redaction-filtered meta), and observed service edges accumulate into an observations document (shapes deferred — the `serviceCall` event deliberately never carries result data). Recorder calls are synchronous fire-and-forget and safety-wrapped: a throwing recorder implementation warns once and never affects a response.
