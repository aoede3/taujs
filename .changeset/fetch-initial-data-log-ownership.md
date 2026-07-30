---
'@taujs/server': patch
'@taujs/react': patch
---

Correct route-data failure ownership. `attr.data` now awaits service dispatch, so a service
rejection receives the same classification and HTML-response hint as a handler or invalid-result
failure. Data resolution classifies but does not log. The SSR and streaming response terminals emit
one `component: 'fetch-initial-data'` response record - a stackless warning for expected domain,
validation and auth failures, or an error with a stack otherwise - while HTTP conversion, trace
recording, aborts and teardown remain unconditional if logging fails. Service-call and renderer
advisory diagnostics remain separate intentional records. Application-supplied `details.logged`
no longer influences terminal logging. The internal route-data resolver is simplified to one awaited
handler-validation-dispatch path; head and deferred-data semantics are unchanged. React now
preserves the original route-data rejection through its server-side store so the streaming terminal
can retain that classified failure's ownership.
