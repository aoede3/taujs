---
'@taujs/server': patch
---

R0-02: origin-aware benign-error classification in `HandleRender`. Replaces the broad
`REGEX.BENIGN_NET_ERR` substring match (now removed) with a strict socket taxonomy — disconnect
`code`, `AbortError` name, or exact node/undici socket message.

Fixes a hung-request hole: a `renderSSR` failure is render-origin, so it is benign only when the
request was actually aborted. A disconnect-shaped render error on a live request previously
returned silently without sending a response (hanging the request); it now produces a real 500.
Socket-origin paths (send failure, PassThrough/HTTP socket errors, stream `onError`) use the same
strict socket check, so an application error whose message merely contains "aborted"/"premature"
is no longer mistaken for a client disconnect.
