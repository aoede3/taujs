---
'@taujs/react': patch
'@taujs/vue': patch
---

Debug hydration logging no longer includes the route-data payload or the store object

`hydrateApp`'s `enableDebug` logging previously emitted `Initial data loaded: <payload>` and
`Store created: <store>`. A supplied logger may forward to a server sink (for example Pino), so
those lines could disclose request data. They are removed - only lifecycle messages
(started/succeeded/failed) are logged now, aligning `@taujs/react` and `@taujs/vue` with
`@taujs/solid`, which never logged the payload.
