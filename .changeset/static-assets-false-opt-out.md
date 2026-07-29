---
'@taujs/server': patch
---

Honour `staticAssets: false` as a production opt-out - explicit `false` now installs no static plugin in production or development, while omitting the option keeps the default `@fastify/static` registration. Previously a falsy value was treated the same as omission and the default plugin was installed anyway, so a CDN-only deployment could not disable Fastify static serving.
