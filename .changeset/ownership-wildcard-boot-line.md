---
'@taujs/server': patch
---

feat(server): the ownership boot line states the terminal wildcard, and is mount-aware

Caller-owned hosts now report whether a terminal `/*` τjs page is declared and what owns the
remaining GET paths. A declared wildcard owns GET paths not claimed by a more-specific route
within the mount, including API-like and asset-like paths.

Mounted τjs-created hosts now report that their shell is confined to the mounted subtree.
Structured ownership metadata adds `mounted` and `terminalWildcard`. Routing behaviour is
unchanged.
