---
'@taujs/react': patch
---

R0-02: classify benign stream errors by ORIGIN, not by message substring. `isBenignStreamErr`
now takes a `source: 'socket' | 'render'`. Only socket/writable-origin errors — by `err.code`
(`ECONNRESET`, `EPIPE`, `ERR_STREAM_PREMATURE_CLOSE`, `ERR_STREAM_DESTROYED`), an `AbortError`
name, or an exact node/undici socket message — are treated as benign client disconnects;
render-origin errors are never benign by shape. An application error whose message merely
contains "aborted"/"premature" (or carries a spoofed `code`) is no longer swallowed as a
disconnect. The `DEFAULT_BENIGN_ERRORS` regex and `wireWritableGuards`' `benignErrorPattern`
option are retired.

Interim behaviour: a render-origin disconnect-lookalike now routes to the error path (fatal
until the R1-01 streaming rework makes post-shell errors log-only) instead of being silently
dropped — an observable error beats silent data loss.
