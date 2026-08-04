---
'@taujs/server': patch
---

Streaming no longer duplicates pre-handoff headers by re-adding them under different casing.

`reply.getHeaders()` returns lowercase keys, and the head write added `Content-Security-Policy` back under its canonical casing, which Node serialises as a separate header line. Any CSP set before the raw handoff was therefore emitted twice on a streamed response, including the one τjs's own CSP plugin sets in `onRequest`. Both lines always carried the same value, so the policy in force was unchanged, but the duplicate is invalid hygiene in a security header and hosts and proxies may flag or reject it.

The 200 and pre-head 500 paths now commit one normalised, lowercase-keyed object, so every header the reply already carried is preserved under its canonical lowercase name. Hijacking, stream timing, failure handling, deferred settlement and telemetry are untouched.
