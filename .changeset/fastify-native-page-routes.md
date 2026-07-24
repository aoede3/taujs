---
'@taujs/server': minor
---

Register declared τjs page paths as native Fastify routes. Fastify now owns route syntax, matching, decoded parameters, precedence, and router policy; τjs applies application orchestration after selection. Exact duplicate τjs paths fail at startup, and the private `path-to-regexp` dispatcher has been removed.
