---
'@taujs/server': minor
'@taujs/mcp': minor
---

Version-locked contract lookup (RFC 0015 Phase B V1). `@taujs/server` now ships package-owned contract assets - `contracts/index.json` plus `contracts/render-strategies.md`, describing the declared render strategies, the runtime default and the `defaulted` marker - versioned by the package itself. `@taujs/mcp` adds `taujs_find_contract`: called without an id it returns a bounded catalogue of the installed packages' contracts; called with an exact id it returns that contract's body, citation and resolution provenance, refusing with `version_mismatch` (no body) when the emitted graph and installed `@taujs/server` disagree, and `contract_unavailable` when an installed owner cannot serve its catalogue. `taujs_explain_route` and `taujs_doctor` cite the render-strategies contract on their render statements when versions align; on older or mismatched installations the citation is simply absent and every existing fact continues to flow.
