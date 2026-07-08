---
'@taujs/create-taujs': patch
---

Remove `@changesets/cli` from runtime dependencies. It was never imported, so every `npx @taujs/create-taujs` was downloading the entire changesets toolchain for nothing. Releases continue to use the copy provided by the workspace root.
