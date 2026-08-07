---
'@taujs/server': patch
---

fix(server): SSR episodes classify from the response lifecycle - `finish` on a healthy socket
records `complete`, `finish` on a socket already destroyed or errored records `aborted`, a close
before any terminal records `aborted` at the current stage, and a mid-delivery disconnect now logs
a warning. Previously `sent` was recorded when `reply.send()` returned, so a partially delivered
SSR response was recorded as a successful 200 with no disconnect log. Detection covers socket
failure observed by the time `finish` runs; a failure the server never observes is not claimed.
