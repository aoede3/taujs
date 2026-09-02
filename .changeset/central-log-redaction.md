---
'@taujs/server': minor
---

Central log redaction: the logger now applies the shared sensitive-key denylist (password, token, secret, ssn, auth, cookie, session, key - case-insensitive substring on key names, whole subtree dropped) to all log metadata before any sink, custom or console - including the bindings handed to a custom logger's child() seam. Service failure logs no longer include parameter values; they carry the service, method, duration and failure class. The development introspection annex and the logger now share one denylist source.

Redaction is fail-closed and total: denied keys are rejected before their values are read (a denied getter never executes), a permitted getter that throws yields an [unreadable] marker, an object whose keys cannot be enumerated yields [unredactable], and generous depth/node/array budgets replace over-budget subtrees with markers - metadata is never passed through unredacted. Errors are projected with name/message/stack intact and their enumerable properties redacted; Dates are rebuilt without expando properties; other class instances are projected through the same walk.
