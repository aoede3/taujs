---
'@taujs/server': patch
---

The `@fastify/static` dependency moves to `^10.1.5`. The 9.x line has no release that clears three published advisories (GHSA-83w8-p2f5-377r, GHSA-8pvw-jcv7-9cmj and GHSA-r799-r9gc-m956), so an application could not clear an audit by updating within it. τjs's default registration sets no route guard, no `allowedPath` and no `setHeaders`, and its behaviour is unchanged. From 10.1.4 the plugin loads a dependency that declares Node 22 or later, which is within τjs's supported Node range. An application that passes its own plugin through `staticAssets` keeps whatever version it installs. On `@fastify/static` 10 the `setHeaders` callback receives the Fastify reply (`reply.header(...)`) where 9 passed the raw response.
