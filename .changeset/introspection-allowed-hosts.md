---
'@taujs/server': minor
---

feat(server): declared host admission for the development introspection surface

Adds `introspection.allowedHosts?: string[]` (post-freeze ruling 2026-08-08 on the
introspection security model), so development behind a reverse proxy that presents a
non-localhost `Host` can admit the proxy's hostname to the `/__taujs/*` overlay endpoints
and the hydration beacon. Without a declaration the behaviour is unchanged: localhost-only.

Entries are exact DNS hostnames - no wildcards, IP literals, schemes, ports or paths - and
matching is case-insensitive, ignoring the request port; subdomains are never implied.
Invalid entries are rejected at `createServer` entry in EVERY mode, before any host state
exists, so a shared configuration cannot hide a typo in production. `localhost`,
`*.localhost` and IP-literal hosts remain admitted intrinsically.

The admission extends only the `Host` check. The remote-address guard
(`introspection.allowNonLoopback`), the per-boot token and production absence are unchanged,
and neither flag implies the other: a same-host gateway needs only `allowedHosts`, a proxy
on another machine needs both. Behind a rewriting proxy τjs sees only the declared upstream
hostname and reads no forwarding headers, so browser-facing host validation belongs to the
proxy - a non-empty declaration shouts exactly that in the boot summary, and the first
refusal of an undeclared hostname logs a warning naming the field instead of failing
silently. Declare the hostname as seen at the τjs hop: a rewriting proxy substitutes its
upstream name (behind a Platformatic gateway, `web.plt.local`, not the public host).
