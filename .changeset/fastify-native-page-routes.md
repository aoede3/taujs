---
'@taujs/server': minor
'@taujs/mcp': patch
---

Register declared τjs page paths as native Fastify routes. Fastify now owns route syntax,
matching, decoded parameters, precedence, and router policy; τjs applies application orchestration
after selection. Exact duplicate τjs paths fail at startup, and the private `path-to-regexp`
dispatcher has been removed.

This changes existing route semantics to those of the supplied Fastify instance, including case
sensitivity, trailing-slash handling and malformed-URL policy. Replace path-to-regexp-only forms
such as optional brace groups, named wildcards and parameter `*`/`+` modifiers; τjs now rejects
known stale forms at startup rather than registering them with different semantics.

Route auth and route-level CSP now apply only to the Fastify-selected τjs route, never
incidentally to host-owned routes or unmatched case variants. Dotted values such as `logo.png`
are valid declared page-route parameters; asset-like URLs still 404 when no declared page or
static route owns them.

The MCP route explanation now labels its schema-v1 specificity value as a deterministic
declaration score, not Fastify runtime precedence. The graph schema is unchanged.
