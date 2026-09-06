---
'@taujs/server': minor
---

Host-route attribution (RFC 0018): in development, τjs observes registry-backed work performed through ordinary Fastify route handlers, without taking ownership of those routes. When a handler outside τjs's own routes calls the service registry through `callServiceMethod` with no explicit recorder, the call is correlated to a host-observed episode carrying the route's method and path, the registry calls made in it, and the response outcome - opened only once the registry is called, and never touching the route, its transport or its error handling.

`EpisodeRecorder.routeMatched` gains a required `kind: 'page' | 'host'` and an optional `method`; `appId` and `render` become optional, since a host route has neither. `sent` is discriminated by `kind`, and `failed` now carries the response `status` alongside its optional `error`. The observations schema moves to version 2 for these additions.

Nothing changes for an application that never calls a Fastify route outside τjs's own: page episodes, their identities and `observations.json`'s edge shapes are unaffected beyond the schema-version bump. Production behaviour is unchanged - nothing binds unless introspection is already active in development.
