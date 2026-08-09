---
'@taujs/vue': patch
---

docs(vue): document what the throwing deferred read does to a streamed response

`useDeferredData()` described a rejection only as reaching Vue's native error channel, and its
caveat described the client-side consequence as a hydration mismatch. On a streamed response the
outcome is different: if the read reaches its deadline after the response has begun, the response
ends before `__INITIAL_DATA__`, the deferred envelope, the bootstrap script and the terminal event
are written, so the page cannot hydrate at all.

Both the renderer reference and the `useDeferredData` JSDoc now say so, and the neighbouring
`useDeferredDataResult` JSDoc was rewritten in the same register while the file was open. Both
ship in the published declarations, so the corrections reach editor tooltips as well as the
documentation site.

No runtime, type or behavioural change: `useDeferredDataResult()` remains the read to prefer for
any entry that may fail, because it resolves to a complete, failed or aborted result and lets the
response finish normally.
