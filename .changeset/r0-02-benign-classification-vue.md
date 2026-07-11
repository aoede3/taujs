---
'@taujs/vue': patch
---

R0-02: origin-aware benign-error classification (byte-identical drift-copy of the `@taujs/react`
`Streaming.ts` change). `isBenignStreamErr(err, source)` treats only socket/writable-origin
errors (by `code`, `AbortError` name, or exact socket message) as benign disconnects; the sink's
`destroy` path is render-origin and so is never benign by shape. Real client disconnects continue
to be handled benignly via the writable guards ('socket') and the AbortSignal.

Interim behaviour: a render-origin disconnect-lookalike now routes to the fatal path instead of
being silently dropped.
