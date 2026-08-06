---
'@taujs/server': minor
---

feat(server): non-root base paths - installation-level mountPrefix and publicBasePath (RFC 0012)

A taujs installation can now be mounted under a non-root prefix and addressed behind a
reverse proxy, in both proxy topologies. Two new optional fields on the config server block:

- `mountPrefix` - where Fastify RECEIVES the installation: one scope prefix under which every
  declared route (all apps), taujs static and the development introspection surface register.
- `publicBasePath` - what taujs EMITS in front of every URL it generates (asset, preload and
  CSS links, the bootstrap module URL, the dev beacon) and what the Vite base derives from,
  composed around the existing per-app entryPoint spelling. Defaults to `mountPrefix`; the
  two differ exactly when the proxy STRIPS the public prefix before forwarding
  (`mountPrefix: ''` with the public prefix declared here).

Defaults are unchanged behaviour byte-for-byte. Coordinates are validated at function entry
to a canonical form (`''` or `/segment(/segment)*`, URI-unreserved segment characters) and
rejected, never silently normalised; explicit `publicBasePath: ''` alongside a non-empty
mount is rejected as unsupported. On a taujs-created host the SPA fallback is confined to
the mounted subtree, with an ordinary 404 outside it. Caller-supplied static registrations
compose with the mount as normal Fastify nested routes; host-root static remains available
via `staticAssets: false` plus a caller registration. In development the shared Vite base
derives from `publicBasePath`, carrying module URLs and the HMR pathname; Vite's middleware
mode natively accepts both public-prefixed and proxy-stripped request paths, so taujs owns
only the base derivation and the confinement of dev delegation to the mounted subtree. HMR
socket origin and port under supervisors, and reverse-proxy host admission for the
introspection endpoints, remain separate follow-ups.
