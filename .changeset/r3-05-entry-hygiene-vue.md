---
'@taujs/vue': patch
---

R3-05 (Q6): the dist now preserves the source module graph (explicit `.js` specifiers + unbundled
build), matching `@taujs/react`. For vue this is structural hardening, not a defect fix - client
bundles already tree-shook `@vue/server-renderer` to ~0 bytes; the unbundled graph removes the
latent dependence on that build staying tree-shakeable. A module-graph guard test now pins the
absence (builds a real production browser bundle of the client entry and asserts zero rendered
`@vue/server-renderer` bytes), plus a specifier-extension lint test. No API change.
