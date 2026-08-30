---
'@taujs/server': patch
---

The caller-owned ownership boot line no longer says CSP "remains yours" outright. It now states that CSP is the caller's on the caller's responses and τjs's on the pages τjs renders, which is what the server does: when τjs CSP is active for a rendered page (a global policy, or a route declaring its own), it replaces a caller-set `content-security-policy` with its nonce-bearing policy; a route with `middleware.csp: false`, or production with no global or route policy, sets no τjs header. Caller routes and the caller's not-found responses keep the caller's header unchanged.
