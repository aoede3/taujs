---
'@taujs/server': minor
---

Route data loaders now receive the request URL: `ctx.url` carries Fastify's request target as received (path plus query string, for example `/products?sort=price`), beside `ctx.headers`. Routes whose state lives in the query string (sort, filters, cursors, search terms, variant selection) can read it from the loader context instead of a host-owned request scope. The value is the raw request target, not an origin and not a parsed `URL`; the loader parses what it needs. Additive: `RequestContext` gains one required field.
